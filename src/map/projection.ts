import type { LonLat, MapConfig, StraightenGrid, ZoneId } from './types';

/**
 * Цепочка систем координат карты (подробно — docs/MAP.md):
 *
 * 1. Гео: долгота/широта (WGS 84), как в OpenStreetMap.
 * 2. Локальные метры: x — на восток, y — на север от `origin` (равнопромежуточная
 *    проекция; на размере города погрешность < 0,1 %).
 * 3. Мир: радиальное сжатие вокруг центра. Масштаб в центре 1:1, к окраинам плавно
 *    уменьшается; направления от центра сохраняются, форма объектов искажается мало.
 *    Ось Y мира направлена на юг (как ось экрана). Сжатие изгибает прямые улицы, поэтому
 *    к нему добавлено поле спрямления — плавное смещение, после которого прямые улицы
 *    снова прямые, а параллельные — параллельные (StraightenGrid, scripts/map/straighten.py).
 * 4. Плоскость изображения: косоугольная проекция «север сверху»: земля сжата по
 *    вертикали (groundTilt), высота уходит вверх с небольшим наклоном вправо (lean).
 * 5. Экран: сдвиг и зум камеры (camera.ts).
 *
 * Формулы продублированы в scripts/map/osm_tool.py — при изменении менять в обоих местах.
 */
export interface Projection {
  config: MapConfig;
  geoToLocal(p: LonLat): [number, number];
  localToGeo(x: number, y: number): LonLat;
  /** Гео → мир (Y на юг), со спрямлением. */
  geoToWorld(p: LonLat): [number, number];
  worldToGeo(X: number, Y: number): LonLat;
  /** Локальный масштаб мира в точке (игровых единиц на реальный метр; спрямление не учтено). */
  scaleAtWorld(X: number, Y: number): number;
  scaleAtGeo(p: LonLat): number;
  /** Реальное расстояние от центра для точки мира. */
  realRadiusOfWorld(X: number, Y: number): number;
  zoneOfWorld(X: number, Y: number): ZoneId;
  /** Экранная высота (до учёта масштаба) для реальной высоты z, м. */
  height(z: number): number;
  /** Радиус границы карты в мире. */
  worldExtent: number;
}

/** Метров в градусе широты/долготы на широте lat (эллипсоид WGS 84, ряд). */
export function metersPerDegree(lat: number): { lat: number; lon: number } {
  const phi = (lat * Math.PI) / 180;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    lon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

/** Касательный масштаб s(r): мировой радиус = r · s(r). */
export function tangentialScale(r: number, radius: number, power: number): number {
  const u = r / radius;
  return Math.pow(1 + u * u, -power / 2);
}

/** Радиальный масштаб: производная мирового радиуса по реальному. */
export function radialScale(r: number, radius: number, power: number): number {
  const u2 = (r / radius) ** 2;
  return tangentialScale(r, radius, power) * ((1 + u2 * (1 - power)) / (1 + u2));
}

/** Реальный радиус → мировой. */
export function warpRadius(r: number, radius: number, power: number): number {
  return r * tangentialScale(r, radius, power);
}

/** Мировой радиус → реальный (обратная функция, метод Ньютона). */
export function unwarpRadius(rw: number, radius: number, power: number): number {
  if (rw <= 0) return 0;
  let r = rw;
  for (let i = 0; i < 40; i++) {
    const f = warpRadius(r, radius, power) - rw;
    const d = radialScale(r, radius, power);
    const next = r - f / d;
    r = next > 0 ? next : r / 2;
    if (Math.abs(f) < 1e-6) break;
  }
  return r;
}

/** Поле спрямления: смещение мировой точки (билинейная интерполяция, вне сетки — ноль). */
export type ShiftField = (X: number, Y: number) => [number, number];

export function createShiftField(grid: StraightenGrid): ShiftField {
  const { x0, y0, cell, nx, ny, unit } = grid;
  const bytes = Uint8Array.from(atob(grid.data), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const d = new Float64Array(nx * ny * 2);
  for (let i = 0; i < d.length; i++) d[i] = view.getInt16(i * 2, true) * unit;
  return (X, Y) => {
    const fx = (X - x0) / cell;
    const fy = (Y - y0) / cell;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= ny - 1) return [0, 0];
    const tx = fx - i;
    const ty = fy - j;
    const k = (j * nx + i) * 2;
    const m = k + nx * 2;
    const w00 = (1 - tx) * (1 - ty);
    const w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty;
    const w11 = tx * ty;
    return [
      d[k]! * w00 + d[k + 2]! * w01 + d[m]! * w10 + d[m + 2]! * w11,
      d[k + 1]! * w00 + d[k + 3]! * w01 + d[m + 1]! * w10 + d[m + 3]! * w11,
    ];
  };
}

/**
 * Проекция карты. straighten — поле спрямления; без него улицы гнутся дугами (радиальное
 * сжатие), это удобно только для сравнения и тестов.
 */
export function createProjection(config: MapConfig, straighten?: StraightenGrid): Projection {
  const { lon: lon0, lat: lat0 } = config.origin;
  const mpd = metersPerDegree(lat0);
  const { radius, power, extent } = config.warp;
  const { linearUpTo, linearScale, power: hPower } = config.heights;
  const zones = [...config.zones].sort((a, b) => a.radius - b.radius);
  if (straighten && (straighten.warp.radius !== radius || straighten.warp.power !== power)) {
    throw new Error(
      'Поле спрямления посчитано для других параметров сжатия: osm_tool.py straighten',
    );
  }
  const shift = straighten ? createShiftField(straighten) : null;

  const geoToLocal = (p: LonLat): [number, number] => [
    (p[0] - lon0) * mpd.lon,
    (p[1] - lat0) * mpd.lat,
  ];
  const localToGeo = (x: number, y: number): LonLat => [lon0 + x / mpd.lon, lat0 + y / mpd.lat];

  const realRadiusOfWorld = (X: number, Y: number) => unwarpRadius(Math.hypot(X, Y), radius, power);

  const scaleAtReal = (r: number) =>
    Math.sqrt(tangentialScale(r, radius, power) * radialScale(r, radius, power));

  return {
    config,
    geoToLocal,
    localToGeo,
    geoToWorld(p) {
      const [x, y] = geoToLocal(p);
      const s = tangentialScale(Math.hypot(x, y), radius, power);
      const X = x * s;
      const Y = -y * s;
      if (!shift) return [X, Y];
      const [dx, dy] = shift(X, Y);
      return [X + dx, Y + dy];
    },
    worldToGeo(X, Y) {
      // Сначала снимаем спрямление: ищем u + D(u) = (X, Y) простой итерацией
      // (поле плавное, сходится за несколько шагов), потом — радиальное сжатие.
      let u = X;
      let v = Y;
      if (shift) {
        for (let i = 0; i < 50; i++) {
          const [dx, dy] = shift(u, v);
          const nu = X - dx;
          const nv = Y - dy;
          const done = Math.abs(nu - u) + Math.abs(nv - v) < 1e-7;
          u = nu;
          v = nv;
          if (done) break;
        }
      }
      const rw = Math.hypot(u, v);
      if (rw === 0) return [lon0, lat0];
      const k = unwarpRadius(rw, radius, power) / rw;
      return localToGeo(u * k, -v * k);
    },
    scaleAtWorld(X, Y) {
      return scaleAtReal(realRadiusOfWorld(X, Y));
    },
    scaleAtGeo(p) {
      const [x, y] = geoToLocal(p);
      return scaleAtReal(Math.hypot(x, y));
    },
    realRadiusOfWorld,
    zoneOfWorld(X, Y) {
      const r = realRadiusOfWorld(X, Y);
      return (zones.find((z) => r < z.radius) ?? zones[zones.length - 1]!).id;
    },
    height(z) {
      if (z <= linearUpTo) return z * linearScale;
      return linearUpTo * linearScale * Math.pow(z / linearUpTo, hPower);
    },
    worldExtent: warpRadius(extent, radius, power),
  };
}
