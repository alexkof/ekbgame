import { nextRandom, type RngState } from '../core/rng';
import type { Projection } from './projection';
import type {
  FeatureCollection,
  LandProps,
  LineGeom,
  MetroProps,
  NameProps,
  ObjectFeature,
  ObjectProps,
  PointGeom,
  PolygonGeom,
  StreetProps,
  WaterProps,
  ZoneId,
} from './types';

/**
 * Подготовка данных: GeoJSON (градусы) → мировые координаты (после радиального сжатия).
 * Всё здесь — чистые функции без DOM: их можно тестировать и считать один раз при загрузке.
 */

export type Pt = [number, number];

export interface Bbox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Участок линии с почти постоянным локальным масштабом — рисуется одной толщиной. */
export interface LineRun {
  pts: Pt[];
  /** Локальный масштаб (игровых единиц на метр) на этом участке. */
  k: number;
}

export interface WorldLine {
  name: string;
  rank: number;
  runs: LineRun[];
  bbox: Bbox;
}

export interface WorldPolygon {
  kind: string;
  name: string;
  rings: Pt[][];
  bbox: Bbox;
  area: number;
  labelAt: Pt | null;
}

export interface WorldPoint {
  name: string;
  at: Pt;
  zone: ZoneId;
}

export interface WorldObject {
  props: ObjectProps;
  plot: Pt[];
  anchor: Pt;
  /** Масштаб модели: локальный масштаб карты × emphasis. */
  scale: number;
  zone: ZoneId;
  bbox: Bbox;
}

export interface TreeInstance {
  x: number;
  y: number;
  /** Радиус кроны в мировых единицах. */
  r: number;
  variant: number;
}

export interface MapLayers {
  streets: FeatureCollection<LineGeom, StreetProps>;
  tram: FeatureCollection<LineGeom, object>;
  rail: FeatureCollection<LineGeom, object>;
  metro: FeatureCollection<LineGeom | PointGeom, MetroProps>;
  water: FeatureCollection<PolygonGeom, WaterProps>;
  land: FeatureCollection<PolygonGeom, LandProps>;
  districts: FeatureCollection<PointGeom, NameProps>;
}

export interface World {
  projection: Projection;
  streets: WorldLine[];
  tram: WorldLine[];
  rail: WorldLine[];
  metroLines: WorldLine[];
  stations: WorldPoint[];
  water: WorldPolygon[];
  land: WorldPolygon[];
  districts: WorldPoint[];
  objects: WorldObject[];
  trees: TreeInstance[];
}

// ------------------------------------------------------------- геометрия

export function bboxOf(pts: Pt[]): Bbox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function polygonArea(ring: Pt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

export function pointInRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(x: number, y: number, rings: Pt[][]): boolean {
  if (!rings[0] || !pointInRing(x, y, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(x, y, rings[i]!)) return false;
  return true;
}

function ringCentroid(ring: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const f = p[0] * q[1] - q[0] * p[1];
    a += f;
    cx += (p[0] + q[0]) * f;
    cy += (p[1] + q[1]) * f;
  }
  if (Math.abs(a) < 1e-9) return ring[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

function bboxesIntersect(a: Bbox, b: Bbox): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/** Делит линию на участки, где локальный масштаб меняется не больше чем на tolerance. */
export function splitByScale(pts: Pt[], scaleAt: (p: Pt) => number, tolerance = 0.06): LineRun[] {
  const runs: LineRun[] = [];
  if (pts.length < 2) return runs;
  let cur: Pt[] = [pts[0]!];
  let k0 = scaleAt(pts[0]!);
  let sum = k0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const k = scaleAt(p);
    cur.push(p);
    sum += k;
    if (Math.abs(k - k0) / k0 > tolerance && i < pts.length - 1) {
      runs.push({ pts: cur, k: sum / cur.length });
      cur = [p];
      k0 = k;
      sum = k;
    }
  }
  if (cur.length > 1) runs.push({ pts: cur, k: sum / cur.length });
  return runs;
}

// ---------------------------------------------------------------- сборка

export function buildWorld(
  projection: Projection,
  layers: MapLayers,
  objects: FeatureCollection<PolygonGeom, ObjectProps>,
): World {
  const P = projection;
  const toWorld = (c: [number, number]): Pt => P.geoToWorld(c);
  const scaleAt = (p: Pt) => P.scaleAtWorld(p[0], p[1]);

  const lines = (
    fc: FeatureCollection<LineGeom, object>,
    nameOf: (p: object) => [string, number],
  ) =>
    fc.features.map((f): WorldLine => {
      const pts = f.geometry.coordinates.map(toWorld);
      const [name, rank] = nameOf(f.properties);
      return { name, rank, runs: splitByScale(pts, scaleAt), bbox: bboxOf(pts) };
    });

  const polygons = (fc: FeatureCollection<PolygonGeom, { kind: string; name?: string }>) =>
    fc.features.map((f): WorldPolygon => {
      const rings = f.geometry.coordinates.map((r) => r.map(toWorld));
      const outer = rings[0] ?? [];
      const c = ringCentroid(outer);
      return {
        kind: f.properties.kind,
        name: f.properties.name ?? '',
        rings,
        bbox: bboxOf(outer),
        area: Math.abs(polygonArea(outer)),
        labelAt: pointInPolygon(c[0], c[1], rings) ? c : null,
      };
    });

  const points = (features: { properties: { name?: string }; geometry: PointGeom }[]) =>
    features.map((f): WorldPoint => {
      const at = toWorld(f.geometry.coordinates);
      return { name: f.properties.name ?? '', at, zone: P.zoneOfWorld(at[0], at[1]) };
    });

  const metroLines = layers.metro.features.filter(
    (f): f is { type: 'Feature'; properties: MetroProps; geometry: LineGeom } =>
      f.geometry.type === 'LineString',
  );
  const stations = layers.metro.features.filter(
    (f): f is { type: 'Feature'; properties: MetroProps; geometry: PointGeom } =>
      f.geometry.type === 'Point',
  );

  const worldObjects = objects.features.map((f) => buildObject(P, f));
  const land = polygons(layers.land);
  const water = polygons(layers.water);

  return {
    projection,
    streets: lines(layers.streets, (p) => [(p as StreetProps).name, (p as StreetProps).rank]),
    tram: lines(layers.tram, () => ['', 0]),
    rail: lines(layers.rail, () => ['', 0]),
    metroLines: lines({ type: 'FeatureCollection', features: metroLines }, () => ['', 0]),
    stations: points(stations),
    water,
    land,
    districts: points(layers.districts.features),
    objects: worldObjects,
    trees: scatterTrees(land, water, worldObjects, P, { seed: 1905 }),
  };
}

export function buildObject(P: Projection, f: ObjectFeature): WorldObject {
  const ring = f.geometry.coordinates[0] ?? [];
  const plot = ring.map((c) => P.geoToWorld(c));
  if (plot.length > 1) {
    const a = plot[0]!;
    const b = plot[plot.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) plot.pop();
  }
  const anchorGeo = f.properties.anchor ?? P.worldToGeo(...ringCentroid(plot));
  const anchor = P.geoToWorld(anchorGeo);
  // Укрупнённый объект занимает и укрупнённый участок — вокруг точки привязки.
  const e = f.properties.emphasis ?? 1;
  for (const p of plot) {
    p[0] = anchor[0] + (p[0] - anchor[0]) * e;
    p[1] = anchor[1] + (p[1] - anchor[1]) * e;
  }
  return {
    props: f.properties,
    plot,
    anchor,
    scale: P.scaleAtGeo(anchorGeo) * (f.properties.emphasis ?? 1),
    zone: P.zoneOfWorld(anchor[0], anchor[1]),
    bbox: bboxOf([...plot, anchor]),
  };
}

/**
 * Деревья в парках и лесопарках: случайная, но детерминированная расстановка по сетке
 * с джиттером. Плотность задана в мировых единицах, поэтому на окраинах (где масштаб
 * мельче) деревьев на реальный гектар меньше, а сами они мельче — детализация падает
 * вместе с масштабом.
 */
export function scatterTrees(
  land: WorldPolygon[],
  water: WorldPolygon[],
  objects: WorldObject[],
  P: Projection,
  opts: { seed: number; maxPerPolygon?: number },
): TreeInstance[] {
  const out: TreeInstance[] = [];
  let rng: RngState = { seed: opts.seed };
  const rnd = () => {
    const [v, next] = nextRandom(rng);
    rng = next;
    return v;
  };
  const spacingOf: Record<string, number> = { park: 19, forest: 34 };
  const radiusOf: Record<string, number> = { park: 5.5, forest: 8 };
  for (const poly of land) {
    const spacing = spacingOf[poly.kind];
    if (!spacing) continue;
    const { x0, y0, x1, y1 } = poly.bbox;
    const cells = ((x1 - x0) / spacing) * ((y1 - y0) / spacing);
    // Для огромных лесопарков увеличиваем шаг, чтобы не плодить тысячи деревьев.
    const max = opts.maxPerPolygon ?? 220;
    const step = cells > max * 2.2 ? spacing * Math.sqrt(cells / (max * 2.2)) : spacing;
    const nearWater = water.filter((w) => bboxesIntersect(w.bbox, poly.bbox));
    const nearObjects = objects.filter((o) => bboxesIntersect(o.bbox, poly.bbox));
    for (let y = y0 + step / 2; y < y1; y += step) {
      for (let x = x0 + step / 2; x < x1; x += step) {
        const px = x + (rnd() - 0.5) * step * 0.9;
        const py = y + (rnd() - 0.5) * step * 0.9;
        const size = rnd();
        const variant = Math.floor(rnd() * 4);
        if (!pointInPolygon(px, py, poly.rings)) continue;
        if (nearWater.some((w) => pointInPolygon(px, py, w.rings))) continue;
        if (nearObjects.some((o) => pointInRing(px, py, o.plot))) continue;
        const k = P.scaleAtWorld(px, py);
        const base = radiusOf[poly.kind]! * (step / spacing) ** 0.5;
        out.push({ x: px, y: py, r: base * k * (0.8 + size * 0.45), variant });
      }
    }
  }
  return out;
}
