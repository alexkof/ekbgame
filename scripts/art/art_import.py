"""Рисунок по каркасу → спрайт карты: совмещение с каркасом, вырезание фона, сжатие.

Вызывается из art.py import. Генераторы рисуют «примерно поверх» каркаса: кадр немного
сдвинут и масштабирован, фон белый или прозрачный, у здания могут появиться детали, которых
нет в модели (башенки, шпили). Поэтому:

1. рисунок приводится к размеру каркаса (с сохранением пропорций);
2. сдвиг, масштаб и небольшой перекос находятся методом ECC: сначала по силуэтам (грубо),
   потом по контурам (точно); если результат неправдоподобен — шаг пропускается;
3. фон: внутри силуэта модели рисунок сохраняется целиком (у самого края — только то, что не
   фон), за силуэтом в пределах запаса outer — только нарисованное не на фоне и связанное со
   зданием. Фон — прозрачность PNG или белое, соединённое с краем картинки;
4. лишние поля обрезаются, при ppm больше max_ppm картинка уменьшается;
5. check.jpg — проверка: рисунок на клетчатом фоне, красным — контуры каркаса.
"""

import cv2
import numpy as np


def read_bgra(path):
    im = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if im is None:
        raise SystemExit(f'Не читается картинка: {path}')
    if im.dtype != np.uint8:
        im = (im / 257).astype(np.uint8)
    if im.ndim == 2:
        return cv2.cvtColor(im, cv2.COLOR_GRAY2BGRA)
    if im.shape[2] == 3:
        return cv2.cvtColor(im, cv2.COLOR_BGR2BGRA)
    return im


def fit(im, W, H):
    """Вписать в W×H с сохранением пропорций; поля — прозрачный белый."""
    h, w = im.shape[:2]
    k = min(W / w, H / h)
    w2, h2 = round(w * k), round(h * k)
    im = cv2.resize(im, (w2, h2), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC)
    out = np.zeros((H, W, 4), np.uint8)
    out[..., :3] = 255
    x0, y0 = (W - w2) // 2, (H - h2) // 2
    out[y0 : y0 + h2, x0 : x0 + w2] = im
    return out, (w, h)


def has_alpha(im):
    return (im[..., 3] < 250).mean() > 0.01 and (im[..., 3] > 5).mean() > 0.01


def foreground(im, transparent):
    """Нарисованное (не фон): по прозрачности или белое, связанное с краем картинки."""
    if transparent:
        fg = im[..., 3] > 127
    else:
        white = (im[..., :3].min(axis=2) > 232) | (im[..., 3] < 128)
        n, lab = cv2.connectedComponents(white.astype(np.uint8), connectivity=4)
        edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
        edge = edge[edge > 0]
        fg = ~np.isin(lab, edge)
    fg = cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return fg.astype(bool)


def on_white(im):
    a = im[..., 3:4].astype(np.float32) / 255
    return (im[..., :3] * a + 255 * (1 - a)).astype(np.uint8)


def edges(bgr):
    g = cv2.GaussianBlur(cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    return cv2.Canny(g, 40, 120).astype(np.float32) / 255


def ecc(a, b, warp, scale, blur):
    """ECC на уменьшенных a, b; warp — в полных пикселях."""
    a = cv2.resize(a, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    b = cv2.resize(b, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    a = cv2.GaussianBlur(a, (blur, blur), 0)
    b = cv2.GaussianBlur(b, (blur, blur), 0)
    w = warp.copy()
    w[:, 2] *= scale
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 300, 1e-6)
    _, w = cv2.findTransformECC(a, b, w, cv2.MOTION_AFFINE, crit, None, 5)
    w[:, 2] /= scale
    return w


def plausible(w, W):
    """Совмещение правдоподобно: масштаб 0,8…1,25, перекос мал, сдвиг до 15 % кадра."""
    A = w[:, :2]
    sx, sy = np.linalg.norm(A[:, 0]), np.linalg.norm(A[:, 1])
    shear = abs(float(A[:, 0] @ A[:, 1])) / (sx * sy)
    return 0.8 < sx < 1.25 and 0.8 < sy < 1.25 and shear < 0.08 and np.abs(w[:, 2]).max() < 0.15 * W


def find_warp(guide_bgr, mask, art, transparent):
    """Аффинное преобразование рисунка к каркасу (или None)."""
    W = guide_bgr.shape[1]
    warp = np.eye(2, 3, dtype=np.float32)
    steps = [
        (mask.astype(np.float32), foreground(art, transparent).astype(np.float32), 0.25, 9),
        (edges(guide_bgr), edges(on_white(art)), 0.5, 7),
        (edges(guide_bgr), edges(on_white(art)), 1.0, 5),
    ]
    ok = False
    for a, b, scale, blur in steps:
        try:
            w = ecc(a, b, warp, scale, blur)
        except cv2.error:
            continue
        if plausible(w, W):
            warp, ok = w, True
    return warp if ok else None


def process(src, guide, mask, frame, out, check, align=True, inner=0.004, outer=0.05, max_ppm=16):
    W, H = frame['size']
    guide_bgr = cv2.imread(str(guide))
    m = read_bgra(mask)[..., 3] > 127
    art = read_bgra(src)
    transparent = has_alpha(art)
    art, (w0, h0) = fit(art, W, H)
    notes = [f'исходный {w0}×{h0}' + (', прозрачный фон' if transparent else '')]

    warp = find_warp(guide_bgr, m, art, transparent) if align else None
    if warp is not None:
        art = cv2.warpAffine(
            art, warp, (W, H),
            flags=cv2.INTER_CUBIC | cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255, 0),
        )
        A = warp[:, :2]
        notes.append(
            f'совмещение: сдвиг {warp[0, 2]:+.0f}, {warp[1, 2]:+.0f} px, '
            f'масштаб {1 / np.linalg.norm(A[:, 0]):.3f}'
        )
    else:
        notes.append('без совмещения' if not align else 'совмещение не удалось — рисунок как есть')

    # Фон.
    fg = foreground(art, transparent)
    disk = lambda r: cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    r_in = max(2, round(inner * W))
    core = cv2.erode(m.astype(np.uint8), disk(r_in)).astype(bool)
    zone = cv2.dilate(m.astype(np.uint8), disk(round(outer * W))).astype(bool)
    keep = core | (fg & (m | zone))
    n, lab = cv2.connectedComponents(keep.astype(np.uint8), connectivity=8)
    attached = np.unique(lab[m & keep])
    keep = np.isin(lab, attached[attached > 0])
    alpha = cv2.GaussianBlur(keep.astype(np.uint8) * 255, (3, 3), 0)
    rgba = np.dstack([art[..., :3], alpha])

    # Проверка совмещения: рисунок на клетке, контуры каркаса красным.
    cell = 16
    yy, xx = np.mgrid[0:H, 0:W]
    board = np.where(((yy // cell + xx // cell) % 2)[..., None] == 0, 236, 250).astype(np.uint8)
    board = np.repeat(board, 3, axis=2)
    a = alpha[..., None].astype(np.float32) / 255
    view = (rgba[..., :3] * a + board * (1 - a)).astype(np.uint8)
    view[edges(guide_bgr) > 0] = (40, 40, 230)
    k = min(1.0, 1024 / max(W, H))
    view = cv2.resize(view, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(check), view, [cv2.IMWRITE_JPEG_QUALITY, 85])

    # Обрезка полей и масштаб.
    ys, xs = np.nonzero(alpha)
    x0, x1 = max(0, xs.min() - 2), min(W, xs.max() + 3)
    y0, y1 = max(0, ys.min() - 2), min(H, ys.max() + 3)
    rgba = rgba[y0:y1, x0:x1]
    ox, oy = frame['origin'][0] - x0, frame['origin'][1] - y0
    ppm = frame['ppm']
    if ppm > max_ppm:
        k = max_ppm / ppm
        h, w = rgba.shape[:2]
        rgba = cv2.resize(rgba, (max(1, round(w * k)), max(1, round(h * k))), interpolation=cv2.INTER_AREA)
        kx, ky = rgba.shape[1] / w, rgba.shape[0] / h
        ox, oy, ppm = ox * kx, oy * ky, ppm * kx
    # Невидимые пиксели — белые: меньше файл, нет тёмной каймы при масштабировании.
    rgba[rgba[..., 3] == 0, :3] = 255
    cv2.imwrite(str(out), rgba, [cv2.IMWRITE_WEBP_QUALITY, 90])
    h, w = rgba.shape[:2]
    return {
        'size': [w, h],
        'origin': [round(ox, 1), round(oy, 1)],
        'ppm': round(ppm, 3),
        'note': '; '.join(notes),
    }
