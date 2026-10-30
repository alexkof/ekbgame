import { getImage } from './images';
import type {
  BaysStyle,
  BillboardPart,
  Facade,
  ImagePart,
  ModelData,
  ModelPart,
  SignPart,
  Skin,
  XY,
} from './types';

/**
 * Модели объектов: из примитивов (призмы, цилиндры, купола, деревья, значки) собирается
 * список граней в «модельном» пространстве (x — восток, y — север, Z — высота после
 * преувеличения), который рисуется в отдельный спрайт. Спрайт кэшируется и выводится на
 * карту поверх участка — поэтому объект можно убрать или заменить, не трогая остальную карту.
 */

type V3 = [number, number, number];
type RGB = [number, number, number];

/** Параметры косоугольной проекции, нужные модели. */
export interface ViewParams {
  /** Наклон высоты вправо: lean · heightFactor. */
  a: number;
  /** Экранных единиц на единицу высоты: heightFactor. */
  c: number;
  /** Сжатие земли по вертикали: groundTilt. */
  t: number;
  /** Преувеличение высоты (метры → Z). */
  height: (z: number) => number;
}

interface Face {
  kind: 'face';
  pts: V3[];
  fill: string;
  edge: string;
  depth: number;
  /** Нормаль и освещённость (0…1) — для режимов «глина» и «нормали». */
  n: V3;
  k: number;
  wall?: Wall;
  gradient?: [string, string];
}
interface Wall {
  p0: XY;
  p1: XY;
  z0: number;
  z1: number;
  facade: Facade;
  floor: number;
  base: RGB;
  bays?: BaysStyle;
  skin?: Skin;
}
interface BillboardItem {
  kind: 'billboard';
  part: BillboardPart;
  depth: number;
}
interface ImageItem {
  kind: 'image';
  part: ImagePart;
  depth: number;
}
interface TreeItem {
  kind: 'tree';
  x: number;
  y: number;
  r: number;
  variant: number;
  depth: number;
}
interface SignItem {
  kind: 'sign';
  part: SignPart;
  pos: V3;
  depth: number;
}
type Item = Face | TreeItem | SignItem | BillboardItem | ImageItem;

/**
 * Как рисовать модель: color — обычный вид; clay — «глина» без цвета и деталей;
 * normals — карта нормалей; lines — контуры. Последние три — подсказки (каркас) для
 * художника или генератора изображений: рисунок поверх них ляжет точно в проекцию карты.
 */
export type RenderMode = 'color' | 'clay' | 'normals' | 'lines';

interface Group {
  depth: number;
  order: number;
  items: Item[];
}

export interface Footprint {
  outline: XY[];
  /** Реальная высота, м — для тени. */
  height: number;
}

export interface CompiledModel {
  id: string;
  name: string;
  groups: Group[];
  ground: { pts: XY[]; color: string }[];
  footprints: Footprint[];
  /** Габарит по земле, м (для выбора уровня детализации). */
  size: number;
  /** Самая высокая точка (Z) — над ней ставится подпись. */
  topZ: number;
  bounds: { u0: number; u1: number; v0: number; v1: number };
}

// --------------------------------------------------------------- цвета

export function parseColor(hex: string): RGB {
  const h = hex.replace('#', '');
  const n = parseInt(
    h.length === 3
      ? h
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : h,
    16,
  );
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgb(c: RGB, k = 1, alpha = 1): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return alpha < 1
    ? `rgba(${f(c[0])},${f(c[1])},${f(c[2])},${alpha})`
    : `rgb(${f(c[0])},${f(c[1])},${f(c[2])})`;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

// Свет падает с юго-юго-востока сверху: южные фасады светлые, западные — в тени.
const LIGHT: V3 = normalize([0.2, -0.55, 1.0]);
const AMBIENT = 0.6;
const DIFFUSE = 0.42;

function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/** Нормаль многоугольника методом Ньюэла. */
function newell(pts: V3[]): V3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  return normalize([nx, ny, nz]);
}

function signedArea(o: XY[]): number {
  let s = 0;
  for (let i = 0; i < o.length; i++) {
    const p = o[i]!;
    const q = o[(i + 1) % o.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** Контур без повтора первой точки и против часовой стрелки. */
export function ccw(outline: XY[]): XY[] {
  let o = outline;
  const f = o[0];
  const l = o[o.length - 1];
  if (f && l && f[0] === l[0] && f[1] === l[1]) o = o.slice(0, -1);
  return signedArea(o) < 0 ? [...o].reverse() : o;
}

function centroid(o: XY[]): XY {
  let x = 0;
  let y = 0;
  for (const p of o) {
    x += p[0];
    y += p[1];
  }
  return [x / o.length, y / o.length];
}

const DEFAULT_BAYS: BaysStyle = {
  bay: 8,
  windows: 3,
  pier: '#8f9188',
  panel: '#c9714a',
  plinth: '#7d7f78',
  frame: '#f4f1e8',
  plinthHeight: 5.5,
  friezeHeight: 3.5,
};

const SIDES: Record<Skin['side'], XY> = {
  south: [0, -1],
  north: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

/** Какой стене какая картинка: самая длинная из стен, обращённых в нужную сторону (±45°). */
function skinsByEdge(ring: XY[], skins: Skin[]): Map<number, Skin> {
  const out = new Map<number, Skin>();
  for (const skin of skins) {
    const [sx, sy] = SIDES[skin.side];
    let best = -1;
    let bestLen = 0;
    ring.forEach((p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      // Внешняя нормаль ребра контура против часовой стрелки — справа от направления обхода.
      const nx = (q[1] - p[1]) / len;
      const ny = -(q[0] - p[0]) / len;
      if (nx * sx + ny * sy > Math.SQRT1_2 && len > bestLen) {
        best = i;
        bestLen = len;
      }
    });
    if (best >= 0) out.set(best, skin);
  }
  return out;
}

/** Скаты вальмовой крыши над четырёхугольником (против часовой): две трапеции и два треугольника. */
function hipRoof(o: XY[], Z0: number, Z1: number): V3[][] {
  const d = (p: XY, q: XY) => Math.hypot(q[0] - p[0], q[1] - p[1]);
  const [A, B, C, D] = d(o[0]!, o[1]!) >= d(o[1]!, o[2]!) ? o : [o[1]!, o[2]!, o[3]!, o[0]!];
  const len = d(A!, B!);
  const half = Math.min(len, d(B!, C!)) / 2;
  const ux = (B![0] - A![0]) / len;
  const uy = (B![1] - A![1]) / len;
  const m1: XY = [(A![0] + D![0]) / 2, (A![1] + D![1]) / 2];
  const m2: XY = [(B![0] + C![0]) / 2, (B![1] + C![1]) / 2];
  const r1: V3 = [m1[0] + ux * half, m1[1] + uy * half, Z1];
  const r2: V3 = [m2[0] - ux * half, m2[1] - uy * half, Z1];
  const at = (p: XY): V3 => [p[0], p[1], Z0];
  return [
    [at(A!), at(B!), r2, r1],
    [at(B!), at(C!), r2],
    [at(C!), at(D!), r1, r2],
    [at(D!), at(A!), r1],
  ];
}

// --------------------------------------------------------------- сборка

export function compileModel(data: ModelData, view: ViewParams): CompiledModel {
  // Направление на зрителя: точки, ближние к камере, имеют больший depth.
  const viewDir: V3 = normalize([-view.a, -view.c / view.t, 1]);
  const depthOf = (p: V3) => dot(p, viewDir);
  const visible = (n: V3) => dot(n, viewDir) > 1e-6;
  const shadeFor = (n: V3, base: RGB, strong = false) => {
    const d = Math.max(0, dot(n, LIGHT));
    return strong ? 0.5 + 0.7 * d : AMBIENT + DIFFUSE * d;
  };
  const H = view.height;

  const groups: Group[] = [];
  const imageBox = { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
  const ground: CompiledModel['ground'] = [];
  const footprints: Footprint[] = [];
  let topZ = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const extend = (x: number, y: number) => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  };

  const faceFrom = (pts: V3[], base: RGB, opts: { strong?: boolean; wall?: Wall } = {}) => {
    const n = newell(pts);
    if (!visible(n)) return null;
    const k = shadeFor(n, base, opts.strong);
    const c = pts.reduce<V3>((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]);
    const face: Face = {
      kind: 'face',
      pts,
      fill: rgb(base, k),
      edge: rgb(base, k * 0.86),
      depth: depthOf([c[0] / pts.length, c[1] / pts.length, c[2] / pts.length]),
      n,
      k,
    };
    if (opts.wall) face.wall = opts.wall;
    return face;
  };

  const addSolidWalls = (
    ring: XY[],
    z0: number,
    z1: number,
    base: RGB,
    facade: Facade,
    floor: number,
    items: Item[],
    extra: { bays?: BaysStyle; skins?: Skin[] } = {},
  ) => {
    const Z0 = H(z0);
    const Z1 = H(z1);
    const walls: Face[] = [];
    const skinOf = skinsByEdge(ring, extra.skins ?? []);
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const wall: Wall = { p0: p, p1: q, z0, z1, facade, floor, base };
      if (extra.bays) wall.bays = extra.bays;
      const skin = skinOf.get(i);
      if (skin) wall.skin = skin;
      const f = faceFrom(
        [
          [p[0], p[1], Z0],
          [q[0], q[1], Z0],
          [q[0], q[1], Z1],
          [p[0], p[1], Z1],
        ],
        base,
        { wall },
      );
      if (f) {
        if (facade === 'glass') f.gradient = [rgb(base, 1.18), rgb(base, 0.78)];
        walls.push(f);
      }
    }
    walls.sort((a, b) => a.depth - b.depth);
    items.push(...walls);
  };

  data.parts.forEach((part: ModelPart, order) => {
    const items: Item[] = [];
    let anchor: V3 = [0, 0, 0];
    switch (part.type) {
      case 'ground': {
        const o = ccw(part.outline);
        ground.push({ pts: o, color: part.color });
        o.forEach((p) => extend(p[0], p[1]));
        return;
      }
      case 'prism': {
        const o = ccw(part.outline);
        const base = parseColor(part.color);
        const roof = part.roof ? parseColor(part.roof) : mix(base, [255, 255, 255], 0.12);
        const [z0, z1] = part.z;
        const extra: { bays?: BaysStyle; skins?: Skin[] } = {};
        if (part.facade === 'bays') extra.bays = { ...DEFAULT_BAYS, ...part.bays };
        if (part.skins) extra.skins = part.skins;
        addSolidWalls(o, z0, z1, base, part.facade ?? 'grid', part.floor ?? 3.6, items, extra);
        const c = centroid(o);
        if (part.pyramid) {
          const apex: V3 = [c[0], c[1], H(z1 + part.pyramid)];
          const tris: Face[] = [];
          for (let i = 0; i < o.length; i++) {
            const p = o[i]!;
            const q = o[(i + 1) % o.length]!;
            const f = faceFrom([[p[0], p[1], H(z1)], [q[0], q[1], H(z1)], apex], roof);
            if (f) tris.push(f);
          }
          tris.sort((a, b) => a.depth - b.depth);
          items.push(...tris);
          topZ = Math.max(topZ, apex[2]);
        } else if (part.hip && o.length === 4) {
          const slopes = hipRoof(o, H(z1), H(z1 + part.hip))
            .map((pts) => faceFrom(pts, roof))
            .filter((f): f is Face => f !== null)
            .sort((a, b) => a.depth - b.depth);
          items.push(...slopes);
          topZ = Math.max(topZ, H(z1 + part.hip));
        } else {
          const top = faceFrom(
            o.map((p) => [p[0], p[1], H(z1)] as V3),
            roof,
          );
          if (top) items.push(top);
          topZ = Math.max(topZ, H(z1));
        }
        o.forEach((p) => extend(p[0], p[1]));
        if (z0 < 1) footprints.push({ outline: o, height: z1 + (part.pyramid ?? 0) });
        anchor = [c[0], c[1], H(z0)];
        break;
      }
      case 'cylinder': {
        const [rx, ry] = typeof part.radius === 'number' ? [part.radius, part.radius] : part.radius;
        const n = part.segments ?? 20;
        const rot = ((part.rotate ?? 0) * Math.PI) / 180;
        const topK = part.top ?? 1;
        const ring = (k: number): XY[] =>
          Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2;
            const x = Math.cos(a) * rx * k;
            const y = Math.sin(a) * ry * k;
            return [
              part.center[0] + x * Math.cos(rot) - y * Math.sin(rot),
              part.center[1] + x * Math.sin(rot) + y * Math.cos(rot),
            ];
          });
        const base = parseColor(part.color);
        const roof = part.roof ? parseColor(part.roof) : mix(base, [255, 255, 255], 0.12);
        const [z0, z1] = part.z;
        const bottom = ring(1);
        if (topK === 1) {
          const extra = part.facade === 'bays' ? { bays: { ...DEFAULT_BAYS, ...part.bays } } : {};
          addSolidWalls(
            bottom,
            z0,
            z1,
            base,
            part.facade ?? 'none',
            part.floor ?? 3.6,
            items,
            extra,
          );
        } else {
          const top = ring(topK);
          const sides: Face[] = [];
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const pts: V3[] =
              topK === 0
                ? [
                    [bottom[i]![0], bottom[i]![1], H(z0)],
                    [bottom[j]![0], bottom[j]![1], H(z0)],
                    [part.center[0], part.center[1], H(z1)],
                  ]
                : [
                    [bottom[i]![0], bottom[i]![1], H(z0)],
                    [bottom[j]![0], bottom[j]![1], H(z0)],
                    [top[j]![0], top[j]![1], H(z1)],
                    [top[i]![0], top[i]![1], H(z1)],
                  ];
            const f = faceFrom(pts, base);
            if (f) sides.push(f);
          }
          sides.sort((a, b) => a.depth - b.depth);
          items.push(...sides);
        }
        if (topK > 0) {
          const cap = faceFrom(
            ring(topK).map((p) => [p[0], p[1], H(z1)] as V3),
            roof,
          );
          if (cap) items.push(cap);
        }
        topZ = Math.max(topZ, H(z1));
        bottom.forEach((p) => extend(p[0], p[1]));
        if (z0 < 1) footprints.push({ outline: bottom, height: z1 });
        anchor = [part.center[0], part.center[1], H(z0)];
        break;
      }
      case 'dome': {
        const n = part.segments ?? 16;
        const shape = part.shape ?? 'sphere';
        // Профиль купола: [доля радиуса, доля высоты] от основания к вершине.
        const profile: [number, number][] =
          shape === 'onion'
            ? [
                [1, 0],
                [1.16, 0.2],
                [1.12, 0.4],
                [0.82, 0.62],
                [0.42, 0.8],
                [0.12, 0.93],
                [0, 1],
              ]
            : Array.from({ length: 6 }, (_, i) => {
                const t = (i / 5) * (Math.PI / 2);
                return [Math.cos(t), Math.sin(t)] as [number, number];
              });
        const base = parseColor(part.color);
        const rings = profile.map(([rk, hk]) =>
          Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2;
            return [
              part.center[0] + Math.cos(a) * part.radius * rk,
              part.center[1] + Math.sin(a) * part.radius * rk,
              H(part.z + part.height * hk),
            ] as V3;
          }),
        );
        const quads: Face[] = [];
        for (let r = 0; r < rings.length - 1; r++) {
          const lo = rings[r]!;
          const hi = rings[r + 1]!;
          for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const pts: V3[] =
              profile[r + 1]![0] === 0
                ? [lo[i]!, lo[j]!, hi[i]!]
                : [lo[i]!, lo[j]!, hi[j]!, hi[i]!];
            const f = faceFrom(pts, base, { strong: true });
            if (f) quads.push(f);
          }
        }
        quads.sort((a, b) => a.depth - b.depth);
        items.push(...quads);
        topZ = Math.max(topZ, H(part.z + part.height));
        extend(part.center[0] - part.radius, part.center[1] - part.radius);
        extend(part.center[0] + part.radius, part.center[1] + part.radius);
        anchor = [part.center[0], part.center[1], H(part.z)];
        break;
      }
      case 'trees': {
        part.points.forEach((p, i) => {
          const r = p[2] ?? 4.5;
          items.push({
            kind: 'tree',
            x: p[0],
            y: p[1],
            r,
            variant: i % 4,
            depth: depthOf([p[0], p[1], 0]),
          });
          extend(p[0] - r, p[1] - r);
          extend(p[0] + r, p[1] + r);
          topZ = Math.max(topZ, H(r * 2.6));
        });
        items.sort((a, b) => a.depth - b.depth);
        // Деревья сортируются по отдельности вместе с другими частями.
        for (const it of items) groups.push({ depth: it.depth, order, items: [it] });
        return;
      }
      case 'sign': {
        const pos: V3 = [part.at[0], part.at[1], H(part.at[2])];
        items.push({ kind: 'sign', part, pos, depth: depthOf(pos) });
        topZ = Math.max(topZ, pos[2] + H(part.size));
        anchor = pos;
        break;
      }
      case 'billboard': {
        anchor = [part.center[0], part.center[1], H(part.z[0])];
        items.push({ kind: 'billboard', part, depth: depthOf(anchor) });
        topZ = Math.max(topZ, H(part.z[1]));
        extend(part.center[0] - part.width / 2, part.center[1]);
        extend(part.center[0] + part.width / 2, part.center[1]);
        break;
      }
      case 'image': {
        items.push({ kind: 'image', part, depth: 0 });
        if (part.footprint) {
          const o = ccw(part.footprint);
          footprints.push({ outline: o, height: part.height ?? 10 });
          o.forEach((p) => extend(p[0], p[1]));
        }
        topZ = Math.max(topZ, H(part.height ?? 0));
        // Размер картинки (в метрах) — прямо в плоскости изображения.
        const img = getImage(part.image);
        if (img) {
          const [ox, oy] = part.origin;
          imageBox.u0 = Math.min(imageBox.u0, -ox / part.ppm);
          imageBox.u1 = Math.max(imageBox.u1, (img.naturalWidth - ox) / part.ppm);
          imageBox.v0 = Math.min(imageBox.v0, -oy / part.ppm);
          imageBox.v1 = Math.max(imageBox.v1, (img.naturalHeight - oy) / part.ppm);
          // Верх картинки над точкой привязки — туда ставится подпись.
          topZ = Math.max(topZ, oy / part.ppm / view.c);
        }
        break;
      }
    }
    groups.push({ depth: depthOf(anchor), order, items });
  });

  groups.sort((g1, g2) => g1.depth - g2.depth || g1.order - g2.order);
  if (!Number.isFinite(minX)) {
    minX = minY = -1;
    maxX = maxY = 1;
  }
  const size = Math.max(maxX - minX, maxY - minY);

  // Габарит в плоскости изображения (на 1 px/м) — для размера спрайта.
  const u0 = Math.min(minX, imageBox.u0);
  const u1 = Math.max(maxX + view.a * topZ, imageBox.u1);
  const v0 = Math.min(-view.t * maxY - view.c * topZ, imageBox.v0);
  const v1 = Math.max(-view.t * minY, imageBox.v1);
  return {
    id: data.id,
    name: data.name,
    groups,
    ground,
    footprints,
    size,
    topZ,
    bounds: { u0, u1, v0, v1 },
  };
}

// ------------------------------------------------------------- отрисовка

/** Рисует модель: начало координат модели — в (0, 0) контекста, ps — пикселей на метр. */
export function drawModel(
  ctx: CanvasRenderingContext2D,
  m: CompiledModel,
  view: ViewParams,
  ps: number,
  mode: RenderMode = 'color',
) {
  const pu = (p: V3) => (p[0] + view.a * p[2]) * ps;
  const pv = (p: V3) => (-view.t * p[1] - view.c * p[2]) * ps;
  ctx.lineJoin = 'round';
  ctx.imageSmoothingQuality = 'high';
  const r: RenderCtx = { ctx, view, ps, pu, pv, mode, normal: normalColor(view) };

  for (const g of m.ground) {
    if (mode === 'lines') continue;
    ctx.beginPath();
    g.pts.forEach((p, i) => {
      const u = p[0] * ps;
      const v = -view.t * p[1] * ps;
      if (i === 0) ctx.moveTo(u, v);
      else ctx.lineTo(u, v);
    });
    ctx.closePath();
    ctx.fillStyle = mode === 'color' ? g.color : mode === 'clay' ? '#d9d9d9' : r.normal([0, 0, 1]);
    ctx.fill();
  }

  for (const g of m.groups) {
    for (const it of g.items) {
      if (it.kind === 'face') drawFace(r, it);
      else if (it.kind === 'tree') {
        const x = it.x * ps;
        const y = -view.t * it.y * ps;
        if (mode === 'color') drawTree(ctx, x, y, it.r * ps, view, it.variant);
        else
          drawGuideBlob(
            r,
            x + it.r * ps * 0.9 * view.a,
            y - it.r * ps * (0.9 * view.c + 0.55),
            it.r * ps,
          );
      } else if (it.kind === 'billboard') drawBillboard(r, it.part);
      else if (it.kind === 'image') {
        if (mode === 'color') drawImagePart(r, it.part);
      } else if (mode === 'color' || mode === 'clay') drawSign(ctx, it, view, ps, pu, pv);
    }
  }
}

interface RenderCtx {
  ctx: CanvasRenderingContext2D;
  view: ViewParams;
  ps: number;
  pu: (p: V3) => number;
  pv: (p: V3) => number;
  mode: RenderMode;
  normal: (n: V3) => string;
}

/**
 * Нормаль в цвет, как в картах нормалей: R — вправо по экрану, G — вверх, B — к зрителю.
 * Базис строится от направления взгляда косоугольной проекции.
 */
function normalColor(view: ViewParams): (n: V3) => string {
  const B = normalize([-view.a, -view.c / view.t, 1]);
  const e = B[0];
  const R = normalize([1 - e * B[0], -e * B[1], -e * B[2]]);
  const G: V3 = [B[1] * R[2] - B[2] * R[1], B[2] * R[0] - B[0] * R[2], B[0] * R[1] - B[1] * R[0]];
  const ch = (v: number) => Math.round(((v + 1) / 2) * 255);
  return (n) => `rgb(${ch(dot(n, R))},${ch(dot(n, G))},${ch(dot(n, B))})`;
}

function facePath(r: RenderCtx, f: Face) {
  const { ctx, pu, pv } = r;
  ctx.beginPath();
  f.pts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(pu(p), pv(p));
    else ctx.lineTo(pu(p), pv(p));
  });
  ctx.closePath();
}

function drawFace(r: RenderCtx, f: Face) {
  const { ctx, view, ps, pu, pv } = r;
  facePath(r, f);
  if (r.mode !== 'color') {
    ctx.fillStyle =
      r.mode === 'clay'
        ? rgb([224, 224, 224], f.k)
        : r.mode === 'normals'
          ? r.normal(f.n)
          : '#ffffff';
    ctx.fill();
    ctx.strokeStyle = r.mode === 'lines' ? '#000000' : (ctx.fillStyle as string);
    ctx.lineWidth = r.mode === 'lines' ? Math.max(1, ps * 0.12) : 0.8;
    ctx.stroke();
    return;
  }
  if (f.gradient) {
    const top = Math.min(...f.pts.map(pv));
    const bottom = Math.max(...f.pts.map(pv));
    const gr = ctx.createLinearGradient(0, top, 0, bottom);
    gr.addColorStop(0, f.gradient[0]);
    gr.addColorStop(1, f.gradient[1]);
    ctx.fillStyle = gr;
  } else {
    ctx.fillStyle = f.fill;
  }
  ctx.fill();
  const skin = f.wall?.skin && getImage(f.wall.skin.image);
  if (f.wall?.skin && skin) drawSkin(r, f, f.wall, f.wall.skin, skin);
  else if (f.wall?.facade === 'bays') drawBays(r, f, f.wall);
  else if (f.wall?.facade === 'balusters') drawBalusters(r, f, f.wall);
  ctx.strokeStyle = f.edge;
  ctx.lineWidth = Math.max(0.6, ps * 0.25);
  ctx.stroke();
  if (f.wall && !f.wall.skin && !['none', 'bays', 'balusters'].includes(f.wall.facade))
    drawFacade(ctx, f, f.wall, view, ps, pu, pv);
}

// ------------------------------------------------- картинки на моделях

/** Освещённость южной стены: фото фасада считаем снятым при таком свете. */
const SKIN_REF_LIGHT = AMBIENT + DIFFUSE * Math.max(0, dot([0, -1, 0], LIGHT));

type Picture = HTMLImageElement | HTMLCanvasElement;

const zSpace = new WeakMap<Picture, Map<string, Picture>>();

function sizeOf(p: Picture): [number, number] {
  return p instanceof HTMLImageElement ? [p.naturalWidth, p.naturalHeight] : [p.width, p.height];
}

/**
 * Картинка, пересчитанная по вертикали в «экранные» высоты Z = H(z). Выше linearUpTo
 * высоты сжимаются нелинейно; после пересчёта картинку можно класть одним аффинным
 * преобразованием — для косоугольной проекции это точно.
 */
function inZSpace(img: Picture, z0: number, z1: number, H: (z: number) => number): Picture {
  let cache = zSpace.get(img);
  if (!cache) zSpace.set(img, (cache = new Map()));
  const key = `${z0}|${z1}`;
  let out = cache.get(key);
  if (out) return out;
  const Z0 = H(z0);
  const Z1 = H(z1);
  const lin = (z: number) => Z0 + ((z - z0) / (z1 - z0)) * (Z1 - Z0);
  if (Math.abs(H((z0 + z1) / 2) - lin((z0 + z1) / 2)) < 0.01 * (Z1 - Z0)) {
    cache.set(key, img);
    return img;
  }
  const [w, h] = sizeOf(img);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const c = canvas.getContext('2d')!;
  for (let row = 0; row < h; row++) {
    const Z = Z1 - ((row + 0.5) / h) * (Z1 - Z0);
    let lo = z0;
    let hi = z1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (H(mid) < Z) lo = mid;
      else hi = mid;
    }
    const src = Math.min(h - 1, Math.max(0, ((z1 - lo) / (z1 - z0)) * h - 0.5));
    c.drawImage(img, 0, src, w, 1, 0, row, w, 1);
  }
  cache.set(key, canvas);
  return canvas;
}

/**
 * Кладёт картинку на вертикальную плоскость: от точки p0 по направлению d на длину len,
 * по высоте от z0 до z1. tile — ширина одного повтора в метрах.
 */
function drawPlaneImage(
  r: RenderCtx,
  img: Picture,
  p0: XY,
  d: XY,
  len: number,
  z0: number,
  z1: number,
  tile: number,
) {
  const { ctx, view, ps } = r;
  const tex = inZSpace(img, z0, z1, view.height);
  const [w, h] = sizeOf(img);
  const Z0 = view.height(z0);
  const Z1 = view.height(z1);
  const n = Math.max(1, Math.ceil(len / tile - 1e-6));
  for (let k = 0; k < n; k++) {
    const s0 = k * tile;
    ctx.save();
    ctx.transform(
      (ps * d[0] * tile) / w,
      (-ps * view.t * d[1] * tile) / w,
      (-ps * view.a * (Z1 - Z0)) / h,
      (ps * view.c * (Z1 - Z0)) / h,
      ps * (p0[0] + d[0] * s0 + view.a * Z1),
      ps * (-view.t * (p0[1] + d[1] * s0) - view.c * Z1),
    );
    ctx.drawImage(tex, 0, 0);
    ctx.restore();
  }
}

function drawSkin(r: RenderCtx, f: Face, w: Wall, skin: Skin, img: HTMLImageElement) {
  const { ctx } = r;
  const len = Math.hypot(w.p1[0] - w.p0[0], w.p1[1] - w.p0[1]);
  const d: XY = [(w.p1[0] - w.p0[0]) / len, (w.p1[1] - w.p0[1]) / len];
  const [z0, z1] = skin.z ?? [w.z0, w.z1];
  ctx.save();
  facePath(r, f);
  ctx.clip();
  drawPlaneImage(r, img, w.p0, d, len, z0, z1, skin.repeat ?? len);
  // Своё освещение у фото уже есть; стены в тени только притемняем.
  const dark = 1 - f.k / SKIN_REF_LIGHT;
  if (dark > 0.02) {
    ctx.fillStyle = `rgba(20,24,40,${Math.min(0.6, dark).toFixed(3)})`;
    ctx.fill();
  }
  ctx.restore();
  facePath(r, f);
}

const silhouettes = new WeakMap<HTMLImageElement, Map<string, HTMLCanvasElement>>();

/** Силуэт картинки одним цветом — для режимов-подсказок. */
function silhouette(img: HTMLImageElement, color: string): HTMLCanvasElement {
  let cache = silhouettes.get(img);
  if (!cache) silhouettes.set(img, (cache = new Map()));
  let c = cache.get(color);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const x = c.getContext('2d')!;
  x.drawImage(img, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, c.width, c.height);
  cache.set(color, c);
  return c;
}

function drawBillboard(r: RenderCtx, p: BillboardPart) {
  const img = getImage(p.image);
  if (!img) return;
  const p0: XY = [p.center[0] - p.width / 2, p.center[1]];
  if (r.mode === 'color') {
    drawPlaneImage(r, img, p0, [1, 0], p.width, p.z[0], p.z[1], p.width);
    return;
  }
  const color =
    r.mode === 'clay' ? '#c8c8c8' : r.mode === 'normals' ? r.normal([0, -1, 0]) : '#000';
  drawPlaneImage(r, silhouette(img, color), p0, [1, 0], p.width, p.z[0], p.z[1], p.width);
}

function drawImagePart(r: RenderCtx, p: ImagePart) {
  const img = getImage(p.image);
  if (!img) return;
  const k = r.ps / p.ppm;
  r.ctx.drawImage(
    img,
    -p.origin[0] * k,
    -p.origin[1] * k,
    img.naturalWidth * k,
    img.naturalHeight * k,
  );
}

function drawGuideBlob(r: RenderCtx, x: number, y: number, rad: number) {
  const { ctx } = r;
  ctx.beginPath();
  ctx.ellipse(x, y, rad, rad * 0.92, 0, 0, Math.PI * 2);
  if (r.mode === 'lines') {
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    ctx.fillStyle = r.mode === 'clay' ? '#b8b8b8' : r.normal([0, -0.3, 0.95]);
    ctx.fill();
  }
}

// ------------------------------------------- фасады «bays» и «balusters»

/** Четырёхугольник на стене: s — вдоль стены, z — высота, м. */
function wallQuad(r: RenderCtx, w: Wall) {
  const { ctx, view, pu, pv } = r;
  const len = Math.hypot(w.p1[0] - w.p0[0], w.p1[1] - w.p0[1]);
  const dx = (w.p1[0] - w.p0[0]) / len;
  const dy = (w.p1[1] - w.p0[1]) / len;
  const at = (s: number, z: number): V3 => [w.p0[0] + dx * s, w.p0[1] + dy * s, view.height(z)];
  return {
    len,
    quad(s0: number, s1: number, z0: number, z1: number) {
      const a = at(s0, z0);
      const b = at(s1, z0);
      const c = at(s1, z1);
      const d = at(s0, z1);
      ctx.moveTo(pu(a), pv(a));
      ctx.lineTo(pu(b), pv(b));
      ctx.lineTo(pu(c), pv(c));
      ctx.lineTo(pu(d), pv(d));
      ctx.closePath();
    },
  };
}

/**
 * Сталинский ордерный фасад: цоколь, опоры-пилястры с капителями, цветное заполнение
 * между ними, окна с белыми переплётами, фризовый этаж и тень под карнизом. Цвет
 * заполнения виден при любом масштабе; окна — когда пролёт крупнее нескольких пикселей.
 */
function drawBays(r: RenderCtx, f: Face, w: Wall) {
  const { ctx, ps, view } = r;
  const b = w.bays!;
  const { len, quad } = wallQuad(r, w);
  const height = w.z1 - w.z0;
  if (len < 1 || height < 1) return;
  const k = f.k;
  const col = (hex: string, kk = k) => rgb(parseColor(hex), kk);
  const nb = Math.max(1, Math.round(len / b.bay));
  const step = len / nb;
  const pierW = Math.min(step * 0.22, 2);
  const zA = w.z0 + Math.min(b.plinthHeight, height * 0.3);
  const zB = w.z1 - Math.min(b.friezeHeight, height * 0.3);
  const fill = (color: string, draw: () => void) => {
    ctx.beginPath();
    draw();
    ctx.fillStyle = color;
    ctx.fill();
  };
  ctx.save();
  facePath(r, f);
  ctx.clip();
  fill(col(b.plinth), () => quad(0, len, w.z0, zA));
  fill(col(b.panel), () => {
    for (let i = 0; i < nb; i++) quad(i * step + pierW / 2, (i + 1) * step - pierW / 2, zA, zB);
  });
  fill('rgba(255,255,255,0.28)', () => quad(0, len, zA, zA + 0.4));
  fill('rgba(30,25,20,0.22)', () => quad(0, len, w.z1 - 0.9, w.z1 - 0.2));
  const winPx = ((step - pierW) / b.windows) * ps;
  if (winPx >= 2.4 && w.floor * ps * view.c >= 2.4) {
    // Капители опор
    fill(col('#d8d2c2'), () => {
      for (let i = 0; i <= nb; i++) {
        const s = Math.min(len, Math.max(0, i * step));
        quad(Math.max(0, s - pierW * 0.6), Math.min(len, s + pierW * 0.6), zB - 0.9, zB);
      }
    });
    const slot = (step - pierW) / b.windows;
    const wins: [number, number, number, number][] = [];
    const rows = (z0: number, z1: number, fill: number) => {
      const n = Math.max(1, Math.round((z1 - z0) / w.floor));
      const fh = (z1 - z0) / n;
      for (let fl = 0; fl < n; fl++) {
        const zb = z0 + fl * fh + fh * (1 - fill) * 0.55;
        for (let i = 0; i < nb; i++)
          for (let j = 0; j < b.windows; j++) {
            const sc = i * step + pierW / 2 + (j + 0.5) * slot;
            wins.push([sc - slot * 0.27, sc + slot * 0.27, zb, zb + fh * fill]);
          }
      }
    };
    rows(zA, zB, 0.58);
    rows(w.z0, zA, 0.45);
    rows(zB, w.z1 - 0.9, 0.5);
    const fr = 0.18;
    fill(col(b.frame, Math.min(1, k * 1.08)), () => {
      for (const [s0, s1, z0, z1] of wins) quad(s0 - fr, s1 + fr, z0 - fr, z1 + fr);
    });
    fill(rgb([44, 58, 76], 0.9 + 0.2 * k), () => {
      for (const [s0, s1, z0, z1] of wins) quad(s0, s1, z0, z1);
    });
    if (slot * ps > 9) {
      // Переплёты
      fill(col(b.frame, Math.min(1, k * 1.08)), () => {
        for (const [s0, s1, z0, z1] of wins) {
          const sm = (s0 + s1) / 2;
          quad(sm - fr / 2, sm + fr / 2, z0, z1);
          const zm = z0 + (z1 - z0) * 0.62;
          quad(s0, s1, zm - fr / 2, zm + fr / 2);
        }
      });
    }
  }
  ctx.restore();
  facePath(r, f);
}

/** Балюстрада: перила, тумбы и тени между балясинами. */
function drawBalusters(r: RenderCtx, f: Face, w: Wall) {
  const { ctx, ps } = r;
  const { len, quad } = wallQuad(r, w);
  const h = w.z1 - w.z0;
  ctx.save();
  facePath(r, f);
  ctx.clip();
  ctx.beginPath();
  quad(0, len, w.z1 - h * 0.22, w.z1);
  quad(0, len, w.z0, w.z0 + h * 0.15);
  ctx.fillStyle = rgb([255, 255, 255], 0.9 + f.k * 0.1, 0.35);
  ctx.fill();
  if (0.5 * ps >= 2) {
    ctx.beginPath();
    for (let s = 0.3; s < len - 0.2; s += 0.5) quad(s, s + 0.22, w.z0 + h * 0.15, w.z1 - h * 0.22);
    ctx.fillStyle = 'rgba(40,40,50,0.28)';
    ctx.fill();
  }
  ctx.restore();
  facePath(r, f);
}

/** Окна, колонны, арки — рисуются только если на экране хватает пикселей. */
function drawFacade(
  ctx: CanvasRenderingContext2D,
  face: Face,
  w: Wall,
  view: ViewParams,
  ps: number,
  pu: (p: V3) => number,
  pv: (p: V3) => number,
) {
  const len = Math.hypot(w.p1[0] - w.p0[0], w.p1[1] - w.p0[1]);
  const height = w.z1 - w.z0;
  const floorPx = w.floor * ps * view.c;
  if (len < 2 || height < 2 || floorPx < 2.2) return;
  const dx = (w.p1[0] - w.p0[0]) / len;
  const dy = (w.p1[1] - w.p0[1]) / len;
  const at = (s: number, z: number): V3 => [w.p0[0] + dx * s, w.p0[1] + dy * s, view.height(z)];
  const quad = (s0: number, s1: number, z0: number, z1: number) => {
    const a = at(s0, z0);
    const b = at(s1, z0);
    const c = at(s1, z1);
    const d = at(s0, z1);
    ctx.moveTo(pu(a), pv(a));
    ctx.lineTo(pu(b), pv(b));
    ctx.lineTo(pu(c), pv(c));
    ctx.lineTo(pu(d), pv(d));
    ctx.closePath();
  };
  const floors = Math.max(1, Math.floor(height / w.floor));
  const fh = height / floors;

  ctx.save();
  // Ограничиваем рисование гранью.
  ctx.beginPath();
  face.pts.forEach((p, i) => (i === 0 ? ctx.moveTo(pu(p), pv(p)) : ctx.lineTo(pu(p), pv(p))));
  ctx.closePath();
  ctx.clip();

  if (w.facade === 'glass') {
    ctx.beginPath();
    for (let i = 1; i < floors; i++) {
      const z = w.z0 + i * fh;
      const a = at(0, z);
      const b = at(len, z);
      ctx.moveTo(pu(a), pv(a));
      ctx.lineTo(pu(b), pv(b));
    }
    const cols = Math.max(1, Math.round(len / 3));
    for (let i = 1; i < cols; i++) {
      const s = (i * len) / cols;
      const a = at(s, w.z0);
      const b = at(s, w.z1);
      ctx.moveTo(pu(a), pv(a));
      ctx.lineTo(pu(b), pv(b));
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = Math.max(0.5, ps * 0.12);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const spacing = w.facade === 'arches' ? 5 : w.facade === 'columns' ? 4 : 3.4;
  const cols = Math.floor(len / spacing);
  if (cols < 1 || spacing * ps < 2.5) {
    ctx.restore();
    return;
  }
  const step = len / cols;
  const glassColor = 'rgba(38,52,72,0.62)';

  if (w.facade === 'ribbon') {
    ctx.beginPath();
    for (let f = 0; f < floors; f++) {
      const z0 = w.z0 + f * fh + fh * 0.35;
      quad(step * 0.15, len - step * 0.15, z0, z0 + fh * 0.42);
    }
    ctx.fillStyle = glassColor;
    ctx.fill();
  } else if (w.facade === 'columns') {
    ctx.beginPath();
    for (let c = 0; c < cols; c++) {
      const s0 = c * step + step * 0.3;
      quad(s0, s0 + step * 0.4, w.z0 + fh * 0.3, w.z1 - fh * 0.5);
    }
    ctx.fillStyle = 'rgba(60,55,50,0.35)';
    ctx.fill();
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      const s0 = Math.min(len - step * 0.16, Math.max(0, c * step - step * 0.08));
      quad(s0, s0 + step * 0.16, w.z0 + fh * 0.15, w.z1 - fh * 0.4);
    }
    ctx.fillStyle = 'rgba(255,253,245,0.75)';
    ctx.fill();
  } else if (w.facade === 'arches') {
    ctx.beginPath();
    for (let f = 0; f < floors; f++) {
      const zb = w.z0 + f * fh + fh * 0.18;
      const zt = zb + fh * 0.62;
      for (let c = 0; c < cols; c++) {
        const s0 = c * step + step * 0.22;
        const s1 = s0 + step * 0.56;
        const r = (s1 - s0) / 2;
        const sm = (s0 + s1) / 2;
        const p0 = at(s0, zb);
        ctx.moveTo(pu(p0), pv(p0));
        const p1 = at(s1, zb);
        ctx.lineTo(pu(p1), pv(p1));
        for (let k = 0; k <= 6; k++) {
          const a = (k / 6) * Math.PI;
          const p = at(sm + Math.cos(a) * r, zt - r + Math.sin(a) * r);
          ctx.lineTo(pu(p), pv(p));
        }
        ctx.closePath();
      }
    }
    ctx.fillStyle = glassColor;
    ctx.fill();
  } else {
    ctx.beginPath();
    for (let f = 0; f < floors; f++) {
      const z0 = w.z0 + f * fh + fh * 0.3;
      for (let c = 0; c < cols; c++) {
        const s0 = c * step + step * 0.28;
        quad(s0, s0 + step * 0.44, z0, z0 + fh * 0.48);
      }
    }
    ctx.fillStyle = glassColor;
    ctx.fill();
  }
  ctx.restore();
}

const TREE_COLORS: [string, string, string][] = [
  ['#3f7d3a', '#5e9f4a', '#8cc46a'],
  ['#356f3c', '#4f9148', '#7fb863'],
  ['#4a8436', '#6aa747', '#9ccd6b'],
  ['#2f6a3f', '#468a4f', '#73ad6a'],
];

/** Дерево: (x, y) — основание ствола в пикселях, r — радиус кроны в пикселях. */
export function drawTree(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  view: ViewParams,
  variant: number,
) {
  const [dark, mid, light] = TREE_COLORS[variant % TREE_COLORS.length]!;
  const trunk = r * 0.9 * view.c;
  const cx = x + r * 0.9 * view.a;
  const cy = y - trunk - r * 0.55;
  if (r > 2.5) {
    ctx.strokeStyle = '#6b4f35';
    ctx.lineWidth = Math.max(1, r * 0.22);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(cx, cy + r * 0.3);
    ctx.stroke();
  }
  ctx.fillStyle = dark;
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.12, cy + r * 0.08, r, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = mid;
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.08, cy - r * 0.1, r * 0.8, r * 0.74, 0, 0, Math.PI * 2);
  ctx.fill();
  if (r > 2) {
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.25, cy - r * 0.32, r * 0.38, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawSign(
  ctx: CanvasRenderingContext2D,
  it: SignItem,
  view: ViewParams,
  ps: number,
  pu: (p: V3) => number,
  pv: (p: V3) => number,
) {
  const p = it.part;
  const x = pu(it.pos);
  const y = pv(it.pos);
  const s = Math.max(3, p.size * ps);
  switch (p.kind) {
    case 'metro': {
      const foot = pv([it.pos[0], it.pos[1], 0]);
      ctx.strokeStyle = '#5b6470';
      ctx.lineWidth = Math.max(1, s * 0.08);
      ctx.beginPath();
      ctx.moveTo(x - view.a * (y - foot), foot);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#d6262b';
      ctx.lineWidth = Math.max(1, s * 0.1);
      ctx.beginPath();
      ctx.arc(x, y - s * 0.5, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawMetroM(ctx, x, y - s * 0.5, s * 0.62, '#d6262b');
      break;
    }
    case 'cross': {
      ctx.strokeStyle = p.color ?? '#e8c25a';
      ctx.lineWidth = Math.max(0.8, s * 0.12);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - s);
      ctx.moveTo(x - s * 0.3, y - s * 0.72);
      ctx.lineTo(x + s * 0.3, y - s * 0.72);
      ctx.moveTo(x - s * 0.18, y - s * 0.4);
      ctx.lineTo(x + s * 0.18, y - s * 0.32);
      ctx.stroke();
      break;
    }
    case 'star': {
      ctx.fillStyle = p.color ?? '#d23b2e';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? s * 0.5 : s * 0.2;
        const px = x + Math.cos(a) * r;
        const py = y - s * 0.5 + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'flag': {
      ctx.strokeStyle = '#555';
      ctx.lineWidth = Math.max(0.8, s * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - s);
      ctx.stroke();
      const colors = ['#ffffff', '#1c57a5', '#d52b1e'];
      colors.forEach((c, i) => {
        ctx.fillStyle = c;
        ctx.fillRect(x, y - s + (i * s * 0.36) / 3, s * 0.55, (s * 0.36) / 3 + 0.3);
      });
      break;
    }
    case 'clock': {
      ctx.fillStyle = '#f6f2e6';
      ctx.strokeStyle = '#3b3a36';
      ctx.lineWidth = Math.max(0.6, s * 0.12);
      ctx.beginPath();
      ctx.ellipse(x, y - s * 0.5, s * 0.46, s * 0.5, -0.24, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (s > 5) {
        ctx.lineWidth = Math.max(0.6, s * 0.07);
        ctx.beginPath();
        ctx.moveTo(x, y - s * 0.5);
        ctx.lineTo(x + s * 0.08, y - s * 0.86);
        ctx.moveTo(x, y - s * 0.5);
        ctx.lineTo(x + s * 0.26, y - s * 0.42);
        ctx.stroke();
      }
      break;
    }
    case 'statue': {
      // Фигура на парапете: постамент, тело, голова, поднятая рука.
      ctx.fillStyle = p.color ?? '#9a9a96';
      const k = s / 10;
      ctx.beginPath();
      ctx.rect(x - 1.6 * k, y - 1.2 * k, 3.2 * k, 1.2 * k);
      ctx.moveTo(x - 1.1 * k, y - 1.2 * k);
      ctx.lineTo(x + 1.1 * k, y - 1.2 * k);
      ctx.lineTo(x + 1.3 * k, y - 6.6 * k);
      ctx.lineTo(x - 1.0 * k, y - 6.6 * k);
      ctx.closePath();
      ctx.moveTo(x + 1.2 * k, y - 6.2 * k);
      ctx.lineTo(x + 2.6 * k, y - 9.4 * k);
      ctx.lineTo(x + 2.1 * k, y - 9.7 * k);
      ctx.lineTo(x + 0.6 * k, y - 6.6 * k);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + 0.25 * k, y - 7.6 * k, 0.95 * k, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'text': {
      const fs = Math.max(6, s);
      ctx.font = `700 ${fs}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = p.color ?? '#ffffff';
      ctx.fillText(p.text ?? '', x, y);
      break;
    }
  }
}

/** Буква «М» метро, вписанная в квадрат size с центром (x, y). */
export function drawMetroM(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  const h = size * 0.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, size * 0.16);
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(x - h, y + h * 0.75);
  ctx.lineTo(x - h * 0.6, y - h * 0.75);
  ctx.lineTo(x, y + h * 0.35);
  ctx.lineTo(x + h * 0.6, y - h * 0.75);
  ctx.lineTo(x + h, y + h * 0.75);
  ctx.stroke();
  ctx.lineJoin = 'round';
}
