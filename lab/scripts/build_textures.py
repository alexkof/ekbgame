"""Текстуры мэрии из фото: «сырой» фасад, «чистый» фасад из пролётов, башня-билборд.

Вход: photo/cityhall.webp и tex/raw_*.png (rectify.py). Выход: tex/*.png.
Масштаб — 16 пикселей на метр; ось фасада (башня) — x = 0.
"""
import os
# Рабочая папка — lab/work (не в git): photo/cityhall.webp, tex/, bake/.
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'work'))
import cv2, numpy as np
PPM = 16
img = cv2.imread('photo/cityhall.webp')
right = cv2.imread('tex/raw_right.png')   # x от −2 до 66 м, z от 0 до 27 м
left = cv2.imread('tex/raw_left.png')     # x от −64 до 2 м
Z_TOP = 24.0                              # верх балюстрады = верх стены модели
rows = slice(int((27 - Z_TOP) * PPM), 27 * PPM)   # строки текстуры для z ∈ [0, 24]
col = lambda x, x0: int(round((x - x0) * PPM))

def sky_mask(bgr):
    b, g, r = [bgr[..., i].astype(int) for i in range(3)]
    return (b > 140) & (b - r > 45) & (b - g > 12)

def to_rgba(bgr, alpha):
    out = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
    out[..., 3] = alpha
    return out

ROOF = np.array([150, 158, 160], np.uint8)  # BGR: серо-зелёная кровля за балюстрадой

def finish(bgr):
    """Небо за балюстрадой → цвет кровли (стена непрозрачна)."""
    out = bgr.copy()
    out[sky_mask(out)] = ROOF
    return out

# --------------------------------------------------- C: «как есть»
half_r = right[rows, col(0, -2):col(60.5, -2)]
half_l = left[rows, col(-60.5, -64):col(0, -64)]
raw = finish(np.hstack([half_l, half_r]))
cv2.imwrite('tex/facade_raw.png', raw)

# --------------------------------------------------- D: «чистый» фасад
z2r = lambda z: int((Z_TOP - z) * PPM)
R = right[rows]
H = R.shape[0]
bays_px = [(168, 298), (298, 428), (428, 556), (556, 686), (686, 814)]
BAY = 128
bays = np.stack([cv2.resize(R[:, a:b], (BAY, H), interpolation=cv2.INTER_AREA) for a, b in bays_px])

def occluder_mask(bgr):
    """Ели и фонари: тёмная зелень/синева и тёмные тонкие предметы."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(int)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    tree = (h > 35) & (h < 110) & (s > 40) & (v < 150)
    m = cv2.dilate(tree.astype(np.uint8), np.ones((7, 7), np.uint8))
    return m.astype(bool)

masks = np.stack([occluder_mask(b) for b in bays])
masks[:, : int(H * 0.45)] = False          # верх фасада чистый везде
stack = bays.astype(float)
stack[masks] = np.nan
bay = np.nanmedian(stack, axis=0)
fallback = np.median(bays, axis=0)
bay = np.where(np.isnan(bay), fallback, bay).astype(np.uint8)
bay[z2r(0.7):] = np.median(bay[z2r(2.5):z2r(1.0)].reshape(-1, 3), axis=0).astype(np.uint8)
cv2.imwrite('tex/bay.png', bay)

# Угловой ризалит: правая половина чистая — отражаем её на левую.
cr = R[:, 814:1000].copy()
mid = cr.shape[1] // 2 + 6
cr[:, :mid] = cv2.flip(cr[:, cr.shape[1] - mid:], 1)
# Центральный ризалит (колонны): низ закрыт елью и фонарём — продлеваем колонны вниз
# повтором чистого участка ствола, цоколь берём из пролёта.
cen = R[:, col(0, -2):col(8.5, -2)].copy()
z2r = lambda z: int((Z_TOP - z) * PPM)
shaft = cen[z2r(17.5):z2r(13.5)]
for r0 in range(z2r(13.5), z2r(5.5), shaft.shape[0]):
    n = min(shaft.shape[0], z2r(5.5) - r0)
    cen[r0:r0 + n] = shaft[:n]
plinth = np.tile(bay[z2r(5.5):], (1, cen.shape[1] // BAY + 1, 1))[:, : cen.shape[1]]
cen[z2r(5.5):] = plinth
# Дверь по оси
cen[z2r(4.2):, : int(1.6 * PPM)] = (40, 46, 52)

half = np.hstack([cen, *([bay] * 5), cr])
clean = finish(np.hstack([cv2.flip(half, 1), half]))
cv2.imwrite('tex/facade_clean.png', clean)
print('facade', raw.shape, clean.shape, 'width m', clean.shape[1] / PPM)

# --------------------------------------------------- башня-билборд
x0, x1, y0, y1 = 335, 511, 15, 399
crop = img[y0:y1, x0:x1].copy()
cx = 422 - x0
prof = [(15, 18), (60, 6), (190, 16), (196, 38), (235, 42), (236, 64), (262, 68), (263, 80),
        (395, 80), (396, 88), (459, 88)]
mask = np.zeros(crop.shape[:2], np.uint8)
ys = np.arange(y0, y1)
hw = np.interp(ys, [p[0] for p in prof], [p[1] for p in prof])
for i, w in enumerate(hw):
    mask[i, max(0, int(cx - w)):int(cx + w) + 1] = 255
mask[sky_mask(crop)] = 0
mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
cv2.imwrite('tex/tower.png', to_rgba(crop, mask))
print('tower px', crop.shape, 'm', crop.shape[1] / 10.4, crop.shape[0] / 10.4)

# --------------------------------------------------- файлы для лаборатории
LAB = '../models/city-hall'
q = [cv2.IMWRITE_JPEG_QUALITY, 86]
cv2.imwrite(f'{LAB}/facade-raw.jpg', raw, q)
cv2.imwrite(f'{LAB}/facade-clean.jpg', clean, q)
cv2.imwrite(f'{LAB}/end-raw.jpg', finish(R[:, 814:1000]), q)
cv2.imwrite(f'{LAB}/end-clean.jpg', finish(cr), q)
cv2.imwrite(f'{LAB}/tower.png', to_rgba(crop, mask))
