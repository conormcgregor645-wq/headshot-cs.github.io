# Скачивает картинки скинов и наклеек из Steam CDN в img/sk/<id>.webp
import os, sys, io, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
os.makedirs('img/sk', exist_ok=True)
items = [l.split() for l in open('tools/sklist.txt') if l.strip()]
todo = [(i, u) for i, u in items if not os.path.exists(f'img/sk/{i}.webp')]
print('всего', len(items), 'скачать', len(todo))
def get(job):
    i, u = job
    for t in range(4):
        try:
            req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
            data = urllib.request.urlopen(req, timeout=30).read()
            im = Image.open(io.BytesIO(data)).convert('RGBA')
            im.thumbnail((160, 160) if ('128fx128f' in u or '/stickers/' in u) else (360, 270))
            im.save(f'img/sk/{i}.webp', 'WEBP', quality=86, method=6)
            return True
        except Exception as e:
            time.sleep(1 + t * 2)
    print('не скачалось', u, file=sys.stderr)
    return False
with ThreadPoolExecutor(16) as ex:
    ok = sum(ex.map(get, todo))
print('готово', ok)
