"""Выпрямление фасада мэрии с фото: гомография по 4 точкам → текстура в метрах."""
import os
# Рабочая папка — lab/work (не в git): photo/cityhall.webp, tex/, bake/.
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'work'))
import sys, cv2, numpy as np
PPM = 16  # пикселей на метр в текстуре
img = cv2.imread('photo/cityhall.webp')

def warp(src, dst_m, x_range, z_range, name):
    """src — 4 точки фото, dst_m — те же точки в метрах фасада (x вдоль, z вверх)."""
    x0, x1 = x_range; z0, z1 = z_range
    W, H = int((x1 - x0) * PPM), int((z1 - z0) * PPM)
    dst = np.float32([[(x - x0) * PPM, (z1 - z) * PPM] for x, z in dst_m])
    M = cv2.getPerspectiveTransform(np.float32(src), dst)
    out = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT)
    cv2.imwrite(f'tex/{name}.png', out)
    return M

# Правая половина: от ризалита башни (x≈9 м) до углового ризалита (x≈49 м);
# горизонтали — верх цоколя (5,5 м) и низ карниза (21,5 м).
warp([(418, 466), (862, 400), (862, 652), (418, 660)],
     [(9, 21.5), (49, 21.5), (49, 5.5), (9, 5.5)], (-2, 66), (0, 27), 'raw_right')
# Левая половина: от западного торца (−62) до ризалита с колоннами (−9).
warp([(20, 530), (258, 505), (258, 657), (20, 652)],
     [(-62, 21.5), (-9, 21.5), (-9, 5.5), (-62, 5.5)], (-64, 2), (0, 27), 'raw_left')
