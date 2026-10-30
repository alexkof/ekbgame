"""Рисунок поверх каркаса (от художника или генератора) → спрайт модели на карте.

    python lab/scripts/import_art.py <рисунок> [--id city-hall-art] [--no-align]

Рядом с каркасом лежит frame.json (размер, пикселей на метр, точка привязки) и mask.png
(силуэт модели) — их пишет prepare_art.py. Скрипт:
1. приводит рисунок к размеру каркаса;
2. подравнивает сдвиг и масштаб (генераторы слегка «гуляют») — по контурам, методом ECC;
3. вырезает фон по силуэту модели (с запасом в пару пикселей и мягким краем);
4. пишет lab/models/<папка>/art.webp и lab/models/<id>.json с частью "image".
"""
import argparse, json, os
import cv2
import numpy as np

LAB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
KIT = os.path.join(LAB, 'work', 'ai-kit')

ap = argparse.ArgumentParser()
ap.add_argument('art')
ap.add_argument('--id', default='city-hall-art')
ap.add_argument('--name', default='Мэрия — рисунок по каркасу')
ap.add_argument('--folder', default='city-hall-art')
ap.add_argument('--no-align', action='store_true')
args = ap.parse_args()

frame = json.load(open(os.path.join(KIT, 'frame.json')))
W, H = frame['size']
mask = cv2.imread(os.path.join(KIT, 'mask.png'), cv2.IMREAD_GRAYSCALE)
guide = cv2.imread(os.path.join(KIT, 'guide-color.png'))
art = cv2.imread(args.art)
# Рисунок может прийти в другом размере: подгоняем по ширине, высоту обрезаем/дополняем белым.
k = W / art.shape[1]
art = cv2.resize(art, (W, round(art.shape[0] * k)), interpolation=cv2.INTER_AREA)
fit = np.full((H, W, 3), 255, np.uint8)
h = min(H, art.shape[0])
fit[:h] = art[:h]
art = fit

if not args.no_align:
    # ECC по картам краёв: цвета у рисунка и каркаса разные, а контуры совпадают.
    def edges(im):
        g = cv2.GaussianBlur(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        return cv2.GaussianBlur(cv2.Canny(g, 40, 120).astype(np.float32) / 255, (9, 9), 0)

    warp = np.eye(2, 3, dtype=np.float32)
    try:
        _, warp = cv2.findTransformECC(
            edges(guide), edges(art), warp, cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), None, 5)
        shift = np.abs(warp - np.eye(2, 3)).max()
        if shift > 0.2 * W:  # разошлось — значит, рисунок слишком не похож на каркас
            raise cv2.error('ECC разошёлся')
        art = cv2.warpAffine(art, warp, (W, H), flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
        print('выравнивание:', np.round(warp, 3).tolist())
    except cv2.error as e:
        print('выравнивание пропущено:', e)

# Фон — по силуэту модели, с запасом 2 px и мягким краем.
alpha = cv2.dilate(mask, np.ones((5, 5), np.uint8))
alpha = cv2.GaussianBlur(alpha, (3, 3), 0)
out = np.dstack([art, alpha])
os.makedirs(os.path.join(LAB, 'models', args.folder), exist_ok=True)
image = f'{args.folder}/art.webp'
cv2.imwrite(os.path.join(LAB, 'models', image), out, [cv2.IMWRITE_WEBP_QUALITY, 90])

model = {
    'id': args.id,
    'name': args.name,
    'source': 'Рисунок по каркасу; фон вырезан по силуэту модели (lab/scripts/import_art.py).',
    'parts': [{
        'type': 'image',
        'image': image,
        'origin': [round(v, 1) for v in frame['origin']],
        'ppm': round(frame['ppm'], 4),
        'footprint': frame['footprint'],
        'height': frame['height'],
    }],
}
json.dump(model, open(os.path.join(LAB, 'models', f'{args.id}.json'), 'w'), ensure_ascii=False, indent=2)
print('готово:', image, f'{args.id}.json')
