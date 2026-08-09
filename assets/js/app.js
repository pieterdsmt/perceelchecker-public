// ════════════════════════════════════════════════════
// PROJ4 — Belgian Lambert72 (EPSG:31370)
// ════════════════════════════════════════════════════
proj4.defs('EPSG:31370',
  '+proj=lcc +lat_1=49.83333333333334 +lat_2=51.16666666666666 ' +
  '+lat_0=90 +lon_0=4.367486666666666 +x_0=150000.013 +y_0=5400088.438 ' +
  '+ellps=intl +towgs84=-106.869,52.2978,-103.724,0.3366,-0.457,1.8422,-1.2747 ' +
  '+units=m +no_defs');
proj4.defs('EPSG:3812',
  '+proj=lcc +lat_0=50.797815 +lon_0=4.35921583333333 +lat_1=49.8333339 +lat_2=51.1666673333333 ' +
  '+x_0=649328 +y_0=665262 +ellps=GRS80 +units=m +no_defs');

const toL72  = (lon, lat) => proj4('EPSG:4326', 'EPSG:31370', [lon, lat]);
const fromL72 = (x, y)   => proj4('EPSG:31370', 'EPSG:4326', [x, y]);
const fromL08 = (x, y)   => proj4('EPSG:3812', 'EPSG:4326', [x, y]);

// Detect if coordinate looks like Lambert72 (x > 1000)
const isLambert72 = coords => Math.abs(coords[0]) > 1000;

const PUBLIC_MODE = true;
const dossierDatasetUrl = 'assets/data/opmeetdossiers.json?v=20260809-capakey';
const DOSSIER_RADIUS_M = 150;
let dossierIndexPromise = null;
let dossierGeocodeCache = new Map();
const ENABLE_DOSSIER_LIVE_GEOCODE = true;
const MAX_DOSSIER_GEOCODE_PER_SEARCH = 8;

function proxyUrl(service, pathAndQuery) {
  return `/api/proxy/${service}/${pathAndQuery}`;
}

async function geocodeWithNominatim(query, limit = 1) {
  const res = await fetch(
    proxyUrl('nominatim', `search?q=${encodeURIComponent(query)}&format=json&countrycodes=be&limit=${limit}&addressdetails=1`),
    { signal: AbortSignal.timeout(12000) }
  );
  if (res.status === 429) {
    const err = new Error('Nominatim rate limited (429)');
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`Nominatim fout (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function geocodeWithPhoton(query, limit = 1) {
  const cleanQ = String(query || '').trim();
  const res = await fetch(
    proxyUrl('photon', `api?q=${encodeURIComponent(cleanQ)}&limit=${limit}`),
    { signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) {
    const err = new Error(`Photon fout (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const payload = await res.json();
  const features = Array.isArray(payload?.features) ? payload.features : [];
  return features
    .filter(f => {
      const cc = String(f?.properties?.countrycode || '').toLowerCase();
      const country = normalizeText(f?.properties?.country || '');
      return cc === 'be' || country.includes('belgie') || country.includes('belgium');
    })
    .map(f => {
      const coords = Array.isArray(f?.geometry?.coordinates) ? f.geometry.coordinates : [];
      const rawLon = coords[0];
      const rawLat = coords[1];
      const p = f?.properties || {};
      const label = [
        [p.housenumber, p.street].filter(Boolean).join(' '),
        p.postcode,
        p.city || p.locality || p.district,
        p.state
      ].filter(Boolean).join(', ');
      return {
        lon: Number(rawLon),
        lat: Number(rawLat),
        display_name: label || `${p.name || query}`,
        address: {
          road: p.street || null,
          house_number: p.housenumber || null,
          state: p.state || null,
          province: p.state || null,
          municipality: p.city || p.locality || p.district || null,
          town: p.city || null,
          city: p.city || null,
          village: p.locality || null,
          hamlet: p.district || null,
        }
      };
    })
    .filter(h => Number.isFinite(h.lon) && Number.isFinite(h.lat) && h.lon >= 2 && h.lon <= 7 && h.lat >= 49 && h.lat <= 52);
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitAddressParts(value) {
  const text = normalizeText(value);
  return text ? text.split(/\s+/).filter(Boolean) : [];
}

function buildLocationKey(gemeente, straatHuisnr) {
  return `${normalizeText(gemeente)}|${normalizeText(straatHuisnr)}`;
}

function buildDossierGeocodeQueries(record) {
  const gemeente = String(record?.gemeente || '').trim();
  const straatRaw = String(record?.straatHuisnr || '').trim();
  if (!gemeente || !straatRaw) return [];

  const variants = [];
  variants.push(straatRaw);

  const noParen = straatRaw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (noParen) variants.push(noParen);

  const normalizedSeparators = noParen.replace(/[\/-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalizedSeparators) variants.push(normalizedSeparators);

  const firstHouseNrMatch = normalizedSeparators.match(/^(.+?)\s+(\d+[a-zA-Z]?).*$/);
  if (firstHouseNrMatch) {
    const street = firstHouseNrMatch[1].trim();
    const houseNr = firstHouseNrMatch[2].trim();
    if (street && houseNr) variants.push(`${street} ${houseNr}`);
  }

  const unique = [];
  const seen = new Set();
  for (const v of variants) {
    const key = normalizeText(v);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(`${v}, ${gemeente}, Belgie`);
  }
  return unique.slice(0, 4);
}

async function loadDossierIndex() {
  if (!dossierIndexPromise) {
    dossierIndexPromise = fetch(dossierDatasetUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
      .then(res => {
        if (!res.ok) throw new Error(`Dossierdataset niet geladen (${res.status})`);
        return res.json();
      })
      .then(data => data?.records || []);
  }
  return dossierIndexPromise;
}

function isRelevantDossier(record) {
  const type = normalizeText(record?.typeOpdracht || '');
  return type.includes('opmet') || type.includes('uitzet') || type.includes('grens') || type.includes('afpal') || type.includes('precad') || type.includes('splits') || type.includes('rooilijn') || type.includes('verkavel') || type.includes('as built') || type.includes('asbuilt') || ['o', 'u', 'o/u', 'o & u', 'o & s', 'p/u', 'vkw', 'vk', 'vk wijziging', 'verkaveling', 'verkavelingswijziging', 'bijstelling van een verkaveling', 'industriele vk'].includes(type);
}

function inferLocationKeywords(parcel) {
  const parts = [];
  if (parcel?.addressLabel) parts.push(parcel.addressLabel);
  if (parcel?.province) parts.push(parcel.province);
  if (parcel?.centerLabel) parts.push(parcel.centerLabel);
  return splitAddressParts(parts.join(' '));
}

async function resolveDossierLocation(record) {
  const cacheKey = buildLocationKey(record?.gemeente, record?.straatHuisnr);
  if (!cacheKey || dossierGeocodeCache.has(cacheKey)) {
    return dossierGeocodeCache.get(cacheKey) || null;
  }

  const queries = buildDossierGeocodeQueries(record);
  if (!queries.length) {
    dossierGeocodeCache.set(cacheKey, null);
    return null;
  }

  try {
    let hit = null;
    for (const query of queries) {
      try {
        const nom = await geocodeWithNominatim(query, 1);
        hit = nom?.[0] || null;
        if (!hit) {
          const pho = await geocodeWithPhoton(query, 1);
          hit = pho?.[0] || null;
        }
      } catch (err) {
        if (err?.status === 429) {
          const pho = await geocodeWithPhoton(query, 1);
          hit = pho?.[0] || null;
        }
      }
      if (hit) break;
    }

    const resolved = hit ? {
      lon: Number(hit.lon),
      lat: Number(hit.lat),
      displayName: hit.display_name || '',
    } : null;
    if (!resolved || !Number.isFinite(resolved.lon) || !Number.isFinite(resolved.lat) || resolved.lon < 2 || resolved.lon > 7 || resolved.lat < 49 || resolved.lat > 52) {
      dossierGeocodeCache.set(cacheKey, null);
      return null;
    }
    dossierGeocodeCache.set(cacheKey, resolved);
    return resolved;
  } catch {
    dossierGeocodeCache.set(cacheKey, null);
    return null;
  }
}

function scoreDossierNearParcel(record, parcel, locationKeywords = []) {
  const gemeente = normalizeText(record?.gemeente);
  const straat = normalizeText(record?.straatHuisnr);
  const title = normalizeText(record?.titel);
  const type = normalizeText(record?.typeOpdracht);
  const parcelMunicipality = normalizeText(parcel?.municipality);
  const parcelStreet = normalizeText(parcel?.streetName || (parcel?.addressLabel || parcel?.centerLabel || '').split(',')[0] || '');
  let score = 0;

  if (parcelMunicipality) {
    if (!gemeente || gemeente !== parcelMunicipality) return -1;
    score += 70;
  }
  if (parcelStreet && straat) {
    if (straat === parcelStreet) score += 28;
    else if (straat.includes(parcelStreet) || parcelStreet.includes(straat)) score += 18;
    else {
      const streetTokens = splitAddressParts(straat);
      const parcelTokens = splitAddressParts(parcelStreet);
      const overlap = streetTokens.filter(token => token.length > 2 && parcelTokens.includes(token)).length;
      score += Math.min(12, overlap * 4);
    }
  }
  if (locationKeywords.length) {
    const text = `${gemeente} ${straat} ${title}`;
    for (const kw of locationKeywords) {
      if (kw.length > 3 && text.includes(kw)) score += 3;
    }
  }
  if (type.includes('opmet')) score += 8;
  if (type.includes('grens') || type.includes('afpal')) score += 4;
  if (type.includes('verkavel') || type.includes('splits')) score += 4;
  if (record?.lon != null && record?.lat != null && parcel?.center) {
    const d = haversineKm(parcel.center[0], parcel.center[1], Number(record.lon), Number(record.lat));
    if (Number.isFinite(d)) {
      score += Math.max(0, 25 - Math.min(d * 6, 25));
    }
  }
  return score;
}

function getDossierDistanceKm(record, parcel) {
  if (!parcel?.center || !parcel?.bboxL72) return null;
  const hasParcelCenter = record?.parcelX !== null && record?.parcelX !== undefined && record?.parcelX !== ''
    && record?.parcelY !== null && record?.parcelY !== undefined && record?.parcelY !== ''
    && Number.isFinite(Number(record.parcelX)) && Number.isFinite(Number(record.parcelY));
  if (hasParcelCenter) {
    let point = [Number(record.parcelX), Number(record.parcelY)];
    if (record.parcelCrs === 'EPSG:3812') point = proj4('EPSG:3812', 'EPSG:31370', point);
    const parcelCenter = [
      (parcel.bboxL72[0] + parcel.bboxL72[2]) / 2,
      (parcel.bboxL72[1] + parcel.bboxL72[3]) / 2
    ];
    return Math.hypot(point[0] - parcelCenter[0], point[1] - parcelCenter[1]) / 1000;
  }
  const hasCoordinates = record?.lon !== null && record?.lon !== undefined && record?.lon !== ''
    && record?.lat !== null && record?.lat !== undefined && record?.lat !== ''
    && Number.isFinite(Number(record.lon)) && Number.isFinite(Number(record.lat));
  if (hasCoordinates) {
    return haversineKm(parcel.center[0], parcel.center[1], Number(record.lon), Number(record.lat));
  }
  return null;
}

function getAddressFallback(record, parcel) {
  const municipality = normalizeText(record?.gemeente);
  const parcelMunicipality = normalizeText(parcel?.municipality);
  const street = normalizeText(record?.straat || record?.normalizedStreetName);
  const parcelStreet = normalizeText(parcel?.streetName);
  if (!municipality || municipality !== parcelMunicipality || !street || street !== parcelStreet) return null;

  const dossierHouseNumber = normalizeText(record?.huisnummer);
  const parcelHouseNumber = normalizeText(parcel?.houseNumber);
  const exactHouseNumber = dossierHouseNumber && parcelHouseNumber && dossierHouseNumber === parcelHouseNumber;
  return {
    confidence: exactHouseNumber ? 'hoog' : 'beperkt',
    rank: exactHouseNumber ? 2 : 1,
    label: exactHouseNumber ? 'zelfde straat en huisnummer' : 'zelfde gemeente en straat'
  };
}

async function findNearbyDossiers(parcel, limit = 12) {
  const records = await loadDossierIndex();
  const locationKeywords = inferLocationKeywords(parcel);
  const candidates = records
    .filter(isRelevantDossier)
    .map(record => {
      const distanceKm = getDossierDistanceKm(record, parcel);
      const addressFallback = Number.isFinite(distanceKm) ? null : getAddressFallback(record, parcel);
      return { ...record, distanceKm, addressFallback, score: scoreDossierNearParcel(record, parcel, locationKeywords) };
    })
    .filter(record =>
      (Number.isFinite(record.distanceKm) && record.distanceKm * 1000 <= DOSSIER_RADIUS_M)
      || record.addressFallback
    );

  candidates.sort((a, b) => {
    const distA = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.POSITIVE_INFINITY;
    const distB = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.POSITIVE_INFINITY;
    if (distA !== distB) return distA - distB;
    const fallbackDiff = (b.addressFallback?.rank || 0) - (a.addressFallback?.rank || 0);
    if (fallbackDiff) return fallbackDiff;
    const scoreDiff = b.score - a.score;
    if (scoreDiff) return scoreDiff;
    return String(a.dossierNr).localeCompare(String(b.dossierNr));
  });

  const shown = candidates.slice(0, limit);
  shown.totalCandidates = candidates.length;
  shown.totalWithDistance = candidates.filter(record => Number.isFinite(record.distanceKm)).length;
  shown.totalAddressFallback = candidates.filter(record => record.addressFallback).length;
  return shown;
}

// ════════════════════════════════════════════════════
// LEAFLET MAP
// ════════════════════════════════════════════════════
const map = L.map('map', { zoomControl: true }).setView([51.0, 3.8], 9);
map.createPane('wmsOverlayPane');
map.getPane('wmsOverlayPane').style.zIndex = 430;
map.createPane('dataOverlayPane');
map.getPane('dataOverlayPane').style.zIndex = 460;
map.createPane('parcelOverlayPane');
map.getPane('parcelOverlayPane').style.zIndex = 470;

const baseOSM = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors', maxZoom: 22
});
const baseOrtho = L.tileLayer.wms('https://geo.api.vlaanderen.be/OMWRGBMRVL/wms', {
  layers: 'Ortho', format: 'image/png', transparent: false, maxZoom: 22,
  attribution: '© Digitaal Vlaanderen — Orthofoto'
});
const baseGRB = L.tileLayer.wms('https://geo.api.vlaanderen.be/GRB/wms', {
  layers: 'GRB_BSK', format: 'image/png', transparent: false, maxZoom: 22,
  crossOrigin: true,
  attribution: '© Digitaal Vlaanderen — GRB'
});
const baseCadGIS = L.tileLayer.wms('https://eservices.minfin.fgov.be/arcgis/services/CadGIS/MapServer/WMSServer', {
  layers: '5', format: 'image/png', transparent: true, maxZoom: 22,
  attribution: '© Kadaster — CadGIS Percelen',
  opacity: 0.7
});

let tileErrorCount = 0;
function handleBaseLayerError(layerName) {
  tileErrorCount += 1;
  if (tileErrorCount >= 3 && !map.hasLayer(baseOSM)) {
    setBaseLayerByName('OpenStreetMap');
    const hint = document.getElementById('parseHint');
    if (hint && !hint.textContent.includes('achtergrondkaart')) {
      hint.innerHTML += ` <span class="text-warning">— achtergrondkaart tijdelijk niet beschikbaar (${layerName}), OSM fallback actief</span>`;
    }
  }
}

baseGRB.on('tileerror', () => handleBaseLayerError('GRB'));
baseOrtho.on('tileerror', () => handleBaseLayerError('Orthofoto'));
baseCadGIS.on('tileerror', () => handleBaseLayerError('CadGIS'));

baseGRB.addTo(map);
L.control.layers(
  { 'Orthofoto (AGIV)': baseOrtho, 'GRB': baseGRB },
  {}, { position: 'topright' }
).addTo(map);

// ════════════════════════════════════════════════════
// CHECK DEFINITIONS
// ════════════════════════════════════════════════════
const CHECKS = [
  // ─── JURIDISCH ───
  {
    id: 'buurtwegen',
    group: 'Juridisch & erfdienstbaarheden',
    label: 'Atlas der Buurtwegen (ca. 1840)',
    icon: 'bi-sign-turn-right-fill',
    iconColor: '#dc3545',
    description: 'Historische buurtwegen met recht van doorgang — visuele WMS-controle zonder automatische buffer',
    manualCheck: true,
    wmsUrl:  'https://geo.api.vlaanderen.be/histcart/wms',
    wmsLayer:'abw',
    singleImageWms: true,
    links: [
      { label: 'Geoloket Buurtwegen', url: 'https://www.geoloket.be/Html5Viewer/index.html?viewer=Mobiliteit.GISWest-Geoloket&run=openThema&subthema=TrageWegen' },
      { label: 'DVL histcart', url: 'https://geo.api.vlaanderen.be/histcart/wms?SERVICE=WMS&REQUEST=GetCapabilities' }
    ]
  },
  {
    id: 'tragewegen',
    group: 'Juridisch & erfdienstbaarheden',
    label: 'Wijzigingen Buurtwegen (GISWest WV)',
    icon: 'bi-person-walking',
    iconColor: '#7c3aed',
    description: 'Besliste wijzigingen aan buurtwegen in West-Vlaanderen (vector, querybaar)',
    arcgisUrl: 'https://www.geoloket.be/gwserver/rest/services/GC/AGS_THEMA_Mobiliteit/MapServer',
    arcgisLayerId: 3,
    queryBufferM: 400,
    arcgisFields: 'TYPE_WIJZIGING,BESLISSING,DATUM_BESLUIT,NR_WEG,CODE_GEMEENTE,OPMERKING',
    foundMsg:    n => `⚠️ ${n} buurtweg-wijziging(en) geregistreerd`,
    notFoundMsg: 'Geen geregistreerde wijzigingen in deze omgeving',
    links: [
      { label: 'GISWest Trage Wegen', url: 'https://www.geoloket.be/Html5Viewer/index.html?viewer=Mobiliteit.GISWest-Geoloket&run=openThema&subthema=TrageWegen' },
      { label: 'tragewegen.be', url: 'https://www.tragewegen.be/kaart' }
    ]
  },
  {
    id: 'ruilverkaveling',
    group: 'Juridisch & erfdienstbaarheden',
    label: 'Ruilverkaveling van kracht (VLM)',
    icon: 'bi-grid-3x3-gap-fill',
    iconColor: '#059669',
    description: 'Ruilverkavelingen van kracht — naam, fase en datum akte (vector data op kaart)',
    wfsUrl:    'https://geo.api.vlaanderen.be/RvkKrachtWet/wfs',
    wfsType:   'RvkKrachtWet:RvkKrachtWet',
    specialType: 'ruilverkaveling',
    links: [
      { label: 'VLM kaarten', url: 'https://www.vlm.be/nl/SitePages/GISkaarten.aspx' }
    ]
  },
  // ─── INFRASTRUCTUUR ───
  {
    id: 'awv_wegen',
    group: 'Infrastructuur & beheer',
    label: 'Wegenregister — Beheerder & rooilijn',
    icon: 'bi-sign-intersection-fill',
    iconColor: '#2563eb',
    description: 'Welke wegen liggen aan het perceel en wie is beheerder (AWV / gemeente / provincie)?',
    wfsUrl:    'https://geo.api.vlaanderen.be/Wegenregister/wfs',
    wfsType:   'Wegenregister:Wegsegment',
    queryBufferM: 100,
    wfsFields: 'labelWegbeheerder,wegcategorie,linkerstraatnaam,rechterstraatnaam,morfologischeWegklasse',
    specialType: 'wegenregister',
    links: [
      { label: 'Wegenregister', url: 'https://wegenregister.vlaanderen.be/' },
      { label: 'AWV rooilijnen', url: 'https://wegenenverkeer.be/veilig-op-weg/werken-langs-de-weg' }
    ]
  },
  // ─── WATER ───
  {
    id: 'waterlopen',
    group: 'Water',
    label: 'VHA Waterlopen (Vlaanderen)',
    icon: 'bi-water',
    iconColor: '#0891b2',
    description: 'Vlaamse Hydrografische Atlas — geklasseerde waterlopen cat. 1, 2 en 3 met beheerder (vector data op kaart)',
    wfsUrl:    'https://geo.api.vlaanderen.be/VHAWaterlopen/wfs',
    wfsType:   'VHAWaterlopen:Wlas',
    queryBufferM: 200,
    wfsFields: 'NAAM,CATC,LBLCATC,BEHEER,BEKNAAM',
    specialType: 'waterlopen',
    links: [
      { label: 'VHA Geopunt', url: 'https://www.geopunt.be/catalogus/datasetfolder/a903a580-d30e-11e3-9e67-005056a06bd5' }
    ]
  },
  {
    id: 'watertalk',
    group: 'Water',
    label: 'Watertalk — Waterlopen WV (querybaar)',
    icon: 'bi-droplet-half',
    iconColor: '#0369a1',
    description: 'Vlaamse Hydrografische Atlas via West-Vlaanderen — categorie, naam en beheerder',
    arcgisUrl: 'https://gwadmin.west-vlaanderen.be/gwserver/rest/services/watertalk/VlaamseHydrografischeAtlas/MapServer',
    arcgisLayerId: 0,
    queryBufferM: 200,
    arcgisFields: 'naam,catc,behe,prov',
    specialType: 'watertalk',
    foundMsg:    n => `⚠️ ${n} waterloop/lopen in West-Vlaanderen`,
    notFoundMsg: 'Geen waterlopen gevonden (of buiten West-Vlaanderen)',
    links: [
      { label: 'Watertalk.be', url: 'https://watertalk.be/' }
    ]
  },
  // ─── KADASTER ───
  {
    id: 'kadaster',
    group: 'Kadaster & oppervlakte',
    label: 'Kadastrale oppervlakte',
    icon: 'bi-rulers',
    iconColor: '#0f766e',
    description: 'Vergelijking GRB-polygoonoppervlakte vs. kadastrale legger',
    specialType: 'kadaster',
    links: [
      { label: 'CadGIS', url: 'https://eservices.minfin.fgov.be/ecad/#/' },
      { label: 'Basisregisters', url: 'https://www.basisregisters.vlaanderen.be/' }
    ]
  },
  {
    id: 'oude_dossiers',
    group: 'Context & dossierhistoriek',
    label: 'Eerdere opmetingsdossiers in de buurt',
    icon: 'bi-archive-fill',
    iconColor: '#b45309',
    description: 'Zoekt eerdere opmeet- en grensdossiers in de nabijheid om dossierkennis te hergebruiken.',
    radiusM: DOSSIER_RADIUS_M,
    specialType: 'oude_dossiers',
    manualCheck: false
  }
];

// ════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════
let currentParcel  = null;
let parcelLayer    = null;
let activeWmsLayers = {};   // id → L.tileLayer.wms
let activeDataLayers = {};  // id → L.geoJSON (WFS results)
let desiredLayerVisibility = {}; // id → user toggle intent (show/hide)
let activeCheckResults = {}; // id → last fetched data / metadata for PDF snapshots
let isSearching = false;

// ════════════════════════════════════════════════════
// RENDER CHECKS PANEL
// ════════════════════════════════════════════════════
function renderChecksPanel(running = false) {
  const panel = document.getElementById('checksPanel');
  const checks = getChecksForCurrentParcel();
  let html = '';
  let group = '';

  if (currentParcel?.province) {
    html += `<div class="section-header">Provincieherkenning</div>`;
    html += `<div class="check-item"><div class="check-title"><span class="icon-wrap"><i class="bi bi-geo-alt-fill" style="color:#b91c1c"></i></span><span>${currentParcel.province}</span><span class="status-badge s-found">REGIO</span></div><div class="check-status text-muted">Bronnen afgestemd op ${currentParcel.province}.</div></div>`;
  }

  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      html += `<div class="section-header">${group}</div>`;
    }

    const badgeClass = running ? 's-checking' : 's-waiting';
    const badgeText  = running ? '…' : '—';

    // Action buttons
    let acts = '';
    const canToggleLayer = !!(c.wmsUrl || c.wfsUrl || c.arcgisUrl);
    if (canToggleLayer) {
      acts += `<button class="btn btn-xs btn-outline-secondary" style="font-size:0.72rem;padding:2px 8px;"
                 id="wms-btn-${c.id}" onclick="toggleWMS('${c.id}')">
               <i class="bi bi-layers"></i> Toon op kaart
             </button>`;
    }
    for (const lnk of (c.links || [])) {
      acts += `<a href="${lnk.url}" target="_blank"
                 class="btn btn-xs btn-outline-primary"
                 style="font-size:0.72rem;padding:2px 8px;">
               <i class="bi bi-box-arrow-up-right"></i> ${lnk.label}
             </a>`;
    }
    if (c.klichLinks) {
      const coords = currentParcel
        ? `&x=${currentParcel.center[0].toFixed(6)}&y=${currentParcel.center[1].toFixed(6)}`
        : '';
      acts += `<a href="https://klip.be/${coords}" target="_blank"
                 class="btn btn-xs btn-warning"
                 style="font-size:0.72rem;padding:2px 8px;">
               <i class="bi bi-geo-fill"></i> KLIP met locatie
             </a>`;
    }

    html += `
    <div class="check-item" id="check-${c.id}">
      <div class="check-title">
        <span class="icon-wrap"><i class="bi ${c.icon}" style="color:${c.iconColor}"></i></span>
        <span>${c.label}</span>
        <span class="status-badge ${badgeClass}" id="badge-${c.id}">${badgeText}</span>
      </div>
      <div class="check-status text-muted" id="status-${c.id}">${c.description}</div>
      <div class="check-actions" id="actions-${c.id}">${acts}</div>
    </div>`;
  }
  panel.innerHTML = html;
}

// ════════════════════════════════════════════════════
// STATUS HELPERS
// ════════════════════════════════════════════════════
function setBadge(id, cls, text) {
  const el = document.getElementById(`badge-${id}`);
  if (el) { el.className = `status-badge ${cls}`; el.textContent = text; }
}
function setStatus(id, html, colorClass = 'text-muted') {
  const el = document.getElementById(`status-${id}`);
  if (el) { el.innerHTML = html; el.className = `check-status ${colorClass}`; }
}
function showActions(id) {
  const el = document.getElementById(`actions-${id}`);
  if (el) el.style.display = 'flex';
}

function getCheckById(id) {
  return getChecksForCurrentParcel().find(x => x.id === id) || CHECKS.find(x => x.id === id) || null;
}

function isLayerVisible(id) {
  const hasWms = !!activeWmsLayers[id] && map.hasLayer(activeWmsLayers[id]);
  const hasData = !!activeDataLayers[id] && map.hasLayer(activeDataLayers[id]);
  return hasWms || hasData;
}

function updateLayerButtonState(id) {
  const btn = document.getElementById(`wms-btn-${id}`);
  if (!btn) return;
  if (isLayerVisible(id)) {
    btn.classList.add('btn-wms-active');
    btn.innerHTML = '<i class="bi bi-eye-fill"></i> Laag zichtbaar';
  } else {
    btn.classList.remove('btn-wms-active');
    btn.innerHTML = '<i class="bi bi-layers"></i> Toon op kaart';
  }
}

function attachDataLayer(id, layer) {
  if (!layer) return;
  layer.eachLayer?.(featureLayer => {
    if (typeof featureLayer.setStyle === 'function') {
      featureLayer.setStyle({
        weight: Math.max(Number(featureLayer.options?.weight) || 0, 4),
        opacity: 1,
        fillOpacity: Math.max(Number(featureLayer.options?.fillOpacity) || 0, 0.28)
      });
    }
    if (typeof featureLayer.setRadius === 'function') {
      featureLayer.setRadius(Math.max(Number(featureLayer.options?.radius) || 0, 8));
    }
  });
  activeDataLayers[id] = layer;
  if (desiredLayerVisibility[id]) {
    layer.addTo(map);
    if (typeof layer.bringToFront === 'function') layer.bringToFront();
  }
  if (parcelLayer && typeof parcelLayer.bringToFront === 'function') parcelLayer.bringToFront();
  updateLayerButtonState(id);
}

function createSingleImageWmsLayer(check) {
  const bounds = map.getBounds();
  const size = map.getSize();
  const scale = Math.min(2, 2048 / Math.max(size.x, size.y));
  const width = Math.max(256, Math.round(size.x * scale));
  const height = Math.max(256, Math.round(size.y * scale));
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: check.wmsLayer,
    STYLES: '',
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    SRS: 'EPSG:4326',
    BBOX: bbox,
    WIDTH: String(width),
    HEIGHT: String(height)
  });
  return L.imageOverlay(`${check.wmsUrl}?${params}`, bounds, {
    pane: 'wmsOverlayPane',
    opacity: 0.95,
    crossOrigin: true,
    interactive: false
  });
}

function refreshSingleImageWmsLayers() {
  for (const [id, oldLayer] of Object.entries(activeWmsLayers)) {
    const check = getCheckById(id);
    if (!check?.singleImageWms || !map.hasLayer(oldLayer)) continue;
    map.removeLayer(oldLayer);
    const newLayer = createSingleImageWmsLayer(check);
    newLayer.addTo(map);
    activeWmsLayers[id] = newLayer;
  }
  if (parcelLayer && typeof parcelLayer.bringToFront === 'function') parcelLayer.bringToFront();
}

map.on('moveend resize', refreshSingleImageWmsLayers);

function showLayer(id) {
  const c = getCheckById(id);
  desiredLayerVisibility[id] = true;

  if (activeDataLayers[id] && !map.hasLayer(activeDataLayers[id])) {
    activeDataLayers[id].addTo(map);
    if (typeof activeDataLayers[id].bringToFront === 'function') activeDataLayers[id].bringToFront();
  }

  if (c?.wmsUrl && !activeWmsLayers[id]) {
    const layer = c.singleImageWms
      ? createSingleImageWmsLayer(c)
      : L.tileLayer.wms(c.wmsUrl, {
          layers: c.wmsLayer, format: 'image/png',
          transparent: true, opacity: 0.95, maxZoom: 22,
          crossOrigin: true,
          pane: 'wmsOverlayPane'
        });
    layer.addTo(map);
    activeWmsLayers[id] = layer;
  }

  if (parcelLayer && typeof parcelLayer.bringToFront === 'function') parcelLayer.bringToFront();

  updateLayerButtonState(id);
}

function hideLayer(id) {
  desiredLayerVisibility[id] = false;

  if (activeDataLayers[id] && map.hasLayer(activeDataLayers[id])) {
    map.removeLayer(activeDataLayers[id]);
  }

  if (activeWmsLayers[id]) {
    map.removeLayer(activeWmsLayers[id]);
    delete activeWmsLayers[id];
  }

  updateLayerButtonState(id);
}

function getCurrentBaseLayerName() {
  const layers = {
    'OpenStreetMap': baseOSM,
    'Orthofoto (AGIV)': baseOrtho,
    'GRB': baseGRB,
    'CadGIS Percelen': baseCadGIS,
  };
  for (const [name, layer] of Object.entries(layers)) {
    if (map.hasLayer(layer)) return name;
  }
  return 'Onbekend';
}

function setBaseLayerByName(name) {
  const layers = {
    'OpenStreetMap': baseOSM,
    'Orthofoto (AGIV)': baseOrtho,
    'GRB': baseGRB,
    'CadGIS Percelen': baseCadGIS,
  };
  for (const layer of Object.values(layers)) {
    if (map.hasLayer(layer)) map.removeLayer(layer);
  }
  if (layers[name]) layers[name].addTo(map);
}

// ════════════════════════════════════════════════════
// WMS TOGGLE
// ════════════════════════════════════════════════════
function toggleWMS(id) {
  if (isLayerVisible(id)) {
    hideLayer(id);
  } else {
    showLayer(id);
  }
}

// ════════════════════════════════════════════════════
// WFS QUERY (BBOX in Lambert72)
// ════════════════════════════════════════════════════
async function wfsQuery(url, typeName, bboxL72, bufM = 25, propertyNames = null) {
  const [x1, y1, x2, y2] = bboxL72;
  const bbox = `${x1 - bufM},${y1 - bufM},${x2 + bufM},${y2 + bufM},EPSG:31370`;
  let qs = `SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature` +
    `&TYPENAMES=${encodeURIComponent(typeName)}` +
    `&BBOX=${bbox}` +
    `&outputFormat=application%2Fjson&count=30`;
  if (propertyNames) qs += `&PROPERTYNAME=${encodeURIComponent(propertyNames)}`;
  const res = await fetch(`${url}?${qs}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ════════════════════════════════════════════════════
// ARCGIS REST QUERY (BBOX in Lambert72)
// ════════════════════════════════════════════════════
async function arcgisQuery(serviceUrl, layerId, bboxL72, fields = '*', bufM = 25) {
  const [x1, y1, x2, y2] = bboxL72;
  const geom = JSON.stringify({
    xmin: x1 - bufM, ymin: y1 - bufM,
    xmax: x2 + bufM, ymax: y2 + bufM,
    spatialReference: { wkid: 31370 }
  });
  const params = new URLSearchParams({
    geometry: geom,
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: fields,
    returnGeometry: 'true',
    f: 'geojson'
  });
  const res = await fetch(`${serviceUrl}/${layerId}/query?${params}`, { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

// ════════════════════════════════════════════════════
// GEOMETRY HELPERS
// ════════════════════════════════════════════════════
function convertGeomToWGS84(geom) {
  // Convert Lambert72/Belgian CRS geometry to WGS84 if needed
  if (!geom || !geom.coordinates) return geom;
  const getFirstCoord = coords => {
    if (!Array.isArray(coords)) return null;
    if (coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') return coords;
    for (const c of coords) {
      const found = getFirstCoord(c);
      if (found) return found;
    }
    return null;
  };

  const firstCoord = getFirstCoord(geom.coordinates);
  if (!firstCoord || !isLambert72(firstCoord)) return geom;

  const convertCoord = ([x, y]) => fromL72(x, y);
  const convertRing = ring => ring.map(convertCoord);

  if (geom.type === 'Point') {
    return { type: 'Point', coordinates: convertCoord(geom.coordinates) };
  }
  if (geom.type === 'MultiPoint' || geom.type === 'LineString') {
    return { type: geom.type, coordinates: geom.coordinates.map(convertCoord) };
  }
  if (geom.type === 'MultiLineString') {
    return { type: 'MultiLineString', coordinates: geom.coordinates.map(convertRing) };
  }
  if (geom.type === 'Polygon') {
    return { type: 'Polygon', coordinates: geom.coordinates.map(convertRing) };
  }
  if (geom.type === 'MultiPolygon') {
    return { type: 'MultiPolygon', coordinates: geom.coordinates.map(poly => poly.map(convertRing)) };
  }
  return geom;
}

function toWgs84FeatureCollection(data) {
  const features = Array.isArray(data?.features) ? data.features : [];
  return {
    type: 'FeatureCollection',
    features: features.map(f => ({ ...f, geometry: convertGeomToWGS84(f.geometry) }))
  };
}

function getParcelBBoxL72(geomWGS84) {
  const allRings = geomWGS84.type === 'Polygon'
    ? geomWGS84.coordinates
    : geomWGS84.coordinates.flat();
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const ring of allRings) {
    for (const [lon, lat] of ring) {
      const [x, y] = toL72(lon, lat);
      if (x < x1) x1 = x; if (y < y1) y1 = y;
      if (x > x2) x2 = x; if (y > y2) y2 = y;
    }
  }
  return [x1, y1, x2, y2];
}

function calcAreaL72(geomWGS84) {
  // Shoelace in Lambert72 → m²
  const ring = (geomWGS84.type === 'Polygon')
    ? geomWGS84.coordinates[0]
    : geomWGS84.coordinates[0][0];
  const pts = ring.map(([lon, lat]) => toL72(lon, lat));
  let area = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  }
  return Math.abs(area) / 2;
}

function getBoundingBoxFromGeomCoordinates(coords, bbox = [Infinity, Infinity, -Infinity, -Infinity]) {
  if (!Array.isArray(coords)) return bbox;
  if (coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    const [x, y] = coords;
    if (x < bbox[0]) bbox[0] = x;
    if (y < bbox[1]) bbox[1] = y;
    if (x > bbox[2]) bbox[2] = x;
    if (y > bbox[3]) bbox[3] = y;
    return bbox;
  }
  for (const c of coords) getBoundingBoxFromGeomCoordinates(c, bbox);
  return bbox;
}

function bboxIntersects(a, b, pad = 0) {
  return !(a[2] + pad < b[0] || a[0] - pad > b[2] || a[3] + pad < b[1] || a[1] - pad > b[3]);
}

function filterFeaturesByParcelBBox(features, parcelBBoxL72, pad = 5) {
  if (!Array.isArray(features) || !parcelBBoxL72) return [];
  return features.filter(f => {
    if (!f?.geometry?.coordinates) return false;
    const fb = getBoundingBoxFromGeomCoordinates(f.geometry.coordinates);
    if (!Number.isFinite(fb[0])) return false;
    return bboxIntersects(fb, parcelBBoxL72, pad);
  });
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonWGS84(point, geom) {
  if (!geom || !Array.isArray(point)) return false;
  const polygons = geom.type === 'Polygon' ? [geom.coordinates] : (geom.coordinates || []);
  for (const poly of polygons) {
    const outer = poly?.[0];
    if (!Array.isArray(outer) || !outer.length) continue;
    if (!pointInRing(point, outer)) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (pointInRing(point, poly[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function guessCadgisCrs(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'EPSG:31370';
  if (x > 400000 && y > 400000) return 'EPSG:3812';
  return 'EPSG:31370';
}

function provinceFromCapaKey(capaKey) {
  if (!capaKey || capaKey.length < 2) return null;
  const p = capaKey.substring(0, 2);
  if (['11', '12', '13'].includes(p)) return 'Antwerpen';
  if (['23', '24'].includes(p)) return 'Vlaams-Brabant';
  if (['31', '32', '33', '34', '35', '36', '37', '38', '39'].includes(p)) return 'West-Vlaanderen';
  if (['41', '42', '43', '44', '45', '46'].includes(p)) return 'Oost-Vlaanderen';
  if (['71', '72', '73'].includes(p)) return 'Limburg';
  return null;
}

function haversineKm(aLon, aLat, bLon, bLat) {
  const toRad = d => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const sa = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(sa), Math.sqrt(1 - sa));
}

function normalizeCapaKey(value) {
  if (!value) return null;
  const v = String(value).trim().toUpperCase();
  return v || null;
}

async function fetchCapaKeysFromGrbPoint(center, spanM = 40) {
  if (!Array.isArray(center) || center.length !== 2) return [];
  const [x, y] = toL72(center[0], center[1]);
  const bbox = `${x - spanM},${y - spanM},${x + spanM},${y + spanM}`;
  const url =
    'https://geo.api.vlaanderen.be/GRB/wms'
    + `?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo`
    + `&CRS=EPSG:31370&LAYERS=GRB_ADP&QUERY_LAYERS=GRB_ADP`
    + `&BBOX=${encodeURIComponent(bbox)}`
    + `&WIDTH=101&HEIGHT=101&I=50&J=50`
    + `&INFO_FORMAT=application/json&FEATURE_COUNT=20`;

  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];

  const payload = await res.json();
  const keys = (payload?.features || [])
    .map(f => normalizeCapaKey(f?.properties?.CAPAKEY || f?.properties?.capakey))
    .filter(Boolean);

  return [...new Set(keys)];
}

async function resolveCapaKeyFromAddressCenter(center) {
  let grbCandidates = [];
  try {
    grbCandidates = await fetchCapaKeysFromGrbPoint(center, 40);
    if (!grbCandidates.length) {
      grbCandidates = await fetchCapaKeysFromGrbPoint(center, 120);
    }
  } catch {
    grbCandidates = [];
  }

  for (const candidate of grbCandidates.slice(0, 8)) {
    try {
      const { geom } = await fetchParcelGeometry(candidate);
      if (pointInPolygonWGS84(center, geom)) {
        return { capaKey: candidate, geomWGS84: geom, matchedBy: 'grb-point-in-parcel' };
      }
    } catch {
      // Skip candidate if geometry lookup fails.
    }
  }

  if (grbCandidates.length) {
    return { capaKey: grbCandidates[0], geomWGS84: null, matchedBy: 'grb-featureinfo' };
  }

  const [lon, lat] = center;
  const d = 0.0008;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const res = await fetch(proxyUrl('basisregisters', `v2/percelen?bbox=${encodeURIComponent(bbox)}`), {
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) return null;
  const payload = await res.json();
  const list = [...new Set((payload?.percelen || []).map(p => normalizeCapaKey(p?.caPaKey)).filter(Boolean))];
  if (!list.length) return null;

  let nearest = null;

  for (const candidate of list.slice(0, 12)) {
    try {
      const { geom } = await fetchParcelGeometry(candidate);
      if (pointInPolygonWGS84(center, geom)) {
        return { capaKey: candidate, geomWGS84: geom, matchedBy: 'point-in-parcel' };
      }

      const b = getParcelBBoxL72(geom);
      if (Number.isFinite(b[0])) {
        const cx = (b[0] + b[2]) / 2;
        const cy = (b[1] + b[3]) / 2;
        const [clon, clat] = fromL72(cx, cy);
        const distKm = haversineKm(center[0], center[1], clon, clat);
        if (!nearest || distKm < nearest.distKm) {
          nearest = { capaKey: candidate, geomWGS84: geom, distKm };
        }
      }
    } catch {
      // Skip candidate if geometry lookup fails.
    }
  }

  if (nearest) {
    return { capaKey: nearest.capaKey, geomWGS84: nearest.geomWGS84, matchedBy: 'nearest-geometry' };
  }

  return { capaKey: list[0], geomWGS84: null, matchedBy: 'nearest-bbox' };
}

function getProvinceSpecificChecks(province) {
  if (province === 'Oost-Vlaanderen') {
    return [
      {
        id: 'oost_waterbeleid',
        group: 'Water',
        label: 'Waterbeleid (Oost-Vlaanderen)',
        icon: 'bi-droplet-half',
        iconColor: '#b91c1c',
        description: 'Provinciale VertiGIS-bron voor waterbeleid en waterlopen.',
        manualCheck: true,
        links: [{ label: 'Waterbeleid', url: 'https://gis.oost-vlaanderen.be/waterbeleid/' }]
      }
    ];
  }
  if (province === 'West-Vlaanderen') {
    return [];
  }
  return [];
}

function normalizeProvinceName(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  const map = {
    'east flanders': 'Oost-Vlaanderen',
    'oost-vlaanderen': 'Oost-Vlaanderen',
    'west flanders': 'West-Vlaanderen',
    'west-vlaanderen': 'West-Vlaanderen',
    'antwerp': 'Antwerpen',
    'antwerpen': 'Antwerpen',
    'limburg': 'Limburg',
    'flemish brabant': 'Vlaams-Brabant',
    'vlaams-brabant': 'Vlaams-Brabant',
    'walloon brabant': 'Waals-Brabant',
    'brabant wallon': 'Waals-Brabant',
    'hainaut': 'Henegouwen',
    'namur': 'Namen',
    'liège': 'Luik',
    'liege': 'Luik',
    'luxembourg': 'Luxemburg',
    'federal district': 'Brussels Hoofdstedelijk Gewest',
    'brussels': 'Brussels Hoofdstedelijk Gewest',
    'bruxelles': 'Brussels Hoofdstedelijk Gewest',
  };
  return map[text] || value;
}

function getChecksForCurrentParcel() {
  const checks = PUBLIC_MODE ? CHECKS.filter(check => check.id !== 'oude_dossiers') : CHECKS;
  return [...checks, ...getProvinceSpecificChecks(currentParcel?.province)];
}

async function detectProvince(center) {
  if (!center) return null;
  try {
    const [lon, lat] = center;
    const res = await fetch(proxyUrl('nominatim', `reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1&zoom=10`), {
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeProvinceName(data?.address?.state || data?.address?.province || data?.address?.county || null);
  } catch {
    return null;
  }
}

async function detectAddressContext(center) {
  if (!center) return null;
  const [lon, lat] = center;

  try {
    const res = await fetch(proxyUrl('nominatim', `reverse?lat=${lat}&lon=${lon}&format=jsonv2&addressdetails=1&zoom=18`), {
      signal: AbortSignal.timeout(10000)
    });
    if (res.ok) {
      const data = await res.json();
      const addr = data?.address || {};
      return {
        label: data?.display_name || null,
        streetName: addr.road || addr.pedestrian || addr.street || null,
        houseNumber: addr.house_number || null,
        municipality: addr.town || addr.city || addr.village || addr.hamlet || addr.municipality || null,
        province: normalizeProvinceName(addr.state || addr.province || addr.county || null)
      };
    }
  } catch {
    // Fallback below.
  }

  try {
    const res = await fetch(proxyUrl('photon', `reverse?lon=${lon}&lat=${lat}`),
      { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const payload = await res.json();
    const feat = Array.isArray(payload?.features) ? payload.features[0] : null;
    const p = feat?.properties || {};
    const label = [
      [p.street, p.housenumber].filter(Boolean).join(' ').trim(),
      p.postcode,
      p.city || p.locality || p.district,
      p.state
    ].filter(Boolean).join(', ');
    return {
      label: label || null,
      streetName: p.street || null,
      houseNumber: p.housenumber || null,
      municipality: p.city || p.locality || p.district || null,
      province: normalizeProvinceName(p.state || null)
    };
  } catch {
    return null;
  }
}

function addPdfHeader(doc, title, subtitle) {
  doc.setFillColor(32, 38, 45);
  doc.rect(0, 0, 210, 25, 'F');
  doc.setFillColor(151, 45, 35);
  doc.rect(0, 25, 210, 2, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text(title, 14, 12);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.text(subtitle, 14, 19);
  doc.setTextColor(32, 38, 45);
}

function addPdfSection(doc, title, y) {
  doc.setDrawColor(151, 45, 35);
  doc.setLineWidth(0.7);
  doc.line(14, y + 4, 196, y + 4);
  doc.setTextColor(151, 45, 35);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(title.toUpperCase(), 14, y + 1);
  doc.setTextColor(32, 38, 45);
  return y + 10;
}

function makePdfReportRows(checks) {
  return checks.map(check => {
    const statusElement = document.getElementById(`status-${check.id}`);
    const tableRows = [...(statusElement?.querySelectorAll('tr') || [])]
      .map(row => [...row.querySelectorAll('th, td')].map(cell => cell.innerText.trim()).filter(Boolean).join(' - '))
      .filter(Boolean);
    const status = tableRows.length
      ? tableRows.join('\n')
      : (statusElement?.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      group: check.group,
      label: check.label,
      badge: document.getElementById(`badge-${check.id}`)?.textContent || 'ONBEKEND',
      status
    };
  });
}

function addPdfFooter(doc) {
  const pageNumber = doc.internal.getNumberOfPages();
  doc.setDrawColor(210, 214, 218);
  doc.setLineWidth(0.2);
  doc.line(14, 282, 196, 282);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(100, 106, 112);
  doc.text('Niet voor juridische besluitvorming. Terreincontrole en bronverificatie blijven vereist.', 14, 288);
  doc.text(`Pagina ${pageNumber}`, 196, 288, { align: 'right' });
}

function addPdfPage(doc) {
  addPdfFooter(doc);
  doc.addPage();
  addPdfHeader(doc, 'Perceel Checker', 'Buro Eyckmans | Vooronderzoek klassieke opmeting');
  return 36;
}

function drawPdfTableHeader(doc, y) {
  doc.setFillColor(32, 38, 45);
  doc.rect(14, y, 182, 9, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(255, 255, 255);
  doc.text('ONDERDEEL', 17, y + 5.8);
  doc.text('STATUS', 76, y + 5.8);
  doc.text('RESULTAAT', 105, y + 5.8);
  return y + 9;
}

function writePdfRows(doc, rows, startY) {
  let y = drawPdfTableHeader(doc, startY);
  let currentGroup = '';
  const pageBottom = 276;

  for (const row of rows) {
    if (row.group !== currentGroup) {
      currentGroup = row.group;
      if (y > pageBottom - 18) {
        y = addPdfPage(doc);
        y = drawPdfTableHeader(doc, y);
      }
      doc.setFillColor(232, 234, 236);
      doc.rect(14, y, 182, 7, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(76, 82, 88);
      doc.text(currentGroup.toUpperCase(), 17, y + 4.8);
      y += 7;
    }

    const labelLines = doc.splitTextToSize(row.label, 53);
    const badgeLines = doc.splitTextToSize(row.badge, 23);
    const statusLines = doc.splitTextToSize(row.status || 'Geen bijkomende informatie.', 86);
    const lineCount = Math.max(labelLines.length, badgeLines.length, statusLines.length);
    const rowHeight = Math.max(10, 5 + lineCount * 3.6);
    if (y + rowHeight > pageBottom) {
      y = addPdfPage(doc);
      y = drawPdfTableHeader(doc, y);
      doc.setFillColor(232, 234, 236);
      doc.rect(14, y, 182, 7, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(76, 82, 88);
      doc.text(`${currentGroup.toUpperCase()} (VERVOLG)`, 17, y + 4.8);
      y += 7;
    }

    doc.setFillColor(249, 250, 251);
    doc.setDrawColor(221, 224, 227);
    doc.rect(14, y, 182, rowHeight, 'FD');
    doc.line(73, y, 73, y + rowHeight);
    doc.line(102, y, 102, y + rowHeight);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.8);
    doc.setTextColor(32, 38, 45);
    doc.text(labelLines, 17, y + 5);

    const warning = /AANWEZIG|GEVONDEN|NAZICHT|AWV/.test(row.badge);
    const neutral = /VISUEEL|CHECK|MANUEEL|CAPAKEY|ONBEKEND/.test(row.badge);
    doc.setTextColor(...(warning ? [151, 45, 35] : neutral ? [92, 99, 106] : [39, 118, 83]));
    doc.setFontSize(7.2);
    doc.text(badgeLines, 76, y + 5);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    doc.setTextColor(75, 81, 87);
    doc.text(statusLines, 105, y + 5);
    y += rowHeight;
  }
  return y;
}

async function waitForMapImages() {
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const images = [...map.getContainer().querySelectorAll('img')].filter(image => image.offsetParent !== null);
  await Promise.all(images.map(image => image.complete
    ? Promise.resolve()
    : new Promise(resolve => {
        image.addEventListener('load', resolve, { once: true });
        image.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 6000);
      })));
}

async function captureReportMap() {
  await waitForMapImages();
  const canvas = await html2canvas(map.getContainer(), {
    backgroundColor: '#ffffff',
    useCORS: true,
    allowTaint: false,
    scale: 2,
    logging: false
  });
  return canvas.toDataURL('image/jpeg', 0.9);
}

function addMapExtract(doc, check, imageData, slot) {
  const top = slot === 0 ? 42 : 164;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(32, 38, 45);
  doc.text(check.label, 14, top - 5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(96, 102, 108);
  doc.text(`Onderlaag: GRB | Laagbron: ${check.wmsUrl ? 'WMS' : 'vectorresultaat'} | Perceelsgrens: oranje`, 14, top);
  doc.setDrawColor(198, 202, 206);
  doc.rect(14, top + 4, 182, 96);
  doc.addImage(imageData, 'JPEG', 14.5, top + 4.5, 181, 95, undefined, 'FAST');
}

async function appendMapExtracts(doc, checks) {
  const mapChecks = checks.filter(check => check.wmsUrl || activeDataLayers[check.id]);
  if (!mapChecks.length) return;

  const originalBase = getCurrentBaseLayerName();
  const originalWmsIds = Object.keys(activeWmsLayers).filter(id => map.hasLayer(activeWmsLayers[id]));
  const originalDataIds = Object.entries(activeDataLayers).filter(([, layer]) => map.hasLayer(layer)).map(([id]) => id);

  try {
    for (const check of checks) hideLayer(check.id);
    setBaseLayerByName('GRB');
    for (let index = 0; index < mapChecks.length; index += 1) {
      const check = mapChecks[index];
      if (index % 2 === 0) {
        addPdfFooter(doc);
        doc.addPage();
        addPdfHeader(doc, 'Kaartuittreksels', 'Buro Eyckmans | Thematische lagen bij het vooronderzoek');
      }
      showLayer(check.id);
      map.invalidateSize();
      const imageData = await captureReportMap();
      addMapExtract(doc, check, imageData, index % 2);
      hideLayer(check.id);
    }
  } finally {
    setBaseLayerByName(originalBase);
    for (const id of originalWmsIds) showLayer(id);
    for (const id of originalDataIds) showLayer(id);
    map.invalidateSize();
  }
}

// ════════════════════════════════════════════════════
// AUTOCOMPLETE
// ════════════════════════════════════════════════════
let suggestTimer = null;
let suggestController = null;
let suggestCooldownUntil = 0;
document.getElementById('searchInput').addEventListener('input', function () {
  clearTimeout(suggestTimer);
  const q = this.value.trim();
  if (q.length < 8 || !/\d/.test(q)) { hideSugg(); return; }
  suggestTimer = setTimeout(() => fetchSugg(q), 700);
});
document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter')  { doSearch(); hideSugg(); }
  if (e.key === 'Escape') { hideSugg(); }
});
document.addEventListener('click', e => {
  if (!e.target.closest('.position-relative')) hideSugg();
});

async function fetchSugg(q) {
  try {
    if (Date.now() < suggestCooldownUntil) { hideSugg(); return; }
    if (suggestController) suggestController.abort();
    suggestController = new AbortController();

    let items = [];
    try {
      const r = await fetch(
        proxyUrl('nominatim', `search?q=${encodeURIComponent(q)}&format=json&countrycodes=be&limit=4&addressdetails=1`),
        { signal: suggestController.signal }
      );
      if (r.status === 429) {
        suggestCooldownUntil = Date.now() + 90000;
        items = (await geocodeWithPhoton(q, 4)).map(d => d.display_name);
      } else if (r.ok) {
        const data = await r.json();
        items = data.map(d => d.display_name);
      } else {
        throw new Error(`Autocomplete fout (${r.status})`);
      }
    } catch {
      items = (await geocodeWithPhoton(q, 4)).map(d => d.display_name);
    }
    showSugg(items);
  } catch {
    hideSugg();
  }
}

function showSugg(items) {
  const div = document.getElementById('suggestions');
  if (!items.length) { hideSugg(); return; }
  div.replaceChildren();
  for (const suggestion of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'list-group-item list-group-item-action';

    const icon = document.createElement('i');
    icon.className = 'bi bi-geo me-2 text-muted';
    button.append(icon, document.createTextNode(suggestion));
    button.addEventListener('click', () => selectSugg(suggestion));
    div.append(button);
  }
  div.style.display = 'block';
}
function hideSugg() { document.getElementById('suggestions').style.display = 'none'; }

async function selectSugg(s) {
  document.getElementById('searchInput').value = s;
  hideSugg();
  await doSearch();
}

// ════════════════════════════════════════════════════
// FETCH PARCEL GEOMETRY — Basisregisters v2
// ════════════════════════════════════════════════════
async function fetchParcelGeometry(capaKey) {
  const res = await fetch(proxyUrl('cadgis', 'localisation/capakey'), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: capaKey,
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`Perceel niet gevonden in Basisregisters (${res.status})`);
  const coords = await res.json();
  if (!Array.isArray(coords) || coords.length < 8 || coords.length % 2 !== 0) {
    throw new Error('Geen geometrie beschikbaar');
  }

  const ringL72 = [];
  for (let i = 0; i < coords.length; i += 2) {
    ringL72.push([Number(coords[i]), Number(coords[i + 1])]);
  }
  if (ringL72.length && (ringL72[0][0] !== ringL72[ringL72.length - 1][0] || ringL72[0][1] !== ringL72[ringL72.length - 1][1])) {
    ringL72.push([...ringL72[0]]);
  }

  const crs = guessCadgisCrs(ringL72[0]?.[0], ringL72[0]?.[1]);
  const converter = crs === 'EPSG:3812' ? fromL08 : fromL72;
  const geom = {
    type: 'Polygon',
    coordinates: [ringL72.map(([x, y]) => converter(x, y))]
  };
  return { geom, raw: coords, crs };
}

// ════════════════════════════════════════════════════
// FETCH CADGIS ATTRIBUTES — oppervlakte + type
// ════════════════════════════════════════════════════
async function fetchCadgisAttributes(capaKey) {
  const body = {
    tableName: 'BPN_CAPA',
    criteria: {
      attribute: 'CAPAKEY',
      stringValue: capaKey,
      operation: 'EQUAL',
      numericValue: 0,
      dateValue: '',
      or: [],
      and: []
    }
  };
  const res = await fetch(proxyUrl('cadgis', 'search/attributaire'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`CadGIS zoekopdracht mislukt (${res.status})`);
  const payload = await res.json();
  return Array.isArray(payload) ? payload[0] : payload;
}

function formatCadgisSurfaceType(code) {
  const labels = {
    TI: 'titel',
    VE: 'geverifieerd',
    GR: 'grafisch',
  };
  if (!code) return '—';
  return labels[String(code).toUpperCase()] || `${code}`;
}

// ════════════════════════════════════════════════════
// DETECT CAPAKEY FORMAT
// ════════════════════════════════════════════════════
function looksLikeCapaKey(s) {
  return /^\d{5}[A-Za-z]\d{4}[\/\\_ ]\d{2}[A-Za-z]\d{3}$/.test(s.trim()) ||
         /^\d{5}[A-Za-z]\d{4}[A-Za-z]\d{5}$/.test(s.trim());
}

// ════════════════════════════════════════════════════
// MAIN SEARCH
// ════════════════════════════════════════════════════
async function doSearch(options = {}) {
  if (isSearching) return;

  const rawInput = options.rawInput ?? document.getElementById('searchInput').value.trim();
  const forcedCenter = options.center || null;
  const forcedLabel = options.label || null;
  const raw = rawInput || '';
  if (!raw && !forcedCenter) return;

  isSearching = true;
  hideSugg();

  const hint = document.getElementById('parseHint');
  hint.textContent = 'Zoeken…';

  // Clear previous
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
  for (const l of Object.values(activeWmsLayers)) map.removeLayer(l);
  for (const l of Object.values(activeDataLayers)) map.removeLayer(l);
  activeWmsLayers = {};
  activeDataLayers = {};
  desiredLayerVisibility = {};
  activeCheckResults = {};
  currentParcel = null;

  try {
    // ── Step 1: Geocoding ──
    let center, label, province = null;
    let municipality = null;
    let streetName = null;
    let houseNumber = null;

    if (looksLikeCapaKey(raw)) {
      // For CaPaKey: try Basisregisters first to get center
      // (geometry fetch happens below — use dummy center for now)
      center = null; label = raw.toUpperCase();
    } else if (forcedCenter) {
      center = forcedCenter;
      label = forcedLabel || `Aangeklikte locatie (${center[1].toFixed(6)}, ${center[0].toFixed(6)})`;
    } else {
      // Address → Nominatim
      let hits = [];
      let usedFallback = false;
      try {
        hits = await geocodeWithNominatim(raw, 1);
      } catch (err) {
        if (err?.status === 429) {
          hits = await geocodeWithPhoton(raw, 1);
          usedFallback = true;
        } else {
          throw err;
        }
      }
      if (!hits.length) throw new Error('Adres niet gevonden. Probeer een specifiekere zoekterm.');
      center = [parseFloat(hits[0].lon), parseFloat(hits[0].lat)];
      label  = hits[0].display_name;
      province = normalizeProvinceName(hits[0]?.address?.state || hits[0]?.address?.province || hits[0]?.address?.county || null);
      municipality = hits[0]?.address?.town || hits[0]?.address?.city || hits[0]?.address?.village || hits[0]?.address?.hamlet || hits[0]?.address?.municipality || null;
      streetName = hits[0]?.address?.road || hits[0]?.address?.pedestrian || hits[0]?.address?.street || null;
      houseNumber = hits[0]?.address?.house_number || null;
      if (usedFallback) {
        hint.innerHTML = '<span class="text-warning">⚠ fallback geocoder gebruikt (Nominatim tijdelijk beperkt)</span>';
      }
    }
    hint.innerHTML = `<span class="text-success">✓</span> ${label}`;

    // ── Step 2: Parcel geometry ──
    let geomWGS84 = null;
    let capaKey   = null;
    let area_grb  = null;

    if (looksLikeCapaKey(raw)) {
      capaKey = raw.trim().toUpperCase();
      province = provinceFromCapaKey(capaKey) || province;
      try {
        const { geom, raw: apiData } = await fetchParcelGeometry(capaKey);
        geomWGS84 = geom;
        area_grb  = calcAreaL72(geomWGS84);
        // Derive center from geometry bbox
        const bbox = getParcelBBoxL72(geomWGS84);
        const cx = (bbox[0] + bbox[2]) / 2;
        const cy = (bbox[1] + bbox[3]) / 2;
        center = fromL72(cx, cy);
      } catch (e) {
        hint.innerHTML += `  <span class="text-warning">— geometrie niet geladen: ${e.message}</span>`;
        if (!center) throw new Error('CaPaKey niet gevonden in Basisregisters. Controleer het formaat (bv. 34022A0345/00C000).');
      }
    } else if (center) {
      try {
        const resolved = await resolveCapaKeyFromAddressCenter(center);
        capaKey = resolved?.capaKey || null;
        if (capaKey) {
          province = provinceFromCapaKey(capaKey) || province;
          if (resolved?.geomWGS84) {
            geomWGS84 = resolved.geomWGS84;
          } else {
            const parcel = await fetchParcelGeometry(capaKey);
            geomWGS84 = parcel.geom;
          }
          area_grb = calcAreaL72(geomWGS84);

          const bbox = getParcelBBoxL72(geomWGS84);
          const cx = (bbox[0] + bbox[2]) / 2;
          const cy = (bbox[1] + bbox[3]) / 2;
          center = fromL72(cx, cy);

          hint.innerHTML += ` <span class="text-muted">— automatische CaPaKey: <strong>${capaKey}</strong></span>`;
        } else {
          hint.innerHTML += ` <span class="text-warning">— geen eenduidige CaPaKey gevonden</span>`;
        }
      } catch (e) {
        hint.innerHTML += ` <span class="text-warning">— automatische CaPaKey niet gevonden (${e.message})</span>`;
      }
    }

    const needsAddressContext =
      !municipality ||
      /^aangeklikte locatie/i.test(label || '') ||
      /^\d{1,2}\.\d+\s*,\s*\d{1,2}\.\d+/i.test(raw || '');

    if (needsAddressContext) {
      const ctx = await detectAddressContext(center);
      if (ctx?.label && /^aangeklikte locatie/i.test(label || '')) label = ctx.label;
      if (!municipality && ctx?.municipality) municipality = ctx.municipality;
      if (!streetName && ctx?.streetName) streetName = ctx.streetName;
      if (!houseNumber && ctx?.houseNumber) houseNumber = ctx.houseNumber;
      if (!province && ctx?.province) province = ctx.province;
    }

    if (!province) {
      province = await detectProvince(center);
    }

    // ── Step 3: Show on map ──
    if (geomWGS84) {
      parcelLayer = L.geoJSON({ type: 'Feature', geometry: geomWGS84 }, {
        pane: 'parcelOverlayPane',
        style: {
          color: '#ff5a1f', weight: 5,
          fillColor: '#ff5a1f', fillOpacity: 0.14
        }
      }).addTo(map);
      map.fitBounds(parcelLayer.getBounds(), { padding: [40, 40] });
    } else {
      parcelLayer = L.circleMarker([center[1], center[0]], {
        radius: 10, color: '#e67e22', fillOpacity: 0.4
      }).bindPopup(label).addTo(map);
      map.setView([center[1], center[0]], 16);
    }

    // ── Step 4: Set global state ──
    const L72bbox = geomWGS84
      ? getParcelBBoxL72(geomWGS84)
      : (() => { const [x,y] = toL72(center[0], center[1]); return [x-75,y-75,x+75,y+75]; })();

    currentParcel = { capaKey, center, geomWGS84, bboxL72: L72bbox, area_grb, province, municipality, streetName, houseNumber, addressLabel: label, centerLabel: label, searchInput: raw };

    // ── Step 5: Render panel + run checks ──
    renderChecksPanel(true);
    await runAllChecks();

  } catch (e) {
    currentParcel = null;
    activeDataLayers = {};
    desiredLayerVisibility = {};
    activeCheckResults = {};
    hint.innerHTML = `<span class="text-danger">❌ ${e.message}</span>`;
    document.getElementById('checksPanel').innerHTML = `
      <div class="p-4 text-center" style="color:#94a3b8; margin-top: 20px;">
        <i class="bi bi-search" style="font-size:2.5rem; display:block; margin-bottom:12px;"></i>
        <p class="mb-1 fw-semibold">Zoekresultaat niet beschikbaar</p>
        <small class="d-block text-muted">Controleer invoer of probeer met een exacte CaPaKey voor volledige kadastrale analyse.</small>
      </div>`;
  } finally {
    isSearching = false;
  }
}

map.on('click', async e => {
  const center = [e.latlng.lng, e.latlng.lat];
  document.getElementById('searchInput').value = `${e.latlng.lat.toFixed(6)}, ${e.latlng.lng.toFixed(6)}`;
  await doSearch({ center, label: 'Aangeklikte locatie op kaart' });
});

// ════════════════════════════════════════════════════
// RUN ALL CHECKS
// ════════════════════════════════════════════════════
async function runAllChecks() {
  await Promise.allSettled(getChecksForCurrentParcel().map(c => runCheck(c)));
}

async function runCheck(c) {
  if (!currentParcel) return;

  // SPECIAL: kadaster
  if (c.specialType === 'kadaster') {
    showActions(c.id);
    if (!currentParcel.capaKey) {
      setBadge(c.id, 's-manual', 'CaPaKey');
      setStatus(c.id, 'Voor een betrouwbare kadastrale oppervlakte: zoek met exacte CaPaKey.', 'text-muted');
      return;
    }
    const grbArea = currentParcel.area_grb;
    try {
      const cadgis = await fetchCadgisAttributes(currentParcel.capaKey);
      activeCheckResults[c.id] = { cadgis, grbArea };
      const surface = cadgis?.suvacn ?? null;
      const surfaceTypeCode = cadgis?.suvacnType ?? '—';
      const surfaceType = formatCadgisSurfaceType(surfaceTypeCode);
      const fiscSit = cadgis?.fiscSitId ?? '—';
      const lastUpdate = cadgis?.lastUpdate ? cadgis.lastUpdate : '—';
      const rows = [];
      if (grbArea) rows.push(`<tr><td>GRB polygoon</td><td><strong>${grbArea.toFixed(0)} m²</strong></td></tr>`);
      if (surface !== null) rows.push(`<tr><td>CadGIS kadastrale oppervlakte</td><td><strong>${Number(surface).toLocaleString('nl-BE')} m²</strong></td></tr>`);
      rows.push(`<tr><td>Type oppervlakte</td><td><strong>${surfaceType}</strong></td></tr>`);
      rows.push(`<tr><td>Fiscale situatie</td><td><strong>${fiscSit}</strong></td></tr>`);
      rows.push(`<tr><td>Laatste update</td><td><strong>${lastUpdate}</strong></td></tr>`);
      rows.push(`<tr><td colspan="2" class="text-muted" style="font-size:0.75rem;">`
        + `Vergelijk GRB met CadGIS. Afwijking &gt;5% of &gt;25m² verdient vermelding in het dossier.`
        + `</td></tr>`);
      setStatus(c.id, `<table class="area-table">${rows.join('')}</table>`);
      setBadge(c.id, 's-found', 'CADGIS');
    } catch (e) {
      if (grbArea) {
        setStatus(c.id, `
          <table class="area-table">
            <tr><td>GRB polygoon</td><td><strong>${grbArea.toFixed(0)} m²</strong></td></tr>
            <tr><td colspan="2" class="text-muted" style="font-size:0.75rem;">
              CadGIS niet bereikbaar: ${e.message}<br>
              Raadpleeg CadGIS voor de officiële leggeroppervlakte en vergelijk.
            </td></tr>
          </table>`);
        setBadge(c.id, 's-manual', 'CHECK');
      } else {
        setStatus(c.id, `Geen perceelsgeometrie en CadGIS niet bereikbaar: ${e.message}`);
        setBadge(c.id, 's-manual', 'MANUEEL');
      }
    }
    return;
  }

  if (c.specialType === 'oude_dossiers') {
    try {
      const nearby = await findNearbyDossiers(currentParcel, 12);
      activeCheckResults[c.id] = { nearby };
      showActions(c.id);

      if (!nearby.length) {
        setBadge(c.id, 's-notfound', 'GEEN');
        setStatus(c.id, 'Geen relevante opmetingsdossiers in de buurt gevonden', 'text-success');
        return;
      }

      setBadge(c.id, 's-found', 'NAZICHT');
      const rows = nearby.map(r => {
        const dist = Number.isFinite(r.distanceKm)
          ? 'zeer relevant'
          : `adresmatch (${r.addressFallback?.confidence || 'beperkt'})`;
        const distance = Number.isFinite(r.distanceKm)
          ? `${r.distanceKm < 1 ? `${Math.round(r.distanceKm * 1000)} m` : `${r.distanceKm.toFixed(2)} km`}`
          : r.addressFallback?.label || 'afstand niet bewezen';
        return `<tr><td>${r.dossierNr || '—'}</td><td>${r.typeOpdracht || '—'}</td><td>${r.gemeente || '—'}</td><td>${r.straatHuisnr || '—'}</td><td>${distance}</td><td style="font-size:0.72rem">${dist}</td></tr>`;
      }).join('');
      const total = Number.isFinite(nearby.totalCandidates) ? nearby.totalCandidates : nearby.length;
      setStatus(c.id, `<span class="text-danger fw-semibold">⚠️ ${nearby.length} dossiers gevonden (van ${total} treffers)</span><br><span class="text-muted">CAPAKEY-treffers zijn meetkundig begrensd tot ${DOSSIER_RADIUS_M} m. Adresmatches zonder CAPAKEY zijn beperkt tot dezelfde gemeente en straat; hun afstand is niet bewezen.</span><br><table class="area-table w-100 mt-1"><thead><tr><th>Dossier</th><th>Type</th><th>Gemeente</th><th>Straat</th><th>Afstand / match</th><th>Relevantie</th></tr></thead><tbody>${rows}</tbody></table>`);
    } catch (e) {
      setBadge(c.id, 's-manual', 'VISUEEL');
      setStatus(c.id, `Historische dossiercheck niet beschikbaar. (${e.message.substring(0,60)})`, 'text-muted');
      showActions(c.id);
    }
    return;
  }

  // MANUAL CHECK (WMS only)
  if (c.manualCheck) {
    setBadge(c.id, 's-manual', 'VISUEEL');
    setStatus(c.id, 'Zet kaartlaag aan of open de externe link voor visuele controle.', 'text-muted');
    showActions(c.id);
    return;
  }

  // ── SPECIAL: Ruilverkaveling ──
  if (c.specialType === 'ruilverkaveling') {
    try {
      const data = await wfsQuery(c.wfsUrl, c.wfsType, currentParcel.bboxL72, 10);
      const features = filterFeaturesByParcelBBox(data.features || [], currentParcel.bboxL72, 10);
      activeCheckResults[c.id] = { data, features };
      showActions(c.id);
      if (!features.length) {
        setBadge(c.id, 's-notfound', 'GEEN');
        setStatus(c.id, 'Perceel ligt niet in een ruilverkaveling van kracht', 'text-success');
        return;
      }
      setBadge(c.id, 's-found', 'AANWEZIG');
      const rows = features.map(f => {
        const p = f.properties || {};
        const datum = p.DATUMAKTE ? new Date(p.DATUMAKTE).toLocaleDateString('nl-BE') : '—';
        return `<tr><td class="fw-semibold">${p.NAAM || '—'}</td><td>${p.FASE || '—'}</td><td style="font-size:0.72rem">${datum}</td></tr>`;
      }).join('');
      setStatus(c.id, `<span class="text-danger fw-semibold">⚠️ Perceel ligt in een ruilverkaveling van kracht</span><br>
        <table class="area-table w-100 mt-1"><thead><tr><th>Naam</th><th>Fase</th><th>Datum akte</th></tr></thead><tbody>${rows}</tbody></table>`);
      try {
        const fl = L.geoJSON(toWgs84FeatureCollection(data), { pane: 'dataOverlayPane', style: { color: c.iconColor, weight: 2, fillColor: c.iconColor, fillOpacity: 0.15 } });
        attachDataLayer(c.id, fl);
      } catch {}
    } catch (e) {
      setBadge(c.id, 's-manual', 'VISUEEL');
      setStatus(c.id, `Automatische check niet beschikbaar. (${e.message.substring(0,60)})`, 'text-muted');
      showActions(c.id);
    }
    return;
  }

  // ── SPECIAL: Wegenregister met beheerder-info ──
  if (c.specialType === 'wegenregister') {
    try {
      const data = await wfsQuery(c.wfsUrl, c.wfsType, currentParcel.bboxL72, c.queryBufferM ?? 20, c.wfsFields);
      const features = data.features || [];
      activeCheckResults[c.id] = { data, features };
      showActions(c.id);
      if (!features.length) {
        setBadge(c.id, 's-notfound', 'GEEN WEG');
        setStatus(c.id, 'Geen wegsegmenten in de omgeving gevonden', 'text-success');
        return;
      }
      // Groepeer per beheerder
      const beheerders = {};
      for (const f of features) {
        const p   = f.properties || {};
        const lbl = p.labelWegbeheerder || p.wegbeheerder || 'Onbekend';
        const str = [p.linkerstraatnaam, p.rechterstraatnaam].filter(Boolean).join(' / ') || '—';
        if (!beheerders[lbl]) beheerders[lbl] = new Set();
        beheerders[lbl].add(str);
      }
      const isAWV = Object.keys(beheerders).some(b =>
        b.toLowerCase().includes('awv') || b.toLowerCase().includes('wegen en verkeer'));
      const rows = Object.entries(beheerders).map(([b, straten]) =>
        `<tr><td class="fw-semibold${b.toLowerCase().includes('awv') || b.toLowerCase().includes('wegen en verkeer') ? ' text-primary' : ''}">${b}</td>` +
        `<td style="font-size:0.75rem">${[...straten].slice(0,3).join(', ')}</td></tr>`
      ).join('');
      setBadge(c.id, isAWV ? 's-found' : 's-notfound', isAWV ? 'AWV' : 'GEMEENTE');
      setStatus(c.id, `<table class="area-table w-100"><thead><tr><th>Beheerder</th><th>Straat</th></tr></thead><tbody>${rows}</tbody></table>
        ${isAWV ? '<span class="text-primary fw-semibold">⚠️ AWV beheerder — rooilijn, onteigening en vergunning via AWV</span>' : ''}`);
      try {
        const fl = L.geoJSON(toWgs84FeatureCollection(data), {
          pane: 'dataOverlayPane',
          style: { color: c.iconColor, weight: 3, fillOpacity: 0.2 },
          onEachFeature: (f, layer) => {
            const p = f.properties || {};
            const beheerder = p.labelWegbeheerder || p.wegbeheerder || 'Onbekend';
            const straten = [p.linkerstraatnaam, p.rechterstraatnaam].filter(Boolean).join(' / ') || '—';
            layer.bindPopup(`<strong>${beheerder}</strong><br>Straat: ${straten}`);
          }
        });
        attachDataLayer(c.id, fl);
      } catch {}
    } catch (e) {
      setBadge(c.id, 's-manual', 'VISUEEL');
      setStatus(c.id, `Automatische check niet beschikbaar. (${e.message.substring(0,60)})`, 'text-muted');
      showActions(c.id);
    }
    return;
  }

  // ── SPECIAL: VHA Waterlopen ──
  if (c.specialType === 'waterlopen') {
    try {
      const data = await wfsQuery(c.wfsUrl, c.wfsType, currentParcel.bboxL72, c.queryBufferM ?? 20);
      const features = data.features || [];
      activeCheckResults[c.id] = { data, features };
      showActions(c.id);
      if (!features.length) {
        setBadge(c.id, 's-notfound', 'GEEN');
        setStatus(c.id, c.notFoundMsg || 'Geen geklasseerde waterlopen', 'text-success');
        return;
      }
      setBadge(c.id, 's-found', 'AANWEZIG');
      const rows = features.slice(0,6).map(f => {
        const p = f.properties || {};
        return `<tr><td>${p.NAAM || p.naam || '—'}</td><td>Cat. ${p.CATC ?? p.catc ?? '?'} — ${p.LBLCATC || p.lblcatc || ''}</td><td style="font-size:0.72rem">${p.BEHEER || p.beheer || ''}</td></tr>`;
      }).join('');
      setStatus(c.id, `<span class="text-danger fw-semibold">⚠️ ${features.length} waterloop/lopen aanwezig</span><br><table class="area-table w-100 mt-1"><thead><tr><th>Naam</th><th>Categorie</th><th>Beheerder</th></tr></thead><tbody>${rows}</tbody></table>`);
      try {
        const fl = L.geoJSON(toWgs84FeatureCollection(data), {
          pane: 'dataOverlayPane',
          style: { color: c.iconColor, weight: 2.5 },
          onEachFeature: (f, layer) => {
            const p = f.properties || {};
            const nm = p.NAAM || p.naam || 'Naam onbekend';
            const cat = p.CATC ?? p.catc ?? '?';
            layer.bindPopup(`<strong>${nm}</strong><br>Categorie: ${cat}`);
          }
        });
        attachDataLayer(c.id, fl);
      } catch {}
    } catch (e) {
      setBadge(c.id, 's-manual', 'VISUEEL');
      setStatus(c.id, `Automatische check niet beschikbaar. (${e.message.substring(0,60)})`, 'text-muted');
      showActions(c.id);
    }
    return;
  }

  // ── SPECIAL: Watertalk (ArcGIS REST) ──
  if (c.specialType === 'watertalk') {
    try {
      const data = await arcgisQuery(c.arcgisUrl, c.arcgisLayerId, currentParcel.bboxL72, c.arcgisFields, c.queryBufferM ?? 25);
      const features = data.features || [];
      activeCheckResults[c.id] = { data, features };
      showActions(c.id);
      if (!features.length) {
        setBadge(c.id, 's-notfound', 'GEEN');
        setStatus(c.id, c.notFoundMsg || 'Geen waterlopen (of buiten West-Vlaanderen)', 'text-success');
        return;
      }
      setBadge(c.id, 's-found', 'AANWEZIG');
      const rows = features.slice(0,6).map(f => {
        const p = f.properties || {};
        return `<tr><td>${p.naam || '—'}</td><td>Cat. ${p.catc ?? '?'}</td><td style="font-size:0.72rem">${p.behe || ''}</td></tr>`;
      }).join('');
      setStatus(c.id, `<span class="text-danger fw-semibold">⚠️ ${features.length} waterloop/lopen (Watertalk WV)</span><br><table class="area-table w-100 mt-1"><thead><tr><th>Naam</th><th>Cat.</th><th>Beheerder</th></tr></thead><tbody>${rows}</tbody></table>`);
      try {
        const fl = L.geoJSON(toWgs84FeatureCollection(data), {
          pane: 'dataOverlayPane',
          style: { color: c.iconColor, weight: 2.5 },
          onEachFeature: (f, layer) => {
            const p = f.properties || {};
            const nm = p.naam || 'Naam onbekend';
            const cat = p.catc ?? '?';
            layer.bindPopup(`<strong>${nm}</strong><br>Categorie: ${cat}`);
          }
        });
        attachDataLayer(c.id, fl);
      } catch {}
    } catch (e) {
      setBadge(c.id, 's-manual', 'VISUEEL');
      setStatus(c.id, `Automatische check niet beschikbaar. (${e.message.substring(0,60)})`, 'text-muted');
      showActions(c.id);
    }
    return;
  }

  // ── SPECIAL: Trage Wegen Wijzigingen (ArcGIS REST) ──
  if (c.arcgisUrl && !c.wfsUrl) {
    try {
      const data = await arcgisQuery(c.arcgisUrl, c.arcgisLayerId, currentParcel.bboxL72, c.arcgisFields, c.queryBufferM ?? 25);
      const features = data.features || [];
      activeCheckResults[c.id] = { data, features };
      showActions(c.id);
      if (!features.length) {
        setBadge(c.id, 's-notfound', 'GEEN');
        setStatus(c.id, c.notFoundMsg || 'Geen wijzigingen geregistreerd', 'text-success');
        return;
      }
      setBadge(c.id, 's-found', 'GEVONDEN');
      const rows = features.slice(0,5).map(f => {
        const p = f.properties || {};
        const datum = p.DATUM_BESLUIT ? new Date(p.DATUM_BESLUIT).toLocaleDateString('nl-BE') : '—';
        return `<tr><td>${p.TYPE_WIJZIGING || '—'}</td><td>${p.BESLISSING || '—'}</td><td style="font-size:0.72rem">${datum}</td></tr>`;
      }).join('');
      setStatus(c.id, `<span class="text-danger fw-semibold">⚠️ ${features.length} wijziging(en) geregistreerd</span><br><table class="area-table w-100 mt-1"><thead><tr><th>Type</th><th>Beslissing</th><th>Datum</th></tr></thead><tbody>${rows}</tbody></table>`);
      try {
        const fl = L.geoJSON(toWgs84FeatureCollection(data), { pane: 'dataOverlayPane', style: { color: c.iconColor, weight: 2.5 } });
        attachDataLayer(c.id, fl);
      } catch {}
    } catch (e) {
      setBadge(c.id, 's-manual', 'VISUEEL');
      setStatus(c.id, `Automatische check niet beschikbaar. (${e.message.substring(0,60)})`, 'text-muted');
      showActions(c.id);
    }
    return;
  }

  // WFS AUTO CHECK (standaard)
  if (!c.wfsUrl || !c.wfsType) {
    setBadge(c.id, 's-manual', 'VISUEEL');
    setStatus(c.id, 'Visuele controle via kaartlaag.', 'text-muted');
    showActions(c.id);
    return;
  }

  try {
    const data = await wfsQuery(c.wfsUrl, c.wfsType, currentParcel.bboxL72, c.queryBufferM ?? 20);
    const n = data.features?.length ?? 0;
    activeCheckResults[c.id] = { data, features: data.features || [], count: n };
    showActions(c.id);

    if (n > 0) {
      setBadge(c.id, 's-found', 'GEVONDEN');
      setStatus(c.id, c.foundMsg ? c.foundMsg(n) : `${n} object(en) gevonden`, 'text-danger fw-semibold');
      try {
        const fl = L.geoJSON(toWgs84FeatureCollection(data), {
          pane: 'dataOverlayPane',
          style:        { color: c.iconColor, weight: 2.5, fillOpacity: 0.25 },
          pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 7, color: c.iconColor, fillOpacity: 0.5 })
        });
        attachDataLayer(c.id, fl);
      } catch {}
    } else {
      setBadge(c.id, 's-notfound', 'NIET GEVONDEN');
      setStatus(c.id, c.notFoundMsg || 'Niet aangetroffen in de omgeving', 'text-success');
    }
  } catch (e) {
    setBadge(c.id, 's-manual', 'VISUEEL');
    setStatus(c.id, `Automatische check niet beschikbaar — controleer kaartlaag. (${e.message.substring(0,60)})`, 'text-muted');
    showActions(c.id);
  }
}

// ════════════════════════════════════════════════════
// EXPORT RAPPORT
// ════════════════════════════════════════════════════
async function exportRapport() {
  if (!currentParcel) { alert('Eerst een perceel opzoeken.'); return; }
  const reportButton = document.querySelector('button[onclick="exportRapport()"]');
  const originalButtonHtml = reportButton?.innerHTML;
  if (reportButton) {
    reportButton.disabled = true;
    reportButton.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Rapport maken';
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  const checks = getChecksForCurrentParcel();
  const rows = makePdfReportRows(checks);
  const attentionCount = rows.filter(row => /AANWEZIG|GEVONDEN|NAZICHT|AWV/.test(row.badge)).length;
  const manualCount = rows.filter(row => /VISUEEL|CHECK|MANUEEL|CAPAKEY|ONBEKEND/.test(row.badge)).length;

  doc.setProperties({
    title: `Perceelrapport ${currentParcel.capaKey || currentParcel.addressLabel || 'locatie'}`,
    subject: 'Vooronderzoek klassieke opmeting',
    author: 'Buro Eyckmans',
    creator: 'Perceel Checker'
  });

  addPdfHeader(doc, 'Perceel Checker', 'Buro Eyckmans | Vooronderzoek klassieke opmeting');
  let y = 37;
  y = addPdfSection(doc, 'Perceelgegevens', y);

  const metadata = [
    ['Adres / locatie', currentParcel.addressLabel || currentParcel.searchInput || 'Niet bepaald'],
    ['CaPaKey', currentParcel.capaKey || 'Niet automatisch bepaald'],
    ['Gemeente', currentParcel.municipality || 'Niet bepaald'],
    ['Provincie', currentParcel.province || 'Niet bepaald'],
    ['GRB-oppervlakte', currentParcel.area_grb ? `${Math.round(currentParcel.area_grb).toLocaleString('nl-BE')} m2` : 'Niet beschikbaar'],
    ['Rapportdatum', new Date().toLocaleString('nl-BE')]
  ];
  for (const [label, value] of metadata) {
    const valueLines = doc.splitTextToSize(String(value), 133);
    const rowHeight = Math.max(7, valueLines.length * 4.2 + 2);
    doc.setFillColor(y % 2 ? 250 : 246, 247, 248);
    doc.rect(14, y - 4.5, 182, rowHeight, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(76, 82, 88);
    doc.text(label, 18, y);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(32, 38, 45);
    doc.text(valueLines, 59, y);
    y += rowHeight;
  }

  y += 5;
  y = addPdfSection(doc, 'Samenvatting', y);
  const summaryCards = [
    ['CONTROLES', String(rows.length), [32, 38, 45]],
    ['AANDACHT', String(attentionCount), [151, 45, 35]],
    ['MANUEEL NAZICHT', String(manualCount), [110, 117, 124]],
    ['OPENBARE VERSIE', 'ZONDER DOSSIERS', [39, 118, 83]]
  ];
  summaryCards.forEach(([label, value, color], index) => {
    const x = 14 + index * 46;
    doc.setFillColor(...color);
    doc.roundedRect(x, y, 43, 17, 1.5, 1.5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(value, x + 21.5, y + 7, { align: 'center' });
    doc.setFontSize(6.5);
    doc.text(label, x + 21.5, y + 13, { align: 'center' });
  });

  y += 25;
  try {
    y = writePdfRows(doc, rows, y);
    await appendMapExtracts(doc, checks);
    addPdfFooter(doc);
    doc.save(`perceelrapport_${(currentParcel.capaKey || 'locatie').replace(/[^a-z0-9]/gi, '_')}.pdf`);
    return doc;
  } finally {
    if (reportButton) {
      reportButton.disabled = false;
      reportButton.innerHTML = originalButtonHtml;
    }
  }
}

// ════════════════════════════════════════════════════
// CLEAR ALL
// ════════════════════════════════════════════════════
function clearAll() {
  if (parcelLayer) { map.removeLayer(parcelLayer); parcelLayer = null; }
  for (const l of Object.values(activeWmsLayers))  map.removeLayer(l);
  for (const l of Object.values(activeDataLayers)) map.removeLayer(l);
  activeWmsLayers  = {};
  activeDataLayers = {};
  desiredLayerVisibility = {};
  currentParcel    = null;
  document.getElementById('searchInput').value = '';
  document.getElementById('parseHint').textContent = '';
  document.getElementById('checksPanel').innerHTML = `
    <div class="p-4 text-center" style="color:#94a3b8; margin-top:20px;">
      <i class="bi bi-search" style="font-size:2.5rem; display:block; margin-bottom:12px;"></i>
      <p class="mb-1 fw-semibold">Voer een CaPaKey of adres in</p>
      <small class="d-block mb-2">Voorbeeld: <code>34022A0345/00C000</code></small>
    </div>`;
  map.setView([51.0, 3.8], 9);
}
