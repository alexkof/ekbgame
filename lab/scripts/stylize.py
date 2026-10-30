"""Запекание: рендер модели → «рисованный» спрайт (сглаживание фото, цвет, контуры)."""
import os
# Рабочая папка — lab/work (не в git): photo/cityhall.webp, tex/, bake/.
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'work'))
import cv2, numpy as np, sys
src = cv2.imread('bake/city-hall-photo-kit_color_8.png', cv2.IMREAD_UNCHANGED)
lines = cv2.imread('bake/city-hall-photo-kit_lines_8.png', cv2.IMREAD_UNCHANGED)
bgr, a = src[..., :3], src[..., 3]
# 1. Мягкое сглаживание с сохранением краёв: фото-шум и мусор → ровные плоскости.
paint = cv2.edgePreservingFilter(bgr, flags=cv2.RECURS_FILTER, sigma_s=12, sigma_r=0.22)
paint = cv2.edgePreservingFilter(paint, flags=cv2.RECURS_FILTER, sigma_s=6, sigma_r=0.15)
# 2. Цвет: высветлить тени, чуть насыщеннее и теплее — под палитру карты.
f = paint.astype(np.float32) / 255
f = f ** 0.8
hsv = cv2.cvtColor((f * 255).astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
hsv[..., 1] = np.clip(hsv[..., 1] * 1.25, 0, 255)
paint = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
paint[..., 2] = np.clip(paint[..., 2] * 1.03 + 3, 0, 255); paint[..., 0] *= 0.97
# 3. Тонкий контур только по рёбрам граней (не по силуэтам-билбордам).
dark = ((lines[..., 3] > 0) & (lines[..., :3].mean(-1) < 100)).astype(np.uint8)
thin = dark & ~cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((4, 4), np.uint8)).astype(bool)
edge = cv2.GaussianBlur(thin.astype(np.float32), (3, 3), 0.6)
k = 0.45 * edge[..., None]
paint = paint * (1 - k) + np.array([52, 56, 70], np.float32) * k
out = np.dstack([np.clip(paint, 0, 255).astype(np.uint8), a])
cv2.imwrite('../models/city-hall/sprite-painted.webp', out, [cv2.IMWRITE_WEBP_QUALITY, 90])
