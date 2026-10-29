import type { Facade, ModelData, ModelPart, SignPart, XY } from './types';

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
type Item = Face | TreeItem | SignItem;

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
  ) => {
    const Z0 = H(z0);
    const Z1 = H(z1);
    const walls: Face[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      const f = faceFrom(
        [
          [p[0], p[1], Z0],
          [q[0], q[1], Z0],
          [q[0], q[1], Z1],
          [p[0], p[1], Z1],
        ],
        base,
        { wall: { p0: p, p1: q, z0, z1, facade, floor, base } },
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
        addSolidWalls(o, z0, z1, base, part.facade ?? 'grid', part.floor ?? 3.6, items);
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
          addSolidWalls(bottom, z0, z1, base, part.facade ?? 'none', part.floor ?? 3.6, items);
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
  const u0 = minX;
  const u1 = maxX + view.a * topZ;
  const v0 = -view.t * maxY - view.c * topZ;
  const v1 = -view.t * minY;
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
) {
  const pu = (p: V3) => (p[0] + view.a * p[2]) * ps;
  const pv = (p: V3) => (-view.t * p[1] - view.c * p[2]) * ps;
  ctx.lineJoin = 'round';

  for (const g of m.ground) {
    ctx.beginPath();
    g.pts.forEach((p, i) => {
      const u = p[0] * ps;
      const v = -view.t * p[1] * ps;
      if (i === 0) ctx.moveTo(u, v);
      else ctx.lineTo(u, v);
    });
    ctx.closePath();
    ctx.fillStyle = g.color;
    ctx.fill();
  }

  for (const g of m.groups) {
    for (const it of g.items) {
      if (it.kind === 'face') drawFace(ctx, it, view, ps, pu, pv);
      else if (it.kind === 'tree')
        drawTree(ctx, it.x * ps, -view.t * it.y * ps, it.r * ps, view, it.variant);
      else drawSign(ctx, it, view, ps, pu, pv);
    }
  }
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  f: Face,
  view: ViewParams,
  ps: number,
  pu: (p: V3) => number,
  pv: (p: V3) => number,
) {
  ctx.beginPath();
  f.pts.forEach((p, i) => {
    if (i === 0) ctx.moveTo(pu(p), pv(p));
    else ctx.lineTo(pu(p), pv(p));
  });
  ctx.closePath();
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
  ctx.strokeStyle = f.edge;
  ctx.lineWidth = Math.max(0.6, ps * 0.25);
  ctx.stroke();
  if (f.wall && f.wall.facade !== 'none') drawFacade(ctx, f, f.wall, view, ps, pu, pv);
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
