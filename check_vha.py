import urllib.request, json

for tn in ['VHAWaterlopen:Wlas', 'VHAWaterlopen:VhaCattraj', 'VHAWaterlopen:VHAG']:
    url = ('https://geo.api.vlaanderen.be/VHAWaterlopen/wfs'
           '?SERVICE=WFS&VERSION=2.0.0&REQUEST=DescribeFeatureType'
           '&TYPENAMES=' + tn + '&outputFormat=application/json')
    req = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=15) as r:
        d = json.loads(r.read())
    print('=== ' + tn + ' ===')
    for ft in d.get('featureTypes', []):
        for p in ft.get('properties', []):
            print('  ' + p['name'].ljust(35) + p['type'])
    print()
