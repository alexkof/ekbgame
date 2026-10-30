"""Набор для художника или генератора: каркас модели, маска, кадр (точка привязки и масштаб).

    npm run dev &
    node lab/scripts/render.cjs lab/work/ai-kit 0 city-hall-procedural:color:8 city-hall-procedural:clay:8
    python lab/scripts/prepare_art.py city-hall-procedural

Каркас вписывается в 1024 пикселя по ширине на белом фоне (высота кратна 16 — так любят
генераторы). Результат — lab/work/ai-kit/: guide-color.png, guide-clay.png, mask.png,
frame.json, prompt.txt. Рисунок того же размера ставится на карту скриптом import_art.py.
"""
import json, os, sys
import cv2
import numpy as np

LAB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
KIT = os.path.join(LAB, 'work', 'ai-kit')
W = 1024
model_id = sys.argv[1] if len(sys.argv) > 1 else 'city-hall-procedural'
meta = json.load(open(os.path.join(KIT, 'meta.json')))

frame = {}
for mode in ['color', 'clay']:
    key = f'{model_id}_{mode}_8'
    im = cv2.imread(os.path.join(KIT, f'{key}.png'), cv2.IMREAD_UNCHANGED)
    k = W / im.shape[1]
    im = cv2.resize(im, (W, round(im.shape[0] * k)), interpolation=cv2.INTER_AREA)
    H = (im.shape[0] + 15) // 16 * 16
    a = im[..., 3:4] / 255.0
    canvas = np.full((H, W, 3), 255, np.uint8)
    canvas[: im.shape[0]] = (im[..., :3] * a + 255 * (1 - a)).astype(np.uint8)
    cv2.imwrite(os.path.join(KIT, f'guide-{mode}.png'), canvas)
    if mode == 'color':
        mask = np.zeros((H, W), np.uint8)
        mask[: im.shape[0]] = im[..., 3]
        cv2.imwrite(os.path.join(KIT, 'mask.png'), mask)
        ox, oy = meta[key]['origin']
        frame = {'size': [W, H], 'ppm': meta[key]['ppm'] * k, 'origin': [ox * k, oy * k]}

# Тень и выбор детализации: выпуклая оболочка всех частей, стоящих на земле.
model = json.load(open(os.path.join(LAB, 'models', f'{model_id}.json')))
pts = [p for part in model['parts'] if part['type'] == 'prism' and part['z'][0] < 1 for p in part['outline']]
hull = cv2.convexHull(np.array(pts, np.float32)).reshape(-1, 2)
frame['footprint'] = [[round(float(x), 1), round(float(y), 1)] for x, y in hull]
frame['height'] = max(part['z'][1] for part in model['parts'] if part['type'] == 'prism')
json.dump(frame, open(os.path.join(KIT, 'frame.json'), 'w'), indent=1)
print('кадр:', frame['size'], 'ppm', round(frame['ppm'], 3), 'origin', [round(v, 1) for v in frame['origin']])
