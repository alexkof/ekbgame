#!/usr/bin/env python3
"""Подготовка данных карты из OpenStreetMap.

Команды:
  extract <pbf>                     сохранить срез OSM для карты в scripts/map/osm/ekb.osm.pbf
  layers  [pbf]                     пересобрать базовые слои src/map/data/layers/*
  straighten                        пересчитать поле спрямления по layers/roads.json (без OSM)
  roads-geojson <файл>              выгрузить граф улиц в GeoJSON (посмотреть в geojson.io)
  find    [pbf] <lat> <lon> [r_m]   найти объекты OSM рядом с точкой (для поиска id)
  outline [pbf] <w123|r456> ...     контур объекта: в градусах и в метрах от центра
  building [pbf] <w123|r456> --id <id> [--kind building] [--name …] [--emphasis 1]
                                    здание из OSM → модель models/<id>.json и объект карты
  quarter [pbf] art/quarters/<id>.json
                                    все здания квартала → модели и объекты карты

Без аргумента pbf команды читают срез из репозитория (scripts/map/osm/ekb.osm.pbf), поэтому
скачивать выгрузку нужно, только чтобы обновить данные OSM. Полная выгрузка области:
https://download.openstreetmap.fr/extracts/russia/ural_federal_district/
(sverdlovsk_oblast-latest.osm.pbf). Зависимости: pip install -r scripts/map/requirements.txt

Правила отбора (что попадает на карту) — константы ниже. Детализация зависит от зоны:
в центре больше улиц и мелких объектов, на окраинах — только магистрали и крупные
водоёмы/лесопарки. Упрощение линий делается в «игровых» координатах (после радиального
сжатия), поэтому погрешность на экране одинакова и в центре, и на окраинах.
Формулы проекции должны совпадать с src/map/projection.ts. Граф улиц — roads.py,
поле спрямления — straighten.py.
"""

import argparse
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import osmium
import shapely
from shapely import geometry as sg
from shapely import ops
from shapely import wkb as swkb

import buildings
import roads
import straighten

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'src' / 'map' / 'data'
CONFIG = json.loads((DATA / 'config.json').read_text(encoding='utf-8'))
SNAPSHOT = ROOT / 'scripts' / 'map' / 'osm' / 'ekb.osm.pbf'

# ---------------------------------------------------------------- проекция

LON0 = CONFIG['origin']['lon']
LAT0 = CONFIG['origin']['lat']
_phi = math.radians(LAT0)
M_PER_DEG_LAT = 111132.954 - 559.822 * math.cos(2 * _phi) + 1.175 * math.cos(4 * _phi)
M_PER_DEG_LON = 111412.84 * math.cos(_phi) - 93.5 * math.cos(3 * _phi)
WARP_R = CONFIG['warp']['radius']
WARP_Q = CONFIG['warp']['power']
EXTENT = CONFIG['warp']['extent']
ZONES = {z['id']: z['radius'] for z in CONFIG['zones']}


def to_local(lon, lat):
    """Градусы → метры от начала координат (x — восток, y — север)."""
    return (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT


def to_geo(x, y):
    return LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT


def tangential_scale(r):
    return (1 + (r / WARP_R) ** 2) ** (-WARP_Q / 2)


def warp(x, y):
    """Радиальное сжатие: центр 1:1, к окраинам масштаб плавно уменьшается."""
    s = tangential_scale(math.hypot(x, y))
    return x * s, y * s


def to_world0(x, y):
    """Реальные метры → мир до спрямления (радиальное сжатие, ось Y на юг, как в TS)."""
    s = tangential_scale(math.hypot(x, y))
    return x * s, -y * s


def unwarp_radius(rw):
    """Мировой радиус → реальный (метод Ньютона, как unwarpRadius в projection.ts)."""
    if rw <= 0:
        return 0.0
    r = rw
    for _ in range(40):
        u2 = (r / WARP_R) ** 2
        f = r * tangential_scale(r) - rw
        d = tangential_scale(r) * (1 + u2 * (1 - WARP_Q)) / (1 + u2)
        nxt = r - f / d
        r = nxt if nxt > 0 else r / 2
        if abs(f) < 1e-9:
            break
    return r


def from_world0(X, Y):
    rw = math.hypot(X, Y)
    if rw == 0:
        return 0.0, 0.0
    k = unwarp_radius(rw) / rw
    return X * k, -Y * k


def zone_of(r):
    if r < ZONES['center']:
        return 'center'
    if r < ZONES['middle']:
        return 'middle'
    return 'outskirts'


# ---------------------------------------------------------- правила отбора

# Основные улицы центра и срединной зоны (остальные — только магистрали trunk/primary).
MAIN_STREETS = {
    'проспект Ленина',
    'улица Малышева',
    'улица Куйбышева',
    'улица Челюскинцев',
    'Первомайская улица',
    'улица Радищева',
    'улица 8 Марта',
    'улица Карла Либкнехта',
    'улица Луначарского',
    'Московская улица',
    'Восточная улица',
    'улица Белинского',
    'улица Розы Люксембург',
    'улица Свердлова',
    'улица Бориса Ельцина',
    'улица Мамина-Сибиряка',
    'улица Сакко и Ванцетти',
    'улица Репина',
    'улица Татищева',
    'улица Шейнкмана',
    'улица Декабристов',
    'улица Шевченко',
    'Макаровский мост',
    'улица Толмачёва',
    'улица Мира',
}
# Улицы, которые рисуются как главные проспекты независимо от класса в OSM.
AVENUES = {
    'проспект Ленина',
    'улица Малышева',
    'улица 8 Марта',
    'улица Куйбышева',
    'улица Луначарского',
    'Московская улица',
    'улица Челюскинцев',
    'Восточная улица',
    'Макаровский мост',
}
# Трамвайные пути показываем только вдоль этих улиц (ключевые линии центра).
TRAM_STREETS = {
    'проспект Ленина',
    'улица Луначарского',
    'улица 8 Марта',
    'улица Куйбышева',
    'улица Челюскинцев',
    'улица Свердлова',
    'Макаровский мост',
    'улица Карла Либкнехта',
    'Первомайская улица',
    'улица Малышева',
}
TRAM_RADIUS = 3500  # дальше трамвай не показываем

# Дороги для автомобилей (всё остальное — тротуары, дворы, тропинки — в граф не входит).
MOTORABLE = {
    'motorway',
    'trunk',
    'primary',
    'secondary',
    'tertiary',
    'unclassified',
    'residential',
    'living_street',
    'motorway_link',
    'trunk_link',
    'primary_link',
    'secondary_link',
    'tertiary_link',
}
MAJOR = {'motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link'}
# По этим классам определяется, вдоль какой улицы идёт трамвайный путь.
TRAM_GUIDE = {'trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link'}
CONNECTOR = 250  # короткие связки (мосты и т. п.) между выбранными улицами, мировые м

# Минимальная площадь (м²) по зонам: center / middle / outskirts.
MIN_AREA = {
    'water': (3_000, 30_000, 150_000),
    'park': (5_000, 40_000, 250_000),
    'forest': (20_000, 100_000, 500_000),
    'plaza': (2_500, 1e12, 1e12),
}
SIMPLIFY_AREA = 4.0  # допуск упрощения контуров, «игровые» метры

# Срез OSM в репозитории: что сохраняем (радиусы — реальные метры от центра).
SNAPSHOT_RADIUS = EXTENT + 2000  # улицы, рельсы, вода, зелень (с запасом за край карты)
SNAPSHOT_BUILDINGS = 3000  # здания и их части — для команд find/outline/building


def area_kind(tags):
    if tags.get('natural') == 'water' or tags.get('landuse') in ('reservoir', 'basin'):
        return 'water'
    if tags.get('waterway') == 'riverbank':
        return 'water'
    if tags.get('leisure') in ('park', 'garden') and tags.get('access') != 'private':
        return 'park'
    if tags.get('landuse') == 'forest' or tags.get('natural') == 'wood':
        return 'forest'
    if tags.get('place') == 'square' or (
        tags.get('highway') == 'pedestrian' and tags.get('area') == 'yes' and 'name' in tags
    ):
        return 'plaza'
    return None


def norm_name(name):
    if name.startswith('Улица '):
        return 'улица ' + name[6:]
    return name


# ------------------------------------------------------------ геометрия


def geom_local(g):
    return shapely.transform(g, lambda c: np.column_stack(to_local(c[:, 0], c[:, 1])))


def geom_world0(g):
    """Реальные метры → мир до спрямления (векторно)."""

    def f(c):
        s = (1 + (np.hypot(c[:, 0], c[:, 1]) / WARP_R) ** 2) ** (-WARP_Q / 2)
        return np.column_stack((c[:, 0] * s, -c[:, 1] * s))

    return shapely.transform(g, f)


dp_indices = roads.dp_indices


def simplify_coords(coords, tol):
    """coords — в локальных метрах; упрощение в сжатых координатах; ответ — в градусах."""
    warped = [warp(x, y) for x, y in coords]
    idx = dp_indices(warped, tol)
    return [rnd(to_geo(*coords[i])) for i in idx]


def rnd(p, digits=5):
    return [round(p[0], digits), round(p[1], digits)]


def lines_of(g):
    if g.is_empty:
        return []
    if g.geom_type == 'LineString':
        return [g]
    if g.geom_type in ('MultiLineString', 'GeometryCollection'):
        return [x for x in g.geoms if x.geom_type == 'LineString']
    return []


def polys_of(g):
    if g.is_empty:
        return []
    if g.geom_type == 'Polygon':
        return [g]
    if g.geom_type in ('MultiPolygon', 'GeometryCollection'):
        return [x for x in g.geoms if x.geom_type == 'Polygon']
    return []


def poly_to_geo(p, tol):
    rings = []
    for i, ring in enumerate([p.exterior, *p.interiors]):
        c = simplify_coords(list(ring.coords), tol)
        if len(c) < 4:
            if i == 0:
                return None
            continue
        rings.append(c)
    return rings


EXTENT_CIRCLE = sg.Point(0, 0).buffer(EXTENT, 64)


# ---------------------------------------------------------------- чтение


class Collector(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.wkb = osmium.geom.WKBFactory()
        self.roads = []  # {'name', 'highway', 'oneway', 'line' (LineString local)}
        self.tram = []
        self.subway = []
        self.rail = []
        self.areas = []  # (kind, name, Polygon local)
        self.stations = []  # (name, x, y)
        self.places = []  # (name, place, x, y)

    def _line(self, w):
        try:
            g = swkb.loads(self.wkb.create_linestring(w), hex=True)
        except Exception:
            return None
        return geom_local(g)

    def way(self, w):
        t = w.tags
        hw = t.get('highway')
        rw = t.get('railway')
        if hw in MOTORABLE:
            g = self._line(w)
            if g is not None:
                oneway = t.get('oneway')
                if oneway == '-1':
                    g = g.reverse()
                self.roads.append(
                    {
                        'name': norm_name(t.get('name', '')),
                        'highway': hw,
                        'oneway': oneway in ('yes', '1', '-1') or t.get('junction') == 'roundabout',
                        'line': g,
                    }
                )
        elif rw == 'tram' and t.get('service') is None:
            g = self._line(w)
            if g is not None:
                self.tram.append(g)
        elif rw == 'subway' and t.get('service') is None:
            g = self._line(w)
            if g is not None:
                self.subway.append(g)
        elif rw == 'rail' and t.get('usage') == 'main' and t.get('service') is None:
            g = self._line(w)
            if g is not None:
                self.rail.append(g)

    def area(self, a):
        kind = area_kind(a.tags)
        if kind is None:
            return
        try:
            g = geom_local(swkb.loads(self.wkb.create_multipolygon(a), hex=True))
        except Exception:
            return
        name = a.tags.get('name', '')
        sub = a.tags.get('water', '') if kind == 'water' else ''
        for p in polys_of(g):
            self.areas.append((kind, name, sub, p))

    def node(self, n):
        t = n.tags
        if t.get('station') == 'subway' and t.get('railway') == 'station':
            x, y = to_local(n.location.lon, n.location.lat)
            self.stations.append((t.get('name', ''), x, y))
        if t.get('place') in ('suburb',) and 'name' in t:
            x, y = to_local(n.location.lon, n.location.lat)
            self.places.append((t.get('name'), t.get('place'), x, y))


def feature(geom_type, coords, props):
    return {
        'type': 'Feature',
        'properties': props,
        'geometry': {'type': geom_type, 'coordinates': coords},
    }


SOURCE = '© участники OpenStreetMap, ODbL. Сгенерировано scripts/map/osm_tool.py'


def write_json(name, obj):
    path = DATA / 'layers' / name
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return path


def prettier(*paths):
    """Привести JSON к виду, который ждёт npm run check (если установлены зависимости npm)."""
    if (ROOT / 'node_modules' / '.bin' / 'prettier').exists():
        subprocess.run(['npx', 'prettier', '--write', '--log-level', 'warn', *map(str, paths)], cwd=ROOT, check=False)


def write_layer(name, features, comment):
    fc = {
        'type': 'FeatureCollection',
        'name': name,
        'description': comment,
        'source': SOURCE,
        'features': features,
    }
    path = write_json(f'{name}.geo.json', fc)
    print(f'{path.relative_to(ROOT)}: {len(features)} объектов', file=sys.stderr)


def street_rank(name, hw):
    if name in AVENUES or hw in ('motorway', 'trunk'):
        return 1
    if hw in ('primary', 'secondary'):
        return 2
    return 3


# ------------------------------------------------------------ граф улиц


def select_roads(all_roads):
    """Улицы для графа: основные улицы центра и срединной зоны, магистрали — везде.

    К ним добавляются короткие связки между ними (мосты с собственным названием и т. п.),
    иначе в улице остаётся разрыв.
    """
    origin = sg.Point(0, 0)
    chosen, rest = [], []
    for r in all_roads:
        d = r['line'].distance(origin)
        if d > EXTENT + 500:
            continue
        main = r['name'] in MAIN_STREETS and d < ZONES['middle']
        if main or (r['highway'] in MAJOR and r['name']):
            chosen.append({**r, 'line': geom_world0(r['line'])})
        elif r['highway'] not in ('residential', 'unclassified', 'living_street'):
            rest.append(r)
    corridor = shapely.unary_union([w['line'].buffer(roads.CORRIDOR) for w in chosen])
    shapely.prepare(corridor)
    extra = []
    for r in rest:
        line = geom_world0(r['line'])
        if line.length > CONNECTOR:
            continue
        a = sg.Point(line.coords[0])
        b = sg.Point(line.coords[-1])
        if corridor.contains(a) and corridor.contains(b) and not corridor.contains(line):
            extra.append({**r, 'line': line})
    return chosen + extra


def build_roads(c):
    """Граф улиц и поле спрямления → layers/roads.json и layers/straighten.json."""
    ways = select_roads(c.roads)
    tram = [geom_world0(g) for g in c.tram]

    def center_dist(X, Y):
        return math.hypot(*from_world0(X, Y))

    net = roads.build(ways, tram, from_world0, center_dist)
    nodes_real = [from_world0(*p) for p in net.nodes]
    groups = [{'perpendicular': gr['perpendicular']} for gr in net.groups]
    streets = [
        {
            'name': s['name'],
            'rank': street_rank(s['name'], s['cls']),
            'class': s['cls'],
            'oneway': s['oneway'],
            'tram': s['tram'],
            'nodes': s['nodes'],
        }
        for s in net.streets
    ]
    write_roads(nodes_real, streets, net.lines, groups)


def write_roads(nodes_real, streets, lines, groups):
    """Поле спрямления по прямым линиям, узлы линий — точно на прямые; запись обоих файлов."""
    field, normals, offsets = straighten.build(nodes_real, lines, groups, to_world0)
    field = straighten.decode(straighten.encode(straighten.crop(field)))
    world0 = [to_world0(*p) for p in nodes_real]
    snapped = straighten.snap(world0, lines, normals, offsets, field)
    nodes_real = [from_world0(*p) for p in snapped]

    # Группам — читаемые описания: реальный азимут (от севера по часовой) и главные улицы.
    used = [g for g in range(len(groups)) if any(ln['group'] == g for ln in lines)]
    renum = {g: i for i, g in enumerate(used)}
    out_groups = []
    for g in used:
        names = {}
        sx = sy = 0.0
        for ln in lines:
            if ln['group'] != g:
                continue
            a = nodes_real[ln['nodes'][0]]
            b = nodes_real[ln['nodes'][-1]]
            t = 2 * math.atan2(b[0] - a[0], b[1] - a[1])  # удвоенный азимут: прямая без стороны
            sx += math.dist(a, b) * math.cos(t)
            sy += math.dist(a, b) * math.sin(t)
            for s in streets:
                if ln['nodes'][0] in s['nodes'] and ln['nodes'][1] in s['nodes'] and s['name']:
                    names[s['name']] = names.get(s['name'], 0) + math.dist(a, b)
                    break
        item = {
            'azimuth': round(math.degrees(math.atan2(sy, sx) / 2) % 180, 1),
            'streets': [n for n, _ in sorted(names.items(), key=lambda kv: -kv[1])],
        }
        pj = groups[g]['perpendicular']
        if pj is not None and pj in renum:
            item['perpendicular'] = renum[pj]
        out_groups.append(item)

    doc = {
        'name': 'roads',
        'description': (
            'Граф улиц: узлы [долгота, широта] и улицы — цепочки узлов (индексы в nodes). '
            'Улицы с общим узлом пересекаются. lines — прямые участки: их узлы на карте лежат '
            'на одной прямой; линии одной группы (groups) параллельны. rank: 1 — проспект/'
            'магистраль, 2 — улица, 3 — малая; oneway: 1 — движение по порядку узлов, '
            '−1 — против; tram — по улице идёт трамвай. Подробно — docs/MAP.md, «Граф улиц».'
        ),
        'source': SOURCE,
        'nodes': [rnd(to_geo(*p), 7) for p in nodes_real],
        'streets': [
            {
                'name': s['name'],
                'rank': s['rank'],
                'class': s['class'],
                **({'oneway': s['oneway']} if s.get('oneway') else {}),
                **({'tram': True} if s.get('tram') else {}),
                'nodes': s['nodes'],
            }
            for s in streets
        ],
        'lines': [{'group': renum[ln['group']], 'nodes': ln['nodes']} for ln in lines],
        'groups': out_groups,
    }
    path = write_json('roads.json', doc)
    print(
        f'{path.relative_to(ROOT)}: {len(doc["nodes"])} узлов, {len(doc["streets"])} улиц, '
        f'{len(doc["lines"])} прямых в {len(out_groups)} группах',
        file=sys.stderr,
    )
    x0, y0, nx, ny, cell, D = field
    grid = {
        'description': (
            'Поле спрямления: смещение (dx, dy) мировых координат после радиального сжатия, '
            'чтобы прямые улицы были прямыми, а параллельные — параллельными. Сетка nx × ny '
            'с шагом cell от (x0, y0); data — base64 Int16 little-endian, по строкам, '
            'пары dx, dy в единицах unit (м). Считается по roads.json (scripts/map/straighten.py) '
            'для параметров сжатия warp — при их изменении: osm_tool.py straighten.'
        ),
        'warp': {'radius': WARP_R, 'power': WARP_Q},
        **straighten.encode(field),
    }
    path = write_json('straighten.json', grid)
    mags = np.linalg.norm(D, axis=2)
    print(
        f'{path.relative_to(ROOT)}: сетка {nx}×{ny} по {cell:.0f} м, '
        f'смещение до {mags.max():.0f} м',
        file=sys.stderr,
    )


def cmd_straighten():
    """Пересчитать поле по roads.json (после ручной правки графа или параметров сжатия)."""
    doc = json.loads((DATA / 'layers' / 'roads.json').read_text(encoding='utf-8'))
    nodes_real = [to_local(*p) for p in doc['nodes']]
    groups = [{'perpendicular': g.get('perpendicular')} for g in doc['groups']]
    write_roads(nodes_real, doc['streets'], doc['lines'], groups)


def cmd_roads_geojson(out):
    doc = json.loads((DATA / 'layers' / 'roads.json').read_text(encoding='utf-8'))
    nodes = doc['nodes']
    feats = []
    for s in doc['streets']:
        props = {k: v for k, v in s.items() if k != 'nodes'}
        feats.append(feature('LineString', [nodes[k] for k in s['nodes']], props))
    for i, ln in enumerate(doc['lines']):
        coords = [nodes[k] for k in ln['nodes']]
        feats.append(feature('LineString', coords, {'line': i, 'group': ln['group']}))
    Path(out).write_text(
        json.dumps({'type': 'FeatureCollection', 'features': feats}, ensure_ascii=False) + '\n',
        encoding='utf-8',
    )
    print(f'{out}: {len(feats)} линий', file=sys.stderr)


# ---------------------------------------------------------------- слои


def build_layers(pbf):
    c = Collector()
    c.apply_file(str(pbf), locations=True)

    # --- граф улиц (вместо прежнего слоя streets.geo.json) и поле спрямления
    build_roads(c)

    # --- трамвай: только вдоль ключевых улиц
    named = [(r['name'], r['line']) for r in c.roads if r['name'] and r['highway'] in TRAM_GUIDE]
    tram_lines = []
    for g in c.tram:
        mid = g.interpolate(0.5, normalized=True)
        if mid.distance(sg.Point(0, 0)) > TRAM_RADIUS:
            continue
        best = min(named, key=lambda ng: ng[1].distance(mid), default=None)
        if best and best[0] in TRAM_STREETS and best[1].distance(mid) < 30:
            tram_lines.append(g)
    tram = []
    for ln in lines_of(ops.linemerge(tram_lines)):
        if ln.length < 40:
            continue
        tram.append(feature('LineString', simplify_coords(list(ln.coords), 1.5), {}))
    write_layer('tram', tram, 'Трамвайные пути ключевых линий (каждый путь — отдельная линия)')

    # --- метро и железная дорога
    metro = []
    for ln in lines_of(ops.linemerge(c.subway).intersection(EXTENT_CIRCLE)):
        metro.append(feature('LineString', simplify_coords(list(ln.coords), 4), {'kind': 'line'}))
    for name, x, y in sorted(c.stations, key=lambda s: -s[2]):
        if math.hypot(x, y) < EXTENT:
            metro.append(feature('Point', rnd(to_geo(x, y)), {'kind': 'station', 'name': name}))
    write_layer('metro', metro, 'Линия метро (под землёй) и станции')

    rail = []
    for ln in lines_of(ops.linemerge(c.rail).intersection(EXTENT_CIRCLE)):
        if ln.length < 200:
            continue
        rail.append(feature('LineString', simplify_coords(list(ln.coords), 4), {}))
    write_layer('rail', rail, 'Главные железнодорожные пути')

    # --- вода и зелень: порог площади растёт к окраинам
    zi = {'center': 0, 'middle': 1, 'outskirts': 2}
    water, land = [], []
    for kind, name, sub, p in c.areas:
        p = p.intersection(EXTENT_CIRCLE)
        for q in polys_of(p):
            r = q.distance(sg.Point(0, 0))
            limit = MIN_AREA[kind][zi[zone_of(r)]]
            if kind == 'water' and sub == 'river':
                limit = min(limit, 2_000)
            if q.area < limit:
                continue
            rings = poly_to_geo(q, SIMPLIFY_AREA)
            if rings is None:
                continue
            props = {'kind': sub or 'water'} if kind == 'water' else {'kind': kind}
            if name:
                props['name'] = name
            (water if kind == 'water' else land).append((q.area, feature('Polygon', rings, props)))
    # крупные — первыми, чтобы мелкие рисовались поверх
    write_layer('water', [f for _, f in sorted(water, key=lambda t: -t[0])], 'Водоёмы и реки')
    write_layer(
        'land',
        [f for _, f in sorted(land, key=lambda t: -t[0])],
        'Парки (park), лесопарки (forest), площади (plaza)',
    )

    # --- подписи районов (только за пределами центра)
    places = []
    for name, place, x, y in sorted(c.places):
        r = math.hypot(x, y)
        if ZONES['center'] < r < EXTENT:
            places.append(feature('Point', rnd(to_geo(x, y)), {'name': name}))
    write_layer('districts', places, 'Подписи жилых районов (видны на мелком масштабе)')


# ------------------------------------------------------------ срез OSM


def snapshot_way(tags):
    if tags.get('highway') in MOTORABLE | {'pedestrian'}:
        return True
    if tags.get('railway') in ('tram', 'rail', 'subway', 'light_rail'):
        return True
    if tags.get('waterway') in ('river', 'canal'):
        return True
    return area_kind(tags) is not None or tags.get('natural') in ('water', 'wood')


def cmd_extract(pbf, out):
    """Срез выгрузки OSM для карты: только нужное и только вокруг города (~3 МБ вместо ~100).

    Сохраняются дороги (кроме дворов и тропинок), рельсы, вода, зелень, площади, станции,
    подписи районов — в радиусе SNAPSHOT_RADIUS; здания и их части (building:part) — в радиусе
    SNAPSHOT_BUILDINGS.
    Объекты сохраняются целиком, вместе с точками и частями мультиполигонов.
    """

    def radius(lon, lat):
        return math.hypot(*to_local(lon, lat))

    near, keep = set(), set()
    for o in osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY).with_locations():
        if not o.is_way():
            continue
        try:
            r = min(radius(n.lon, n.lat) for n in o.nodes)
        except (osmium.InvalidLocationError, ValueError):
            continue
        if r > SNAPSHOT_RADIUS:
            continue
        near.add(o.id)
        is_building = 'building' in o.tags or 'building:part' in o.tags
        if snapshot_way(o.tags) or (is_building and r < SNAPSHOT_BUILDINGS):
            keep.add(o.id)
    rels = set()
    for o in osmium.FileProcessor(str(pbf), osmium.osm.RELATION):
        t = o.tags
        is_building = 'building' in t or 'building:part' in t
        if t.get('type') != 'multipolygon' or not (snapshot_way(t) or is_building):
            continue
        if any(m.type == 'w' and m.ref in near for m in o.members):
            rels.add(o.id)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with osmium.BackReferenceWriter(str(out), ref_src=str(pbf), overwrite=True) as w:
        for o in osmium.FileProcessor(str(pbf)).with_locations():
            if o.is_node():
                t = o.tags
                if (t.get('place') == 'suburb' or t.get('railway') == 'station') and radius(
                    o.lon, o.lat
                ) < SNAPSHOT_RADIUS:
                    w.add(o)
            elif o.is_way():
                if o.id in keep:
                    w.add(o)
            elif o.is_relation() and o.id in rels:
                w.add(o)
    header = osmium.io.Reader(str(pbf), osmium.osm.osm_entity_bits.NOTHING)
    stamp = header.header().get('osmosis_replication_timestamp') or 'неизвестно'
    header.close()
    print(
        f'{out}: {out.stat().st_size / 1e6:.1f} МБ, путей {len(keep)}, '
        f'мультиполигонов {len(rels)}; '
        f'данные OSM на {stamp}',
        file=sys.stderr,
    )


# ------------------------------------------------------- поиск и контуры


class Finder(osmium.SimpleHandler):
    def __init__(self, want=None, near=None):
        super().__init__()
        self.wkb = osmium.geom.WKBFactory()
        self.want = want or set()
        self.near = near
        self.found = []

    def area(self, a):
        key = ('w' if a.from_way() else 'r') + str(a.orig_id())
        if self.want and key not in self.want:
            return
        if self.near and not len(a.tags):
            return
        try:
            g = swkb.loads(self.wkb.create_multipolygon(a), hex=True)
        except Exception:
            return
        if self.near:
            x, y, rad = self.near
            gl = geom_local(g)
            d = gl.distance(sg.Point(x, y))
            if d > rad:
                return
            self.found.append((d, key, dict(a.tags), gl.area))
        else:
            self.found.append((key, dict(a.tags), g))

    def way(self, w):
        key = 'w' + str(w.id)
        if self.want and key in self.want and not w.is_closed():
            g = swkb.loads(self.wkb.create_linestring(w), hex=True)
            self.found.append((key, dict(w.tags), g))


def cmd_find(pbf, lat, lon, radius):
    x, y = to_local(lon, lat)
    f = Finder(near=(x, y, radius))
    f.apply_file(str(pbf), locations=True)
    for d, key, tags, area in sorted(f.found, key=lambda t: t[0]):
        short = {k: v for k, v in tags.items() if not k.startswith(('name:', 'contact', 'wiki'))}
        print(f'{d:6.0f} м  {key:12} {area:8.0f} м²  {short}')


def cmd_outline(pbf, ids):
    f = Finder(want=set(ids))
    f.apply_file(str(pbf), locations=True)
    for key, tags, g in f.found:
        gl = geom_local(g)
        cx, cy = gl.centroid.x, gl.centroid.y
        if g.geom_type == 'LineString':
            local = [[round(px - cx, 1), round(py - cy, 1)] for px, py in gl.coords]
            geo = [rnd(p) for p in g.coords]
        else:
            poly = max(polys_of(gl), key=lambda p: p.area)
            local = [[round(px - cx, 1), round(py - cy, 1)] for px, py in poly.exterior.coords]
            geo = [rnd(to_geo(px, py)) for px, py in poly.exterior.coords]
        out = {
            'id': key,
            'name': tags.get('name'),
            'centroid': rnd(to_geo(cx, cy)),
            'area': round(gl.area),
            'tags': {k: v for k, v in tags.items() if 'height' in k or 'level' in k},
            'geo': geo,
            'local': local,
        }
        print(json.dumps(out, ensure_ascii=False))


class BuildingReader(osmium.SimpleHandler):
    """Контуры зданий (нужных или всех) и все части зданий (building:part) — в локальных метрах."""

    def __init__(self, want=None):
        super().__init__()
        self.wkb = osmium.geom.WKBFactory()
        self.want = want
        self.found = {}
        self.parts = []

    def area(self, a):
        key = ('w' if a.from_way() else 'r') + str(a.orig_id())
        wanted = 'building' in a.tags if self.want is None else key in self.want
        if not wanted and 'building:part' not in a.tags:
            return
        try:
            g = geom_local(swkb.loads(self.wkb.create_multipolygon(a), hex=True))
        except Exception:
            return
        tags = dict(a.tags)
        if wanted:
            self.found[key] = (tags, g)
        if 'building:part' in tags:
            self.parts.append((key, tags, g))


def parts_of(keys, found, parts):
    """Части зданий keys: внутри контура (с допуском) хотя бы наполовину и не часть другого
    здания, в которое они попадают лучше (у соседних зданий контуры иногда перекрываются)."""
    zone = shapely.union_all([found[k][1] for k in keys]).buffer(1.0)
    out = []
    for pkey, ptags, g in parts:
        if pkey in keys or not zone.contains(g.representative_point()):
            continue
        if g.intersection(zone).area <= 0.5 * g.area:
            continue
        out.append((ptags, g))
    return out


def add_building(keys, found, all_parts, opts, avoid=None, override=False):
    """Модель src/map/data/models/<id>.json и объект в objects.geo.json по зданиям OSM keys
    (несколько контуров — одно здание, например две половины дома под одним адресом).
    avoid — контуры соседних зданий: участок на них не заходит. opts['tags'] — поправки к
    тегам OSM (например, высота по фото). Возвращает id."""
    if opts.get('tags'):
        found = {k: ({**v[0], **opts['tags']}, v[1]) if k in keys else v for k, v in found.items()}
    tags, outline = found[keys[0]]
    outlines = [found[k][1] for k in keys]
    main = max(polys_of(outline), key=lambda p: p.area)
    # Точка привязки — центр контура, а у «подковы» и «серпа» — самая глубокая точка внутри.
    c = main.centroid if main.contains(main.centroid) else ops.polylabel(main, 0.5)
    ox, oy = round(c.x, 1), round(c.y, 1)
    parts = parts_of(keys, found, all_parts)
    elements = parts if parts else [found[k] for k in keys]
    model_parts = buildings.model_parts(elements, tags, ox, oy)
    if not model_parts:
        print(f'{keys[0]}: пустая модель — пропущено', file=sys.stderr)
        return None
    # Цвета, сверенные с фото (файл квартала): стены и крыши всех частей.
    for part in model_parts:
        for k in ('color', 'roof'):
            if opts.get(k) and part['type'] == 'prism':
                part[k] = opts[k]
        if opts.get('roof') and part['type'] == 'dome':
            part['color'] = opts['roof']
    top = max(
        p['z'][1] + p.get('gable', p.get('hip', p.get('pyramid', 0)))
        for p in model_parts
        if p['type'] == 'prism'
    )
    levels = max((buildings.number(found[k][0].get('building:levels')) or 0 for k in keys), default=0)
    name = opts.get('name') or tags.get('name') or buildings.address(tags) or 'Дворовая постройка'
    osm = ', '.join(('way/' if k[0] == 'w' else 'relation/') + k[1:] for k in keys)

    path = DATA / 'models' / f'{opts["id"]}.json'
    model = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
    model.update(
        {
            'id': opts['id'],
            'name': model.get('name', name),
            'source': f'OSM {osm} (osm_tool.py): контур'
            + (f', части ({len(parts)})' if parts else '')
            + ', высоты и крыша'
            + (', цвета — по фото' if opts.get('color') else '')
            + f'; облик — рисунок art/{opts["id"]}/.',
            'parts': model_parts,
        }
    )
    if 'art' in model:  # рисунок остаётся; если геометрия изменилась, тесты это заметят
        model['art'] = model.pop('art')
    path.write_text(json.dumps(model, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    margin = opts.get('margin', 4.0)
    plot = shapely.union_all([g for _, g in elements] + outlines).buffer(margin, join_style='mitre')
    if avoid is not None:
        plot = plot.difference(avoid).union(shapely.union_all(outlines))
    plot = max(polys_of(plot), key=lambda p: p.area).simplify(0.5)
    props = {
        'id': opts['id'],
        'name': name,
        'kind': opts.get('kind', 'building'),
        'model': opts['id'],
        'anchor': rnd(to_geo(ox, oy), 6),
        'importance': opts.get('importance', 3),
        'ground': 'paving',
    }
    for k in ('label', 'emphasis'):
        if opts.get(k) not in (None, 1):
            props[k] = opts[k]
    if buildings.address(tags):
        props['address'] = buildings.address(tags)
    props['description'] = opts.get('description') or buildings.description(tags, top, levels)
    props['osm'] = osm
    objects_path = DATA / 'objects.geo.json'
    objects = json.loads(objects_path.read_text(encoding='utf-8'))
    feature_ = {
        'type': 'Feature',
        'properties': props,
        'geometry': {
            'type': 'Polygon',
            'coordinates': [[rnd(to_geo(x, y), 6) for x, y in plot.exterior.coords]],
        },
    }
    old = next((f for f in objects['features'] if f['properties']['id'] == opts['id']), None)
    if old:
        # Ручные правки свойств (подпись, описание, укрупнение) сохраняются; правки из файла
        # квартала (override) важнее их.
        explicit = {k: props[k] for k in ('name', 'label', 'kind', 'importance', 'description', 'emphasis') if override and k in opts and k in props}
        feature_['properties'] = {**props, **old['properties'], **explicit, 'anchor': props['anchor']}
        objects['features'][objects['features'].index(old)] = feature_
    else:
        objects['features'].append(feature_)
    objects_path.write_text(json.dumps(objects, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(
        f'{opts["id"]}: {len(model_parts)} частей, высота {top:.0f} м'
        + (f' (частей OSM: {len(parts)})' if parts else '')
        + f'; объект {"обновлён" if old else "добавлен"}',
        file=sys.stderr,
    )
    return opts['id']


def cmd_building(pbf, key, opts):
    """Здание из OSM: модель src/map/data/models/<id>.json и объект в objects.geo.json."""
    r = BuildingReader({key})
    r.apply_file(str(pbf), locations=True)
    if key not in r.found:
        sys.exit(f'{key}: не найден (в срезе — только здания в радиусе {SNAPSHOT_BUILDINGS} м)')
    o = {k: v for k, v in vars(opts).items() if v is not None and k not in ('cmd', 'args')}
    add_building([key], r.found, r.parts, o)
    prettier(DATA / 'models' / f'{opts.id}.json', DATA / 'objects.geo.json')


TRANSLIT = dict(
    zip(
        'абвгдеёжзийклмнопрстуфхцчшщъыьэюя',
        'a b v g d e e zh z i y k l m n o p r s t u f kh ts ch sh shch _ y _ e yu ya'.split(),
    )
)


def slug(text):
    """Латиницей через дефис: «Карла Либкнехта 23А» → karla-libknekhta-23a."""
    out = ''.join(TRANSLIT.get(ch, ch) for ch in text.lower()).replace('_', '')
    return re.sub(r'[^a-z0-9]+', '-', out).strip('-')


def address_slug(tags):
    street = tags.get('addr:street', '')
    street = re.sub(r'^(улица|проспект|переулок|площадь|бульвар) | (улица|переулок)$', '', street)
    return slug(f'{street} {tags.get("addr:housenumber", "")}')


def monument_model(m):
    """Памятник: постамент и статуя (значок «статуя»); размеры — в файле квартала."""
    w, d, h = m.get('pedestal', [2.4, 2.4, 3.2])
    return {
        'id': m['id'],
        'name': m['name'],
        'source': f'OSM {m["osm"]}: точка; постамент и статуя — по фото (файл квартала).',
        'parts': [
            {
                'type': 'prism',
                'outline': [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]],
                'z': [0, h],
                'color': m.get('color', '#8b8178'),
                'facade': 'none',
            },
            {'type': 'sign', 'kind': 'statue', 'at': [0, 0, h], 'size': m.get('statue', 3.2), 'color': m.get('statueColor', '#4f5a52')},
        ],
    }


def cmd_quarter(pbf, path):
    """Все здания квартала (art/quarters/<id>.json): модели и объекты карты.

    Файл квартала — граница (polygon, [долгота, широта]) и правки по зданиям (buildings:
    OSM-ключ → id, имя, тип, важность, описание; with — другие контуры того же здания;
    skip — не брать). Здания, которых в файле нет, получают id по адресу и записываются в
    файл, поэтому повторный запуск даёт те же id. Модели, доведённые вручную (в файле
    "keep": true или уже есть объект с этим id не из этого квартала), не перезаписываются.
    """
    path = Path(path)
    q = json.loads(path.read_text(encoding='utf-8'))
    area = sg.Polygon([to_local(*p) for p in q['polygon']])
    r = BuildingReader()
    r.apply_file(str(pbf), locations=True)
    inside = {
        k: v
        for k, v in r.found.items()
        if area.contains(v[1].representative_point())
        and (v[1].area >= q.get('min_area', 40) or k in q.get('buildings', {}))
    }
    conf = q.setdefault('buildings', {})
    merged = {m for c in conf.values() for m in c.get('with', [])}
    objects = json.loads((DATA / 'objects.geo.json').read_text(encoding='utf-8'))
    existing = {f['properties']['id'] for f in objects['features']}
    used = set(existing)
    order = sorted(inside, key=lambda k: (-inside[k][1].centroid.y, inside[k][1].centroid.x))
    ids = []
    unnamed = 0
    for key in order:
        if key in merged:
            continue
        c = conf.setdefault(key, {})
        if c.get('skip'):
            continue
        tags = inside[key][0]
        if 'id' not in c:
            base = slug(tags['name']) if tags.get('name') and not tags.get('addr:street') else address_slug(tags)
            if not base:
                unnamed += 1
                base = f'{q["id"]}-{unnamed}'
            cid, n = base, 2
            while cid in used:
                cid, n = f'{base}-{n}', n + 1
            c['id'] = cid
        used.add(c['id'])
        ids.append(c['id'])
        if c.get('keep'):
            print(f'{c["id"]}: модель доведена вручную — не трогаю', file=sys.stderr)
            continue
        keys = [key, *c.get('with', [])]
        others = [inside[k][1] for k in inside if k not in keys]
        opts = {'importance': 4, 'margin': q.get('margin', 2.0), **c}
        add_building(keys, r.found, r.parts, opts, avoid=shapely.union_all(others) if others else None, override=True)
    # Памятники и другие объекты-точки.
    for m in q.get('monuments', []):
        mpath = DATA / 'models' / f'{m["id"]}.json'
        mpath.write_text(json.dumps(monument_model(m), ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        x, y = to_local(*m['at'])
        plot = sg.Point(x, y).buffer(m.get('plot', 6), 8)
        feature_ = {
            'type': 'Feature',
            'properties': {
                'id': m['id'],
                'name': m['name'],
                'kind': 'monument',
                'model': m['id'],
                'anchor': rnd(m['at'], 6),
                'importance': m.get('importance', 3),
                'ground': 'paving',
                'description': m.get('description', ''),
                'osm': m['osm'],
            },
            'geometry': {'type': 'Polygon', 'coordinates': [[rnd(to_geo(px, py), 6) for px, py in plot.exterior.coords]]},
        }
        objects = json.loads((DATA / 'objects.geo.json').read_text(encoding='utf-8'))
        objects['features'] = [f for f in objects['features'] if f['properties']['id'] != m['id']] + [feature_]
        (DATA / 'objects.geo.json').write_text(json.dumps(objects, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        ids.append(m['id'])
        print(f'{m["id"]}: памятник', file=sys.stderr)
    q['objects'] = ids
    path.write_text(json.dumps(q, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    prettier(DATA / 'models', DATA / 'objects.geo.json', path)
    print(f'{path.name}: {len(ids)} объектов', file=sys.stderr)


def pbf_and_rest(args):
    """Первый аргумент — файл .pbf, если он так выглядит; иначе — срез из репозитория."""
    if args and args[0].endswith('.pbf'):
        return Path(args[0]), args[1:]
    if not SNAPSHOT.exists():
        sys.exit(f'Нет среза {SNAPSHOT.relative_to(ROOT)}: укажите выгрузку .osm.pbf')
    return SNAPSHOT, args


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('extract')
    p.add_argument('pbf')
    p.add_argument('out', nargs='?', default=str(SNAPSHOT))
    p = sub.add_parser('layers')
    p.add_argument('args', nargs='*')
    sub.add_parser('straighten')
    p = sub.add_parser('roads-geojson')
    p.add_argument('out')
    p = sub.add_parser('find')
    p.add_argument('args', nargs='+')
    p = sub.add_parser('outline')
    p.add_argument('args', nargs='+')
    p = sub.add_parser('building')
    p.add_argument('args', nargs='+', help='[pbf] w123|r456')
    p.add_argument('--id', required=True, help='id модели и объекта (латиницей, через дефис)')
    p.add_argument('--kind', default='building')
    p.add_argument('--name')
    p.add_argument('--label')
    p.add_argument('--emphasis', type=float, default=1.0)
    p.add_argument('--importance', type=int, default=3)
    p.add_argument('--margin', type=float, default=4.0, help='отступ участка от здания, м')
    p = sub.add_parser('quarter')
    p.add_argument('args', nargs='+', help='[pbf] art/quarters/<id>.json')
    a = ap.parse_args()
    if a.cmd == 'extract':
        cmd_extract(a.pbf, a.out)
    elif a.cmd == 'layers':
        pbf, _ = pbf_and_rest(a.args)
        build_layers(pbf)
    elif a.cmd == 'straighten':
        cmd_straighten()
    elif a.cmd == 'roads-geojson':
        cmd_roads_geojson(a.out)
    elif a.cmd == 'find':
        pbf, rest = pbf_and_rest(a.args)
        lat, lon = float(rest[0]), float(rest[1])
        cmd_find(pbf, lat, lon, float(rest[2]) if len(rest) > 2 else 60)
    elif a.cmd == 'building':
        pbf, rest = pbf_and_rest(a.args)
        cmd_building(pbf, rest[0], a)
    elif a.cmd == 'quarter':
        pbf, rest = pbf_and_rest(a.args)
        cmd_quarter(pbf, rest[0])
    else:
        pbf, rest = pbf_and_rest(a.args)
        cmd_outline(pbf, rest)


if __name__ == '__main__':
    main()
