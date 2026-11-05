# Цены с market.csgo.com (USD) -> tools/prices_market.json
import json, urllib.request
req = urllib.request.Request('https://market.csgo.com/api/v2/prices/USD.json', headers={'User-Agent': 'Mozilla/5.0'})
d = json.load(urllib.request.urlopen(req, timeout=120))
out = {}
for x in d.get('items', []):
    n = x.get('market_hash_name') or ''
    if n.startswith(('Souvenir ', 'Sticker |', 'Graffiti', 'Patch', 'Music Kit', 'Charm')): continue
    try: out[n] = float(x['price'])
    except Exception: pass
json.dump(out, open('tools/prices_market.json', 'w'), ensure_ascii=False, separators=(',', ':'), sort_keys=True)
print('цен', len(out))
