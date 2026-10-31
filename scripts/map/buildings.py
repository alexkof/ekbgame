"""Модель здания из OpenStreetMap: контур, части, высоты, крыша, цвета → модель и объект карты.

Вызывается из osm_tool.py (команда building). Правила — «Простые 3D-здания» OSM
(https://wiki.openstreetmap.org/wiki/Simple_3D_Buildings):

- если внутри контура здания есть части (building:part), рисуются только они, каждая со своей
  высотой (height, min_height, building:levels, building:min_level), иначе — сам контур;
- height — до верха крыши, roof:height — высота крыши; без них высота считается по этажам;
- крыша: flat, gabled (двускатная), hipped (вальмовая), pyramidal (шатёр), dome, onion;
- цвета — building:colour, roof:colour, иначе по материалу (building:material).

Модель — промежуточный шаг: по ней строится каркас для художника или генератора, силуэт для
вырезания фона, тень и выбор детализации (docs/ART.md). Облик даёт рисунок.
"""

import math
import re

import shapely
from shapely import geometry as sg

LEVEL = 3.2  # высота этажа, м
OLD_LEVEL = 3.9  # до 1940 года потолки выше
DEFAULT_LEVELS = {'garage': 1, 'garages': 1, 'shed': 1, 'kiosk': 1, 'house': 2, 'detached': 2}
SIMPLIFY = 0.3  # допуск упрощения контуров, м
MIN_PART_AREA = 4.0  # м²: мельче — не рисуем
MIN_HOLE_AREA = 25.0  # м²: дворы меньше — заливаем
MAX_RIDGE = 4.5  # м: высота скатной крыши, если в OSM не указана

COLOURS = {
    'white': '#f2f0ea',
    'whitesmoke': '#f0eeea',
    'ivory': '#f1ecd9',
    'snow': '#f4f1ee',
    'beige': '#d9c9a3',
    'cream': '#efe3c2',
    'wheat': '#e2cfa0',
    'tan': '#c9ac80',
    'khaki': '#c8b880',
    'yellow': '#e3c75a',
    'lightyellow': '#f0e6a8',
    'gold': '#d8b043',
    'orange': '#d98c43',
    'peach': '#eab995',
    'salmon': '#d9897a',
    'pink': '#dca0a0',
    'lightpink': '#e8b9b9',
    'red': '#b4483b',
    'darkred': '#7d2e28',
    'maroon': '#74302b',
    'brown': '#8a5a3c',
    'sienna': '#9a5a3a',
    'chocolate': '#8e5634',
    'brick': '#a9583f',
    'terracotta': '#b8623f',
    'green': '#6f9a6a',
    'lightgreen': '#a8c69a',
    'darkgreen': '#3f6a48',
    'olive': '#7c7a45',
    'teal': '#3f7f80',
    'turquoise': '#5fb0aa',
    'blue': '#5b7fa8',
    'lightblue': '#a7c1d8',
    'darkblue': '#34507a',
    'navy': '#2d3f63',
    'skyblue': '#8fb6d6',
    'purple': '#7d5a8a',
    'violet': '#9a7ab0',
    'grey': '#9c9c98',
    'gray': '#9c9c98',
    'lightgrey': '#c4c4c0',
    'lightgray': '#c4c4c0',
    'silver': '#b8bcc0',
    'darkgrey': '#6e6e6c',
    'darkgray': '#6e6e6c',
    'dimgray': '#666664',
    'black': '#3a3a3a',
}
MATERIAL_COLOURS = {
    'brick': '#a9583f',
    'glass': '#5f7f99',
    'concrete': '#c4c1b8',
    'panel': '#c9c6bd',
    'plaster': '#ddd0b5',
    'stone': '#bdb3a2',
    'wood': '#9a7452',
    'metal': '#a7adb3',
}
WALL_COLOUR = '#d9cdb4'  # штукатурка
FLAT_ROOF = '#a09d96'
SLOPED_ROOF = '#7f8c87'  # крашеное железо

ROOFS = {
    'gabled': 'gable',
    'gambrel': 'gable',
    'saltbox': 'gable',
    'round': 'gable',
    'hipped': 'hip',
    'half-hipped': 'hip',
    'side_hipped': 'hip',
    'mansard': 'hip',
    'pyramidal': 'pyramid',
    'cone': 'pyramid',
    'dome': 'dome',
    'onion': 'onion',
}


def number(v):
    """'12', '12.5', '12,5 m', '40 ft' → метры (или None)."""
    if v is None:
        return None
    m = re.match(r'\s*(-?\d+(?:[.,]\d+)?)\s*(m|м|ft|\')?', str(v))
    if not m:
        return None
    x = float(m.group(1).replace(',', '.'))
    return x * 0.3048 if m.group(2) in ('ft', "'") else x


def colour(v):
    if not v:
        return None
    v = v.strip().lower().replace(' ', '').replace('_', '')
    if re.fullmatch(r'#[0-9a-f]{6}', v):
        return v
    if re.fullmatch(r'#[0-9a-f]{3}', v):
        return '#' + ''.join(c * 2 for c in v[1:])
    return COLOURS.get(v)


def year(tags):
    m = re.search(r'\d{4}', tags.get('start_date', ''))
    return int(m.group()) if m else None


def short_side(poly):
    r = poly.minimum_rotated_rectangle
    if r.geom_type != 'Polygon':
        return 1.0
    c = list(r.exterior.coords)
    return max(1.0, min(math.dist(c[0], c[1]), math.dist(c[1], c[2])))


def heights(tags, poly, outline_tags):
    """Отметки низа и верха стен, крыша (вид и высота) — по правилам Simple 3D Buildings."""
    level = OLD_LEVEL if (year(tags) or year(outline_tags) or 2000) < 1940 else LEVEL
    # Часть без высоты и этажности берёт их у здания.
    own = 'height' in tags or 'building:levels' in tags
    src = tags if own else outline_tags
    levels = number(src.get('building:levels'))
    shape = ROOFS.get(tags.get('roof:shape', 'flat'))
    roof_h = number(tags.get('roof:height'))
    if roof_h is None and number(tags.get('roof:levels')):
        roof_h = number(tags.get('roof:levels')) * level * 0.8
    w = short_side(poly)
    if shape and roof_h is None:
        roof_h = {
            'gable': 0.29 * w,
            'hip': 0.25 * w,
            'pyramid': 0.35 * w,
            'dome': 0.45 * w,
            'onion': 0.7 * w,
        }[shape]
        if shape in ('gable', 'hip'):
            # Большие здания OSM часто одним контуром: крыша идёт по корпусам, а не над всем
            # контуром — поэтому конёк не выше MAX_RIDGE.
            roof_h = min(roof_h, MAX_RIDGE)
    roof_h = roof_h or 0.0
    top = number(src.get('height'))
    if top is not None:
        walls = top - roof_h
    else:
        if levels is None:
            # Без этажности: по типу, а у безымянных «yes» — по площади (сараи во дворах
            # невысокие).
            b = outline_tags.get('building', 'yes')
            area = poly.area
            levels = DEFAULT_LEVELS.get(b, 1 if area < 150 else 2 if area < 400 else 3)
        walls = levels * level + 0.6
    low = number(tags.get('min_height'))
    if low is None and number(tags.get('building:min_level')) is not None:
        low = number(tags.get('building:min_level')) * level
    low = max(0.0, low or 0.0)
    walls = max(walls, low + 2.0)
    return low, walls, shape, roof_h, levels


def polygons(g):
    if g.geom_type == 'Polygon':
        return [g]
    if g.geom_type == 'MultiPolygon':
        return list(g.geoms)
    return []


def num(x, digits=1):
    """Округление без «.0» у целых: 12.0 → 12 (так же записал бы JSON.stringify)."""
    x = round(x, digits)
    return int(x) if x == int(x) else x


def ring(coords, ox, oy):
    pts = [[num(x - ox), num(y - oy)] for x, y in coords[:-1]]
    out = []
    for p in pts:  # подряд одинаковые точки после округления
        if not out or out[-1] != p:
            out.append(p)
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def model_parts(elements, outline_tags, ox, oy):
    """elements: [(tags, Polygon в локальных метрах)] → части модели."""
    solids = []
    for tags, g in elements:
        for poly in polygons(g):
            poly = poly.simplify(SIMPLIFY, preserve_topology=True)
            if poly.is_empty or poly.area < MIN_PART_AREA:
                continue
            z0, z1, shape, roof_h, levels = heights(tags, poly, outline_tags)
            solids.append(
                {'tags': tags, 'poly': poly, 'z0': z0, 'z1': z1, 'shape': shape, 'roof': roof_h,
                 'levels': levels}
            )
    # Башня на стилобате: если часть почти целиком внутри более низкой части и начинается с
    # земли, поднимаем её низ на крышу стилобата — иначе он закроет низ башни на рисунке.
    for a in solids:
        for b in solids:
            if a is b or b['z1'] >= a['z1'] or a['z0'] >= b['z1']:
                continue
            if a['poly'].intersection(b['poly']).area > 0.8 * a['poly'].area:
                a['z0'] = b['z1']

    parts = []
    # Сначала низкие и дальние (северные) части: так проще читать файл; порядок рисования
    # модель всё равно определяет сама.
    solids.sort(key=lambda s: (s['z0'], -s['poly'].centroid.y))
    for s in solids:
        tags, poly = s['tags'], s['poly']
        material = tags.get('building:material') or outline_tags.get('building:material')
        z0, z1 = num(s['z0']), num(s['z1'])
        # Стеклянный фасад — если так в OSM или это высотный офис без указанного материала.
        office = outline_tags.get('building') in ('office', 'commercial')
        glass = material == 'glass' or (not material and office and z1 > 60)
        wall = (
            colour(tags.get('building:colour'))
            or colour(outline_tags.get('building:colour'))
            or MATERIAL_COLOURS.get('glass' if glass else material or '')
            or WALL_COLOUR
        )
        shape = s['shape']
        roof = colour(tags.get('roof:colour')) or colour(outline_tags.get('roof:colour'))
        roof = roof or (SLOPED_ROOF if shape else FLAT_ROOF)
        part = {
            'type': 'prism',
            'outline': ring(list(poly.exterior.coords), ox, oy),
            'z': [z0, z1],
            'color': wall,
            'roof': roof,
            'facade': 'glass' if glass else 'grid',
        }
        if s['levels']:
            part['floor'] = num(max(2.6, (z1 - z0) / max(1.0, s['levels'])), 2)
        holes = [
            ring(list(h.coords), ox, oy)
            for h in poly.interiors
            if sg.Polygon(h).area >= MIN_HOLE_AREA
        ]
        if holes:
            part['holes'] = holes
        rise = num(s['roof'])
        if shape in ('gable', 'hip', 'pyramid') and rise > 0.3:
            part[shape] = rise
        parts.append(part)
        if shape in ('dome', 'onion'):
            c = poly.centroid
            r = min(math.sqrt(poly.area / math.pi), short_side(poly) / 2)
            parts.append(
                {
                    'type': 'dome',
                    'center': [num(c.x - ox), num(c.y - oy)],
                    'radius': num(r * 0.96),
                    'z': z1,
                    'height': num(max(rise, 0.3 * r)),
                    'shape': 'onion' if shape == 'onion' else 'sphere',
                    'color': roof,
                }
            )
    return parts


def address(tags):
    street = tags.get('addr:street')
    house = tags.get('addr:housenumber')
    if not street:
        return None
    street = re.sub(r'^улица (.+)$', r'ул. \1', street)
    street = re.sub(r'^(.+) улица$', r'\1 ул.', street)
    street = re.sub(r'^проспект ', 'пр. ', street)
    return f'{street}, {house}' if house else street


def description(tags, top, levels):
    bits = []
    if levels:
        bits.append(f'{int(levels)} эт.')
    bits.append(f'высота около {top:.0f} м'.replace('.', ','))
    y = tags.get('start_date')
    if y:
        y = y.replace('..', '–').replace(';', ', ')
        bits.append(f'построено: {y}')
    if tags.get('architect'):
        bits.append(f'архитектор: {tags["architect"].replace(";", ", ")}')
    text = '; '.join(bits)
    return text[0].upper() + text[1:] + '.'
