const SERVICE_BASE_URLS = Object.freeze({
  cadgis: 'https://eservices.minfin.fgov.be/ecad-backend-rest',
  basisregisters: 'https://api.basisregisters.vlaanderen.be',
  nominatim: 'https://nominatim.openstreetmap.org',
  photon: 'https://photon.komoot.io',
});

const ALLOWED_METHODS = new Set(['GET', 'POST', 'OPTIONS']);

function writeCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
}

function getRouteParts(request) {
  const route = request.query.route;
  return Array.isArray(route) ? route : String(route || '').split('/').filter(Boolean);
}

function getRequestBody(request) {
  if (request.body == null) return undefined;
  if (Buffer.isBuffer(request.body) || typeof request.body === 'string') return request.body;
  return JSON.stringify(request.body);
}

module.exports = async function handler(request, response) {
  writeCorsHeaders(response);

  if (!ALLOWED_METHODS.has(request.method)) {
    response.setHeader('Allow', [...ALLOWED_METHODS].join(', '));
    return response.status(405).json({ error: 'Methode niet toegestaan.' });
  }
  if (request.method === 'OPTIONS') return response.status(204).end();

  const [service, ...pathParts] = getRouteParts(request);
  const baseUrl = SERVICE_BASE_URLS[service];
  if (!baseUrl || !pathParts.length) {
    return response.status(400).json({ error: 'Onbekende of onvolledige proxyroute.' });
  }

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query)) {
    if (key === 'route' || key === 'source') continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }

  const targetUrl = `${baseUrl}/${pathParts.map(encodeURIComponent).join('/')}${query.size ? `?${query}` : ''}`;
  const contentType = request.headers['content-type'] || 'application/json';

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: {
        Accept: request.headers.accept || 'application/json',
        'Content-Type': contentType,
        'User-Agent': 'PerceelChecker/5.0 (github.com/pieterdsmt/perceelchecker)',
      },
      body: request.method === 'POST' ? getRequestBody(request) : undefined,
      signal: AbortSignal.timeout(20000),
    });

    const payload = Buffer.from(await upstream.arrayBuffer());
    response.status(upstream.status);
    response.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    if (request.method === 'GET' && upstream.ok) {
      response.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    }
    return response.send(payload);
  } catch (error) {
    return response.status(502).json({
      error: 'Externe databron tijdelijk niet bereikbaar.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
};