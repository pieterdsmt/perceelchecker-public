import urllib.request, json

url = 'https://www.geoloket.be/Geocortex/Essentials/REST/sites/Mobiliteit/map/mapservices?f=json'
req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=10) as r:
    data = json.loads(r.read().decode('utf-8'))

for svc in data['mapServices']:
    conn = svc.get('connectionString','')
    print(svc['displayName'] + ': ' + conn[:130])
    for lyr in svc.get('layers', []):
        nm = lyr.get('name','').lower()
        if any(kw in nm for kw in ['trage','buurt','wegen','atlas','wijk','wijzig']):
            print('  >> LAAG: ' + lyr['name'] + ' nativeID=' + str(lyr.get('nativeID','')))
