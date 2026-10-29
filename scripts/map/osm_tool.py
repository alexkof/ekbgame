#!/usr/bin/env python3
"""Подготовка данных карты из выгрузки OpenStreetMap (.osm.pbf).

Команды:
  layers  <pbf>                     пересобрать базовые слои src/map/data/layers/*.geo.json
  find    <pbf> <lat> <lon> [r_m]   найти объекты OSM рядом с точкой (для поиска id)
  outline <pbf> <w123|r456> ...     контур объекта: в градусах и в метрах от центра

Выгрузка: https://download.openstreetmap.fr/extracts/russia/ural_federal_district/
(sverdlovsk_oblast-latest.osm.pbf). Зависимости: pip install -r scripts/map/requirements.txt

Правила отбора (что попадает на карту) — константы ниже. Детализация зависит от зоны:
в центре больше улиц и мелких объектов, на окраинах — только магистрали и крупные
водоёмы/лесопарки. Упрощение линий делается в «игровых» координатах (после радиального
сжатия), поэтому погрешность на экране одинакова и в центре, и на окраинах.
Формулы проекции должны совпадать с src/map/projection.ts.
"""

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import osmium
import shapely
from shapely import geometry as sg
from shapely import ops
from shapely import wkb as swkb

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'src' / 'map' / 'data'
CONFIG = json.loads((DATA / 'config.json').read_text(encoding='utf-8'))

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

# Минимальная площадь (м²) по зонам: center / middle / outskirts.
MIN_AREA = {
    'water': (3_000, 30_000, 150_000),
    'park': (5_000, 40_000, 250_000),
    'forest': (20_000, 100_000, 500_000),
    'plaza': (2_500, 1e12, 1e12),
}
SIMPLIFY = 2.0  # допуск упрощения, «игровые» метры
SIMPLIFY_AREA = 4.0


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


def dp_indices(pts, tol):
    """Дуглас — Пекер, возвращает индексы сохраняемых точек."""
    n = len(pts)
    if n < 3:
        return list(range(n))
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * (px - ax) - dx * (py - ay)) / L
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [i for i in range(n) if keep[i]]


def simplify_coords(coords, tol):
    """coords — в локальных метрах; упрощение в сжатых координатах; ответ — в градусах."""
    warped = [warp(x, y) for x, y in coords]
    idx = dp_indices(warped, tol)
    return [rnd(to_geo(*coords[i])) for i in idx]


def rnd(p):
    return [round(p[0], 5), round(p[1], 5)]


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
        self.streets = []  # (name, highway, LineString local)
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
        if hw in ('trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link'):
            g = self._line(w)
            if g is not None:
                self.streets.append((norm_name(t.get('name', '')), hw, g))
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


def write_layer(name, features, comment):
    path = DATA / 'layers' / f'{name}.geo.json'
    fc = {
        'type': 'FeatureCollection',
        'name': name,
        'description': comment,
        'source': '© участники OpenStreetMap, ODbL. Сгенерировано scripts/map/osm_tool.py',
        'features': features,
    }
    path.write_text(json.dumps(fc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{path.relative_to(ROOT)}: {len(features)} объектов', file=sys.stderr)


def street_rank(name, hw):
    if name in AVENUES or hw in ('trunk', 'trunk_link'):
        return 1
    if hw in ('primary', 'primary_link', 'secondary'):
        return 2
    return 3


def build_layers(pbf):
    c = Collector()
    c.apply_file(pbf, locations=True)

    # --- улицы: в центре и срединной зоне — список основных, дальше — магистрали
    groups = {}
    for name, hw, g in c.streets:
        r = g.distance(sg.Point(0, 0))
        major = hw in ('trunk', 'primary', 'trunk_link', 'primary_link')
        if name in MAIN_STREETS and r < ZONES['middle']:
            pass
        elif major and name:
            pass
        else:
            continue
        key = (name, street_rank(name, hw))
        groups.setdefault(key, []).append(g)
    streets = []
    for (name, rank), lines in sorted(groups.items()):
        merged = ops.linemerge(lines)
        for ln in lines_of(merged.intersection(EXTENT_CIRCLE)):
            if ln.length < 60:
                continue
            coords = simplify_coords(list(ln.coords), SIMPLIFY)
            streets.append(feature('LineString', coords, {'name': name, 'rank': rank}))
    write_layer('streets', streets, 'Основные улицы. rank: 1 — проспект/магистраль, 2 — улица, 3 — малая')

    # --- трамвай: только вдоль ключевых улиц
    named = [(n, g) for n, _, g in c.streets if n]
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
    f.apply_file(pbf, locations=True)
    for d, key, tags, area in sorted(f.found, key=lambda t: t[0]):
        short = {k: v for k, v in tags.items() if not k.startswith(('name:', 'contact', 'wiki'))}
        print(f'{d:6.0f} м  {key:12} {area:8.0f} м²  {short}')


def cmd_outline(pbf, ids):
    f = Finder(want=set(ids))
    f.apply_file(pbf, locations=True)
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('layers')
    p.add_argument('pbf')
    p = sub.add_parser('find')
    p.add_argument('pbf')
    p.add_argument('lat', type=float)
    p.add_argument('lon', type=float)
    p.add_argument('radius', type=float, nargs='?', default=60)
    p = sub.add_parser('outline')
    p.add_argument('pbf')
    p.add_argument('ids', nargs='+')
    a = ap.parse_args()
    if a.cmd == 'layers':
        build_layers(a.pbf)
    elif a.cmd == 'find':
        cmd_find(a.pbf, a.lat, a.lon, a.radius)
    else:
        cmd_outline(a.pbf, a.ids)


if __name__ == '__main__':
    main()
