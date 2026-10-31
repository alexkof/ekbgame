#!/usr/bin/env python3
"""Рисунки зданий: каркас и запрос для генератора изображений → рисунок → спрайт на карте.

Методика — docs/ART.md, инструкция для рисующего — art/README.md.

Команды:
  prepare <id> [<id> …]   каркас (guide.png и др.), ссылки на фото, запрос — art/<id>/README.md
  import  <id> [рисунок]  рисунок из art/<id>/drawn/ → src/map/data/models/<id>/art.webp
                          и поле "art" в модели (по умолчанию — последний добавленный рисунок)
  import  --new           все рисунки, которые ещё не стоят на карте (так работает CI)
  readme  [<id> …]        пересобрать README (после правки info.json или style.txt)
  status                  что нарисовано, что нет, что устарело

Модель здания (src/map/data/models/<id>.json) — промежуточный шаг: из неё каркас для
генератора, силуэт для вырезания фона, тень и выбор детализации. Модели зданий из OSM
делает scripts/map/osm_tool.py building.

Зависимости: prepare — Node.js, npm-зависимости проекта и Playwright (Chromium); import —
pip install opencv-python-headless numpy (scripts/art/requirements.txt).
"""

import argparse
import json
import math
import re
import struct
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / 'art'
DATA = ROOT / 'src' / 'map' / 'data'
MODELS = DATA / 'models'
REPO = 'https://github.com/alexkof/ekbgame'
SITE = 'https://alexkof.github.io/ekbgame'

MAX_PPM = 16  # больше на карте не нужно: максимальный зум 6 × экран 2x × укрупнение ~1,3
DRAWN = ('.png', '.jpg', '.jpeg', '.webp')
# Вырезание фона: внутри силуэта модели (с запасом INNER) рисунок сохраняется целиком,
# дальше (до OUTER) — только то, что нарисовано не на фоне: башенки, шпили, декор, которых
# нет в модели. Доли ширины холста.
INNER = 0.004
OUTER = 0.05


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def prettier(*paths):
    if (ROOT / 'node_modules' / '.bin' / 'prettier').exists():
        subprocess.run(
            ['npx', 'prettier', '--write', '--log-level', 'warn', *map(str, paths)],
            cwd=ROOT,
            check=False,
        )


def rel(path):
    return Path(path).resolve().relative_to(ROOT).as_posix()


# ------------------------------------------------------------ модель и объект


def model_of(mid):
    path = MODELS / f'{mid}.json'
    if not path.exists():
        sys.exit(f'Нет модели {rel(path)}: сначала osm_tool.py building … --id {mid}')
    return load(path)


def object_of(mid):
    """Объект карты, который по умолчанию стоит на этой модели (свойства из objects.geo.json)."""
    for f in load(DATA / 'objects.geo.json')['features']:
        if f['properties'].get('model') == mid:
            return f['properties']
    return {}


SKIP = {'color', 'roof', 'facade', 'floor', 'bays', 'skins', 'text'}


def js_json(v):
    """JSON.stringify(parts, replacer) — побайтно как в artGeometryKey (src/map/model.ts)."""
    if isinstance(v, dict):
        items = (f'{json.dumps(k, ensure_ascii=False)}:{js_json(x)}' for k, x in v.items() if k not in SKIP)
        return '{' + ','.join(items) + '}'
    if isinstance(v, list):
        return '[' + ','.join(js_json(x) for x in v) + ']'
    if v is True or v is False:
        return 'true' if v else 'false'
    if v is None:
        return 'null'
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else repr(v)
    if isinstance(v, int):
        return str(v)
    return json.dumps(v, ensure_ascii=False)


def geometry_key(model):
    """Отпечаток геометрии модели (FNV-1a по UTF-16, как artGeometryKey в model.ts)."""
    s = js_json(model['parts']).encode('utf-16-le')
    h1, h2 = 0x811C9DC5, 0x01000193
    for (c,) in struct.iter_unpack('<H', s):
        h1 = ((h1 ^ c) * 0x01000193) & 0xFFFFFFFF
        h2 = ((h2 ^ c) * 0x050C5D1F) & 0xFFFFFFFF
    return f'{h1:08x}{h2:08x}'


# Камера (как в config.json): смотрим с юга сверху, высоты наклонены вправо — видны южные
# и западные стены. Направление «на зрителя» по земле: (−a, −c/t).
CONFIG = load(DATA / 'config.json')
_cam = CONFIG['camera']
VIEW_DIR = (-_cam['lean'] * _cam['heightFactor'], -_cam['heightFactor'] / _cam['groundTilt'])
SIDES = ['востоку', 'северо-востоку', 'северу', 'северо-западу', 'западу', 'юго-западу', 'югу', 'юго-востоку']


def visible_walls(model):
    """Сколько метров стен какой стороной света обращено к зрителю."""
    sides = {}
    for p in model['parts']:
        if p['type'] != 'prism':
            continue
        o = p['outline']
        area = sum(o[i][0] * o[(i + 1) % len(o)][1] - o[(i + 1) % len(o)][0] * o[i][1] for i in range(len(o)))
        if area < 0:
            o = o[::-1]
        for i, a in enumerate(o):
            b = o[(i + 1) % len(o)]
            L = math.dist(a, b)
            if L < 1:
                continue
            nx, ny = (b[1] - a[1]) / L, -(b[0] - a[0]) / L
            if nx * VIEW_DIR[0] + ny * VIEW_DIR[1] <= 0.05:
                continue
            k = round(math.degrees(math.atan2(ny, nx)) / 45) % 8
            sides[SIDES[k]] = sides.get(SIDES[k], 0) + L
    return sorted(sides.items(), key=lambda kv: -kv[1])


# ----------------------------------------------------------------- фото


def osm_tags(osm):
    """Теги объекта OSM из среза (нужен osmium); пусто, если не получилось."""
    try:
        sys.path.insert(0, str(ROOT / 'scripts' / 'map'))
        import osm_tool  # noqa: E402
    except Exception as e:  # нет osmium/shapely — обойдёмся без тегов
        print(f'теги OSM недоступны ({e})', file=sys.stderr)
        return {}
    kind, ident = osm.split('/')
    key = ('w' if kind == 'way' else 'r') + ident
    f = osm_tool.Finder(want={key})
    f.apply_file(str(osm_tool.SNAPSHOT), locations=True)
    return f.found[0][1] if f.found else {}


def wikidata(qid):
    url = f'https://www.wikidata.org/wiki/Special:EntityData/{qid}.json'
    req = urllib.request.Request(url, headers={'User-Agent': f'ekbgame-art/1.0 ({REPO})'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r)['entities'][qid]
    except Exception as e:
        print(f'Викиданные {qid}: {e}', file=sys.stderr)
        return None


def commons(name, kind='File'):
    return f'https://commons.wikimedia.org/wiki/{kind}:' + urllib.parse.quote(name.replace(' ', '_'))


def photo_links(info, props):
    """Где искать фото: Викисклад и Википедия (по Викиданным), панорамы, история, поиск."""
    links = []
    tags = info.get('osm_tags', {})
    qid = tags.get('wikidata')
    entity = wikidata(qid) if qid else None
    if entity:
        claims = entity.get('claims', {})
        for c in claims.get('P18', []):
            name = c['mainsnak'].get('datavalue', {}).get('value')
            if name:
                links.append({'title': f'Викисклад: {name}', 'url': commons(name)})
        for c in claims.get('P373', []):
            cat = c['mainsnak'].get('datavalue', {}).get('value')
            if cat:
                links.append({'title': f'Викисклад: категория «{cat}»', 'url': commons(cat, 'Category')})
        wiki = entity.get('sitelinks', {}).get('ruwiki', {}).get('title')
        if wiki:
            links.append({'title': f'Википедия: {wiki}', 'url': 'https://ru.wikipedia.org/wiki/' + urllib.parse.quote(wiki.replace(' ', '_'))})
    if tags.get('wikimedia_commons'):
        v = tags['wikimedia_commons']
        kind, _, name = v.partition(':')
        links.append({'title': f'Викисклад: {v}', 'url': commons(name, kind)})
    lon, lat = props.get('anchor', [None, None])
    if lon:
        links += [
            {'title': 'Яндекс Панорамы (найдите вид с юга или юго-запада)', 'url': f'https://yandex.ru/maps/?ll={lon}%2C{lat}&z=18&l=stv%2Csta'},
            {'title': 'Google Street View', 'url': f'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat}%2C{lon}'},
            {'title': 'PastVu — старые фото', 'url': f'https://pastvu.com/?g={lat},{lon}&z=18&s=osm&t=mapnik&type=1'},
        ]
    query = ' '.join(x for x in [props.get('name'), props.get('address'), 'Екатеринбург'] if x)
    links.append({'title': 'Яндекс Картинки', 'url': 'https://yandex.ru/images/search?text=' + urllib.parse.quote(query)})
    if props.get('osm'):
        links.append({'title': f'OpenStreetMap: {props["osm"]}', 'url': f'https://www.openstreetmap.org/{props["osm"]}'})
    return links


# --------------------------------------------------------------- запрос


def size_name(size):
    w, h = size
    if w == h:
        return f'квадрат {w}×{h}'
    return f'{"горизонтальный 3:2" if w > h else "вертикальный 2:3"}, {w}×{h}'


def prompt(mid, model, props, info, frame):
    style = (ART / 'style.txt').read_text(encoding='utf-8').strip()
    name = props.get('name') or model['name']
    about = [name]
    if props.get('address'):
        about.append(props['address'])
    about.append('Екатеринбург')
    facts = []
    tags = info.get('osm_tags', {})
    if tags.get('start_date'):
        facts.append(f'построено: {tags["start_date"].replace("..", "–").replace(";", ", ")}')
    if tags.get('architect'):
        facts.append(f'архитектор: {tags["architect"].replace(";", ", ")}')
    if tags.get('building:levels'):
        facts.append(f'этажей: {tags["building:levels"]}')
    top = max((p['z'][1] for p in model['parts'] if 'z' in p and isinstance(p['z'], list)), default=0)
    facts.append(f'высота стен до {top:.0f} м')
    walls = visible_walls(model)
    seen = ', '.join(f'к {s} ({L:.0f} м)' for s, L in walls[:3]) or 'южные и западные'
    lines = [
        f'Нарисуй здание «{", ".join(about)}» для карты-игры.',
        '',
        'Картинка 1 — каркас: 3D-модель здания в проекции нашей карты. Это точная геометрия и кадр.',
        'Остальные картинки — фотографии этого здания: облик, цвета, материалы, окна, декор.',
        '',
        'Как рисовать:',
        f'- Формат — {size_name(frame["size"])}, как у картинки 1. Сохрани кадр картинки 1: та же камера, то же положение, размер и силуэт здания. Не поворачивай, не сдвигай, не масштабируй, не добавляй перспективу: вертикали остаются вертикальными и наклонены вправо так же, как на каркасе, параллельные линии остаются параллельными.',
        '- Нарисуй по каркасу настоящее здание по фотографиям: материалы, цвет, окна, двери, карнизы, декор, форму и цвет крыши. Мелкие детали (башенки, купола, шпили, балконы, козырьки), которых нет на каркасе, добавь, если они есть на фото.',
        f'- Камера смотрит с юга сверху. На каркасе видны стены, обращённые {seen}. На фото может быть другая сторона здания: рисуй те стены, что видны на каркасе, — как они выглядят в жизни; если их нет на фото, додумай в том же стиле.',
        '- Свет сверху с юго-юго-востока: стены, обращённые на юг (на картинке — нижние), светлые; западные (левые) — в тени.',
        '- Фон — сплошной чисто-белый. Без земли и травы вокруг, без падающих теней, деревьев, людей, машин, подписей и рамки.',
        f'- Стиль: {style}',
    ]
    if facts:
        lines += ['', 'О здании: ' + '; '.join(facts) + '.']
    if info.get('notes'):
        lines += ['', 'Важно: ' + info['notes'].strip()]
    return '\n'.join(lines)


# ---------------------------------------------------------------- README


def drawings(mid):
    d = ART / mid / 'drawn'
    files = [p for p in d.iterdir() if p.suffix.lower() in DRAWN] if d.exists() else []

    def added(p):  # время добавления в git (в CI время файлов одинаковое)
        try:
            out = subprocess.run(
                ['git', 'log', '-1', '--format=%ct', '--', str(p)], cwd=ROOT, capture_output=True, text=True
            ).stdout.strip()
        except OSError:
            out = ''
        return (int(out) if out else 2**40, p.stat().st_mtime, p.name)

    return sorted(files, key=added)


def chosen_drawing(mid, info):
    if info.get('use'):
        p = ART / mid / info['use']
        if not p.exists():
            sys.exit(f'art/{mid}/info.json: нет файла {info["use"]}')
        return p
    files = drawings(mid)
    return files[-1] if files else None


def readme(mid):
    model = model_of(mid)
    props = object_of(mid)
    info_path = ART / mid / 'info.json'
    info = load(info_path) if info_path.exists() else {}
    frame = load(ART / mid / 'frame.json')
    name = props.get('name') or model['name']
    art = model.get('art')
    stale = frame['geometry'] != geometry_key(model)
    rows = [('Модель', f'[`models/{mid}.json`](../../src/map/data/models/{mid}.json)')]
    if props.get('address'):
        rows.append(('Адрес', props['address']))
    if props.get('osm'):
        rows.append(('OSM', f'[{props["osm"]}](https://www.openstreetmap.org/{props["osm"]})'))
    rows.append(('Каркас', f'{frame["size"][0]}×{frame["size"][1]}, {frame["ppm"]} px/м' + (' — **устарел: модель изменилась, нужен `art.py prepare`**' if stale else '')))
    if art:
        ok = art['geometry'] == geometry_key(model)
        rows.append(('Рисунок', f'[`{art["image"]}`](../../src/map/data/models/{art["image"]}) из `{art.get("source", "?")}`' + ('' if ok else ' — **устарел: модель изменилась**')))
    else:
        rows.append(('Рисунок', 'ещё нет'))
    table = '\n'.join(['| | |', '| --- | --- |'] + [f'| {k} | {v} |' for k, v in rows])
    photos = '\n'.join(f'- [{p["title"]}]({p["url"]})' for p in info.get('photos', []))
    own = sorted(p.name for p in (ART / mid / 'photos').glob('*') if p.suffix.lower() in DRAWN) if (ART / mid / 'photos').exists() else []
    if own:
        photos += '\n' + '\n'.join(f'- [photos/{n}](photos/{n})' for n in own)
    text = f"""# {name}

<!-- Файл собирает scripts/art/art.py readme: правьте info.json (заметки, фото) и style.txt. -->

{table}

![Каркас](guide.png)

## Как нарисовать

1. Скачайте каркас [`guide.png`](guide.png) (на странице файла — кнопка «Download raw file»).
   Если генератор плохо держит форму, попробуйте [`guide-lines.png`](guide-lines.png) или
   [`guide-clay.png`](guide-clay.png).
2. Подберите 1–3 фото здания (ссылки ниже), лучше — с юга или юго-запада.
3. В ChatGPT: приложите каркас **первым**, потом фото, и вставьте запрос. Если есть удачный
   рисунок другого здания, приложите его последним и допишите: «Стиль — как на последней
   картинке».
4. Сохраните результат и загрузите его в папку [`drawn/`]({REPO}/upload/main/art/{mid}/drawn)
   (Add file → Upload files). Через пару минут рисунок встанет на карту:
   {SITE}/ (а проверка совмещения — `check.jpg` в этой папке).

## Запрос

```text
{prompt(mid, model, props, info, frame)}
```

## Фото

{photos or '—'}
"""
    if (ART / mid / 'check.jpg').exists():
        text += '\n## Проверка совмещения\n\nРисунок на карте; красным — контуры каркаса.\n\n![Проверка](check.jpg)\n'
    (ART / mid / 'README.md').write_text(text, encoding='utf-8')
    return name, bool(art), stale


def index():
    """Список зданий в art/README.md (между отметками)."""
    rows = []
    for d in sorted(p for p in ART.iterdir() if (p / 'frame.json').exists()):
        model = model_of(d.name)
        props = object_of(d.name)
        art = model.get('art')
        status = 'нарисовано' if art else 'ждёт рисунка'
        if art and art['geometry'] != geometry_key(model):
            status = 'рисунок устарел'
        rows.append(f'| [{props.get("name") or model["name"]}]({d.name}/) | `{d.name}` | {status} |')
    path = ART / 'README.md'
    text = path.read_text(encoding='utf-8')
    start, end = '<!-- здания -->', '<!-- /здания -->'
    table = '\n'.join(['| Здание | id | Состояние |', '| --- | --- | --- |'] + rows)
    text = re.sub(re.escape(start) + '.*?' + re.escape(end), f'{start}\n\n{table}\n\n{end}', text, flags=re.S)
    path.write_text(text, encoding='utf-8')


# ---------------------------------------------------------------- команды


def cmd_prepare(ids):
    r = subprocess.run(['node', 'scripts/art/render.mjs', *ids], cwd=ROOT)
    if r.returncode:
        sys.exit(r.returncode)
    for mid in ids:
        d = ART / mid
        (d / 'drawn').mkdir(exist_ok=True)
        keep = d / 'drawn' / '.gitkeep'
        if not any(d.joinpath('drawn').iterdir()):
            keep.write_text('')
        info_path = d / 'info.json'
        info = load(info_path) if info_path.exists() else {'notes': '', 'photos': []}
        props = object_of(mid)
        if 'osm_tags' not in info and props.get('osm'):
            tags = osm_tags(props['osm'])
            keys = ('name', 'addr:street', 'addr:housenumber', 'start_date', 'architect', 'building', 'building:levels', 'height', 'building:colour', 'building:material', 'roof:shape', 'roof:colour', 'roof:material', 'wikidata', 'wikimedia_commons', 'heritage')
            info['osm_tags'] = {k: tags[k] for k in keys if k in tags}
        if not info.get('photos'):
            info['photos'] = photo_links(info, props)
        save(info_path, info)
        prettier(info_path, d / 'frame.json')
        readme(mid)
    index()
    prettier(*(ART / mid / 'README.md' for mid in ids), ART / 'README.md')


def cmd_readme(ids):
    ids = ids or [p.name for p in sorted(ART.iterdir()) if (p / 'frame.json').exists()]
    for mid in ids:
        readme(mid)
    index()
    prettier(*(ART / mid / 'README.md' for mid in ids), ART / 'README.md')


def cmd_status():
    for d in sorted(p for p in ART.iterdir() if (p / 'frame.json').exists()):
        model = model_of(d.name)
        frame = load(d / 'frame.json')
        art = model.get('art')
        files = drawings(d.name)
        line = f'{d.name:24} рисунков: {len(files):2}  '
        if frame['geometry'] != geometry_key(model):
            line += 'каркас устарел (prepare)  '
        if not art:
            line += 'на карте модель' + (' — есть новый рисунок (import)' if files else '')
        else:
            line += f'на карте рисунок {art.get("source")}'
            if art['geometry'] != geometry_key(model):
                line += ' — устарел (prepare + import)'
            elif files and art.get('source') != rel(files[-1]):
                line += f' — есть новее: {files[-1].name}'
        print(line)


def cmd_import(mid, drawing, align=True):
    import art_import  # OpenCV нужен только здесь

    model_path = MODELS / f'{mid}.json'
    model = model_of(mid)
    d = ART / mid
    frame = load(d / 'frame.json')
    if frame['geometry'] != geometry_key(model):
        sys.exit(f'art/{mid}: каркас нарисован по старой модели — сначала art.py prepare {mid}')
    info = load(d / 'info.json') if (d / 'info.json').exists() else {}
    src = Path(drawing) if drawing else chosen_drawing(mid, info)
    if not src:
        sys.exit(f'art/{mid}/drawn/: рисунков нет')
    out_dir = MODELS / mid
    out_dir.mkdir(exist_ok=True)
    result = art_import.process(
        src,
        guide=d / 'guide.png',
        mask=d / 'mask.png',
        frame=frame,
        out=out_dir / 'art.webp',
        check=d / 'check.jpg',
        align=align,
        inner=INNER,
        outer=OUTER,
        max_ppm=MAX_PPM,
    )
    model['art'] = {
        'image': f'{mid}/art.webp',
        'size': result['size'],
        'origin': result['origin'],
        'ppm': result['ppm'],
        'geometry': frame['geometry'],
        'source': rel(src) if src.resolve().is_relative_to(ROOT) else src.name,
    }
    save(model_path, model)
    prettier(model_path)
    readme(mid)
    index()
    prettier(d / 'README.md', ART / 'README.md')
    print(f'{rel(out_dir / "art.webp")}: {result["size"][0]}×{result["size"][1]}, {result["ppm"]} px/м; {result["note"]}')


def cmd_import_new():
    """Все рисунки, которые ещё не стоят на карте (или поменялся выбор в info.json)."""
    done = 0
    for d in sorted(p for p in ART.iterdir() if (p / 'frame.json').exists()):
        model = load(MODELS / f'{d.name}.json')
        info = load(d / 'info.json') if (d / 'info.json').exists() else {}
        src = chosen_drawing(d.name, info)
        if src and (model.get('art') or {}).get('source') != rel(src):
            cmd_import(d.name, None)
            done += 1
    print(f'новых рисунков: {done}')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('ids', nargs='+')
    p = sub.add_parser('import')
    p.add_argument('id', nargs='?')
    p.add_argument('drawing', nargs='?')
    p.add_argument('--new', action='store_true')
    p.add_argument('--no-align', action='store_true')
    p = sub.add_parser('readme')
    p.add_argument('ids', nargs='*')
    sub.add_parser('status')
    a = ap.parse_args()
    if a.cmd == 'prepare':
        cmd_prepare(a.ids)
    elif a.cmd == 'readme':
        cmd_readme(a.ids)
    elif a.cmd == 'status':
        cmd_status()
    elif a.new:
        cmd_import_new()
    elif a.id:
        cmd_import(a.id, a.drawing, align=not a.no_align)
    else:
        ap.error('import <id> [рисунок] или import --new')


if __name__ == '__main__':
    main()
