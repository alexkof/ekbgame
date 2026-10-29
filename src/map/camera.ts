/**
 * Камера: какая часть плоскости изображения видна на экране.
 * Плоскость изображения: px = X + lean·h, py = Y·groundTilt − h (см. projection.ts).
 * zoom — CSS-пикселей на единицу плоскости.
 */
export class Camera {
  cx = 0;
  cy = 0;
  zoom = 1;
  width = 1;
  height = 1;
  minZoom = 0.01;
  maxZoom = 6;

  planeToScreen(px: number, py: number): [number, number] {
    return [
      (px - this.cx) * this.zoom + this.width / 2,
      (py - this.cy) * this.zoom + this.height / 2,
    ];
  }

  screenToPlane(sx: number, sy: number): [number, number] {
    return [
      (sx - this.width / 2) / this.zoom + this.cx,
      (sy - this.height / 2) / this.zoom + this.cy,
    ];
  }

  panBy(dx: number, dy: number): void {
    this.cx -= dx / this.zoom;
    this.cy -= dy / this.zoom;
  }

  /** Зум с неподвижной точкой (sx, sy) на экране. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const [px, py] = this.screenToPlane(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const [nx, ny] = this.screenToPlane(sx, sy);
    this.cx += px - nx;
    this.cy += py - ny;
  }

  /** Видимый прямоугольник плоскости с запасом margin (в CSS-пикселях). */
  visibleRect(margin = 0): { x0: number; y0: number; x1: number; y1: number } {
    const [x0, y0] = this.screenToPlane(-margin, -margin);
    const [x1, y1] = this.screenToPlane(this.width + margin, this.height + margin);
    return { x0, y0, x1, y1 };
  }
}
