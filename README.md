# Perceel Checker - openbare versie

Browsertool voor het vooronderzoek bij klassieke opmetingen in Vlaanderen.

## Functies

- Zoeken op adres, kaartpunt of CAPAKEY.
- Automatische perceelsgeometrie en kadastrale oppervlakte.
- Buurtwegen, ruilverkaveling, wegenbeheer en waterlopen.
- PDF-rapport met vaste resultatentabel en compacte kaartuittreksels.
- Geen rioleringscontrole.

Deze openbare versie bevat geen interne dossiermodule, dossierdata, adressenbestand of Excelimport.

## Lokaal starten

Dubbelklik op `Start-PerceelChecker.bat` of voer uit:

```powershell
py -3 perceel_checker_server.py 8767
```

Open daarna `http://127.0.0.1:8767`.

## Online

De bronrepository staat openbaar op GitHub. De app gebruikt Vercel voor de website en de serverless proxy naar CadGIS, Basisregisters, Nominatim en Photon. GitHub Pages alleen kan deze proxy niet uitvoeren.

```powershell
npm install
npx vercel login
npm run deploy
```

## Validatie

```powershell
npm run check
```

De gegevens zijn uitsluitend bedoeld voor vooronderzoek. Terreincontrole en verificatie bij de officiële bron blijven vereist.