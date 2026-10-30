"""Модели-варианты мэрии для лаборатории (координаты в метрах от точки привязки)."""
import os
# Рабочая папка — lab/work (не в git): photo/cityhall.webp, tex/, bake/.
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'work'))
import json, math
OUT = '../models'
th = math.atan2(22.8, 118.9)                 # поворот корпуса (по контуру OSM)
U = (math.cos(th), math.sin(th)); N = (-math.sin(th), math.cos(th))
C0 = (0.4, 0.1)
r1 = lambda v: round(v, 1)
def P(s, n):  # s — вдоль корпуса (на восток), n — поперёк (на север)
    return [r1(C0[0] + U[0]*s + N[0]*n), r1(C0[1] + U[1]*s + N[1]*n)]
def rect(s0, s1, n0, n1):
    return [P(s0, n0), P(s1, n0), P(s1, n1), P(s0, n1)]
L2, D2 = 60.5, 10.5                          # полудлина и полуширина корпуса

STONE = '#8e9088'; PANEL = '#d4834f'; WHITE = '#efe9da'; ROOF = '#8d9a93'
bays = lambda **kw: {'pier': STONE, 'panel': PANEL, 'plinth': '#7f7d74', 'frame': '#f2efe6',
                     'plinthHeight': 5.5, 'friezeHeight': 3.6, 'bay': 8, 'windows': 3, **kw}
parts = []
add = parts.append
# корпус
add({'type': 'prism', 'outline': rect(-L2 + 12, L2 - 12, -D2, D2), 'z': [0, 22.5], 'color': STONE,
     'roof': ROOF, 'hip': 3.5, 'facade': 'bays', 'floor': 4.2, 'bays': bays()})
# угловые ризалиты
for s0 in (-L2, L2 - 12):
    add({'type': 'prism', 'outline': rect(s0, s0 + 12, -D2 - 1, D2 + 1), 'z': [0, 23.5], 'color': STONE,
         'roof': ROOF, 'hip': 3.5, 'facade': 'bays', 'floor': 4.2, 'bays': bays(bay=12)})
# центральный ризалит с портиком
# Портик только с южной стороны: камера смотрит с юга, северный не виден, а при сортировке
# «художника» его колонны могут вылезти поверх крыши.
for side in (-1,):
    n_face = side * (D2 + 1)
    # ризалит — только у фасада, чтобы не прорезать крышу корпуса
    add({'type': 'prism', 'outline': rect(-9, 9, min(n_face, n_face - side * 4), max(n_face, n_face - side * 4)),
         'z': [0, 23.5], 'color': STONE, 'roof': '#c9c3b4', 'facade': 'bays', 'floor': 4.2,
         'bays': bays(bay=6, windows=2)})
    add({'type': 'prism', 'outline': rect(-8, 8, n_face, n_face + side * 3.2), 'z': [0, 5.5],
         'color': '#7f7d74', 'roof': '#a7a397', 'facade': 'grid', 'floor': 5.5})
    for s in (-6.6, -3.4, 3.4, 6.6):
        c = P(s, n_face + side * 1.9)
        add({'type': 'cylinder', 'center': c, 'radius': 0.8, 'z': [5.5, 21.3], 'color': WHITE,
             'segments': 10})
    add({'type': 'prism', 'outline': rect(-8, 8, n_face, n_face + side * 3.2), 'z': [21.3, 23.5],
         'color': WHITE, 'roof': '#c9c3b4', 'facade': 'none'})
# балюстрада по периметру
for (s0, s1, n0, n1, z) in [(-L2, L2, -D2 - 1, -D2 - 0.6, 23.5), (-L2, L2, D2 + 0.6, D2 + 1, 23.5),
                             (-L2, -L2 + 0.4, -D2 - 1, D2 + 1, 23.5), (L2 - 0.4, L2, -D2 - 1, D2 + 1, 23.5)]:
    add({'type': 'prism', 'outline': rect(s0, s1, n0, n1), 'z': [z, z + 1.4], 'color': '#e9e4d8',
         'roof': '#f2eee4', 'facade': 'balusters'})
# башня
add({'type': 'prism', 'outline': rect(-7.5, 7.5, -7.5, 7.5), 'z': [23.5, 31], 'color': STONE,
     'roof': '#d9d3c4', 'facade': 'bays', 'floor': 3.7,
     'bays': bays(bay=5, windows=1, plinthHeight=0.8, friezeHeight=1.4)})
add({'type': 'cylinder', 'center': P(0, 0), 'radius': 6.6, 'z': [31, 32.2], 'color': WHITE, 'segments': 20})
add({'type': 'cylinder', 'center': P(0, 0), 'radius': 6.0, 'z': [32.2, 43], 'color': WHITE, 'segments': 16,
     'facade': 'bays', 'floor': 10.8,
     'bays': bays(pier=WHITE, bay=2.4, windows=1, plinthHeight=1.0, friezeHeight=1.4, plinth=WHITE)})
add({'type': 'cylinder', 'center': P(0, 0), 'radius': 6.7, 'z': [43, 44.4], 'color': WHITE, 'segments': 20})
add({'type': 'cylinder', 'center': P(0, 0), 'radius': 3.6, 'z': [44.4, 50], 'color': '#e7dfcb', 'segments': 12,
     'facade': 'bays', 'floor': 5.6,
     'bays': bays(pier=WHITE, panel='#c98a5a', bay=1.9, windows=1, plinthHeight=0.6, friezeHeight=0.8, plinth=WHITE)})
add({'type': 'cylinder', 'center': P(0, 0), 'radius': 4.0, 'z': [50, 50.9], 'color': WHITE, 'segments': 12})
add({'type': 'cylinder', 'center': P(0, 0), 'radius': 2.3, 'z': [50.9, 64.5], 'top': 0, 'color': '#c9a54e',
     'segments': 8})
add({'type': 'sign', 'kind': 'star', 'at': P(0, 0) + [64.5], 'size': 3.6, 'color': '#d4a636'})
for s in (-3.2, 3.2):
    add({'type': 'sign', 'kind': 'clock', 'at': P(s, -6.2) + [37.6], 'size': 3.4})
add({'type': 'sign', 'kind': 'flag', 'at': P(-7, -7.5) + [31], 'size': 5})
# статуи на угловых ризалитах и портике
for s in (-L2 + 1.5, -L2 + 6, -L2 + 10.5, L2 - 10.5, L2 - 6, L2 - 1.5, -7, 7):
    add({'type': 'sign', 'kind': 'statue', 'at': P(s, -D2 - 0.9) + [24.9], 'size': 4.2})

json.dump({'id': 'city-hall-procedural', 'name': 'Мэрия — процедурные фасады',
           'source': 'Контур — OSM; ордер, пролёты 8 м, портик, башня — по фото.', 'parts': parts},
          open(f'{OUT}/city-hall-procedural.json', 'w'), ensure_ascii=False, indent=2)

# ---- фото-варианты: та же геометрия корпуса, картинки на стенах, башня — билборд
def photo_model(mid, name, south, west, src):
    body = {'type': 'prism', 'outline': rect(-L2, L2, -D2, D2), 'z': [0, 24], 'color': '#8e9088',
            'roof': ROOF, 'hip': 3.5, 'facade': 'none',
            'skins': [{'image': f'city-hall/{south}', 'side': 'south'},
                      {'image': f'city-hall/{west}', 'side': 'west'},
                      {'image': f'city-hall/{west}', 'side': 'east'},
                      {'image': f'city-hall/{south}', 'side': 'north'}]}
    base = {'type': 'prism', 'outline': rect(-7, 7, -7, 7), 'z': [24, 29.8], 'color': STONE,
            'roof': '#d9d3c4', 'facade': 'bays', 'floor': 3.7,
            'bays': bays(bay=4.6, windows=1, plinthHeight=0.8, friezeHeight=1.4)}
    tower = {'type': 'billboard', 'image': 'city-hall/tower.png', 'center': P(0, 0),
             'width': 16.9, 'z': [29.6, 66.6]}
    json.dump({'id': mid, 'name': name, 'source': src, 'parts': [body, base, tower]},
              open(f'{OUT}/{mid}.json', 'w'), ensure_ascii=False, indent=2)

photo_model('city-hall-photo-raw', 'Мэрия — фото как есть', 'facade-raw.jpg', 'end-raw.jpg',
            'Фасад выпрямлен с фото гомографией без чистки.')
photo_model('city-hall-photo-kit', 'Мэрия — фото-кит', 'facade-clean.jpg', 'end-clean.jpg',
            'Фасад собран из чистых пролётов фото (медиана по 5 пролётам, зеркало).')
print('ok', len(parts))
