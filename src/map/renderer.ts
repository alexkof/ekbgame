import type { Camera } from './camera';
import {
  compileModel,
  drawMetroM,
  drawModel,
  drawTree,
  type CompiledModel,
  type ViewParams,
} from './model';
import { KIND_INFO, STYLE } from './style';
import type { ModelData } from './types';
import {
  pointInRing,
  type Pt,
  type World,
  type WorldLine,
  type WorldObject,
  type WorldPolygon,
} from './world';

/** Что показывать поверх данных: замены объектов из игрового состояния, выбор, отладка. */
export interface RenderState {
  /** Замены моделей: id объекта → id модели или null (объект убран, участок пуст). */
  structures: Record<string, string | null>;
  selectedId: string | null;
  debug: boolean;
}

interface Sprite {
  canvas: HTMLCanvasElement;
  /** Положение начала координат модели в спрайте, px. */
  ox: number;
  oy: number;
  ps: number;
}

interface Hit {
  obj: WorldObject;
  sprite: Sprite | null;
  x: number;
  y: number;
  scale: number;
  rect: [number, number, number, number];
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Цвета групп параллельных улиц в режиме разработчика. */
const GROUP_COLORS = ['#d6336c', '#1c7ed6', '#2b8a3e', '#e8590c', '#7048e8', '#0b7285', '#a61e4d'];

export class MapRenderer {
  readonly view: ViewParams;
  private ctx: CanvasRenderingContext2D;
  private compiled = new Map<string, CompiledModel>();
  private sprites = new Map<string, Sprite>();
  private treeAtlas = new Map<
    number,
    { canvas: HTMLCanvasElement; w: number; h: number; ox: number; oy: number }
  >();
  private paths = new WeakMap<object, Path2D>();
  private shadowPaths = new Map<string, Path2D>();
  private hits: Hit[] = [];
  private trees: World['trees'];
  dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    private models: Record<string, ModelData>,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D недоступен');
    this.ctx = ctx;
    const cam = world.projection.config.camera;
    this.view = {
      a: cam.lean * cam.heightFactor,
      c: cam.heightFactor,
      t: cam.groundTilt,
      height: (z) => world.projection.height(z),
    };
    this.trees = [...world.trees].sort((a, b) => a.y - b.y);
  }

  /** Сбросить собранные модели и спрайты — например, когда загрузились картинки моделей. */
  clearModelCache(): void {
    this.compiled.clear();
    this.sprites.clear();
  }

  model(id: string): CompiledModel | null {
    let m = this.compiled.get(id);
    if (!m) {
      const data = this.models[id];
      if (!data) return null;
      m = compileModel(data, this.view);
      this.compiled.set(id, m);
    }
    return m;
  }

  modelIdOf(obj: WorldObject, state: RenderState): string | null {
    const o = state.structures[obj.props.id];
    return o === undefined ? obj.props.model : o;
  }

  // ------------------------------------------------------------ кадр

  render(cam: Camera, state: RenderState): void {
    const { ctx, dpr, view } = this;
    const z = cam.zoom;
    const t = view.t;
    const W = cam.width;
    const Hh = cam.height;
    this.hits = [];

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = STYLE.outside;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const ground = () =>
      ctx.setTransform(
        dpr * z,
        0,
        0,
        dpr * z * t,
        dpr * (W / 2 - cam.cx * z),
        dpr * (Hh / 2 - cam.cy * z),
      );
    const r = cam.visibleRect(40);
    const vis = { x0: r.x0, x1: r.x1, y0: r.y0 / t, y1: r.y1 / t };
    // Для высоких объектов расширяем область видимости вниз (их основание может быть ниже экрана).
    const visTall = { x0: r.x0 - 300, x1: r.x1 + 100, y0: vis.y0 - 100, y1: vis.y1 + 600 / t };
    const inView = (b: Box, v = vis) =>
      b.x0 <= v.x1 && b.x1 >= v.x0 && b.y0 <= v.y1 && b.y1 >= v.y0;
    const px = 1 / z; // один CSS-пиксель в мировых единицах

    ground();
    // --- земля: диск города с мягким переходом центр → окраины
    const ext = this.world.projection.worldExtent;
    const grad = ctx.createRadialGradient(0, 0, ext * 0.05, 0, 0, ext);
    grad.addColorStop(0, STYLE.landCenter);
    grad.addColorStop(0.55, STYLE.landEdge);
    grad.addColorStop(1, STYLE.landEdge);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, ext, 0, Math.PI * 2);
    ctx.fill();

    // --- парки, лесопарки, площади
    for (const kind of ['forest', 'park', 'plaza'] as const) {
      ctx.fillStyle = STYLE[kind];
      for (const p of this.world.land)
        if (p.kind === kind && inView(p.bbox)) ctx.fill(this.polyPath(p));
    }

    // --- участки объектов: под водой и улицами, чтобы не перекрывать их
    for (const o of this.world.objects) {
      if (!inView(o.bbox)) continue;
      const empty = this.modelIdOf(o, state) === null;
      ctx.fillStyle = empty ? STYLE.plot.sand : STYLE.plot[o.props.ground ?? 'paving'];
      ctx.fill(this.plotPath(o));
    }

    // --- вода: сначала берег (обводка), потом вода
    ctx.strokeStyle = STYLE.bank;
    ctx.lineJoin = 'round';
    for (const p of this.world.water) {
      if (!inView(p.bbox)) continue;
      ctx.lineWidth = Math.max(
        5 * this.world.projection.scaleAtWorld(p.bbox.x0, p.bbox.y0),
        1.2 * px,
      );
      ctx.stroke(this.polyPath(p));
    }
    ctx.fillStyle = STYLE.water;
    for (const p of this.world.water) if (inView(p.bbox)) ctx.fill(this.polyPath(p));

    // --- железная дорога
    this.strokeLines(this.world.rail, vis, 7, 1.4 * px, STYLE.rail);
    if (z > 0.15) {
      ctx.setLineDash([10 * px, 10 * px]);
      this.strokeLines(this.world.rail, vis, 3, 0.6 * px, '#f4f0e6');
      ctx.setLineDash([]);
    }

    // --- улицы: обводки всех рангов, затем заливка от малых к главным
    ctx.lineCap = 'round';
    const streets = this.world.streets.filter(
      (s) => z >= (STYLE.street.minZoom[s.rank] ?? 0) && inView(s.bbox),
    );
    for (const s of streets) {
      const w = STYLE.street.width[s.rank]!;
      this.strokeLine(s, w + 6, (STYLE.street.minPx[s.rank]! + 1) * px, STYLE.street.casing);
    }
    for (const rank of [3, 2, 1]) {
      for (const s of streets) {
        if (s.rank !== rank) continue;
        this.strokeLine(
          s,
          STYLE.street.width[rank]!,
          STYLE.street.minPx[rank]! * px,
          STYLE.street.fill[rank]!,
        );
      }
    }
    if (z > 0.7) {
      ctx.setLineDash([6, 6]);
      for (const s of streets)
        if (s.rank === 1) this.strokeLine(s, 0.6, 0.6 * px, 'rgba(255,255,255,0.7)');
      ctx.setLineDash([]);
    }

    // --- трамвай и метро (под землёй — пунктиром)
    if (z > 0.08) this.strokeLines(this.world.tram, vis, 1.5, 0.7 * px, STYLE.tram);
    if (z < 0.3) {
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([10 * px, 7 * px]);
      this.strokeLines(this.world.metroLines, vis, 0, 2 * px, STYLE.metro);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // --- границы участков (выбранный и пустые — жёлтым пунктиром) и тени
    for (const o of this.world.objects) {
      if (!inView(o.bbox)) continue;
      const modelId = this.modelIdOf(o, state);
      const path = this.plotPath(o);
      const selected = state.selectedId === o.props.id;
      if (modelId === null || selected || state.debug) {
        ctx.setLineDash(modelId === null || selected ? [5 * px, 4 * px] : []);
        ctx.strokeStyle = selected || modelId === null ? STYLE.plot.selected : '#7a6a4d';
        ctx.lineWidth = (selected ? 2.5 : 1.5) * px;
        ctx.stroke(path);
        ctx.setLineDash([]);
      } else {
        ctx.strokeStyle = STYLE.plot.edge;
        ctx.lineWidth = 0.8 * px;
        ctx.stroke(path);
      }
    }
    ctx.fillStyle = STYLE.shadow;
    for (const o of this.world.objects) {
      if (!inView(o.bbox, visTall)) continue;
      const id = this.modelIdOf(o, state);
      if (!id) continue;
      const sp = this.shadowPath(o, id);
      if (sp) ctx.fill(sp, 'nonzero');
    }

    // --- объекты и деревья в порядке «с севера на юг»
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const toScreen = (X: number, Y: number): Pt => [
      dpr * ((X - cam.cx) * z + W / 2),
      dpr * ((Y * t - cam.cy) * z + Hh / 2),
    ];
    const objs = this.world.objects
      .filter((o) => inView(o.bbox, visTall))
      .sort((a, b) => a.anchor[1] - b.anchor[1]);
    const trees = this.trees;
    let ti = 0;
    const treeVis = { x0: vis.x0 - 20, x1: vis.x1 + 20, y0: vis.y0 - 10, y1: vis.y1 + 60 };
    const drawTreesUpTo = (y: number) => {
      for (; ti < trees.length && trees[ti]!.y <= y; ti++) {
        const tr = trees[ti]!;
        if (tr.x < treeVis.x0 || tr.x > treeVis.x1 || tr.y < treeVis.y0 || tr.y > treeVis.y1)
          continue;
        const rpx = tr.r * z * dpr;
        if (rpx < 1.6 * dpr) continue;
        const [sx, sy] = toScreen(tr.x, tr.y);
        this.drawTreeSprite(sx, sy, rpx, tr.variant);
      }
    };
    const markers: { o: WorldObject; x: number; y: number }[] = [];
    const labelAnchors: { o: WorldObject; x: number; y: number }[] = [];
    for (const o of objs) {
      drawTreesUpTo(o.anchor[1]);
      const id = this.modelIdOf(o, state);
      const [sx, sy] = toScreen(o.anchor[0], o.anchor[1]);
      if (!id) {
        labelAnchors.push({ o, x: sx / dpr, y: sy / dpr });
        continue;
      }
      const m = this.model(id);
      if (!m) continue;
      const ps = z * dpr * o.scale;
      if (m.size * ps < 9 * dpr) {
        markers.push({ o, x: sx / dpr, y: sy / dpr });
        continue;
      }
      const sprite = this.sprite(id, m, ps);
      const k = ps / sprite.ps;
      const x0 = sx - sprite.ox * k;
      const y0 = sy - sprite.oy * k;
      const w = sprite.canvas.width * k;
      const h = sprite.canvas.height * k;
      ctx.drawImage(sprite.canvas, x0, y0, w, h);
      this.hits.push({ obj: o, sprite, x: sx, y: sy, scale: k, rect: [x0, y0, x0 + w, y0 + h] });
      labelAnchors.push({ o, x: sx / dpr, y: (sy - (m.topZ * view.c * ps + 6 * dpr)) / dpr });
    }
    drawTreesUpTo(Infinity);

    // --- подписи (в CSS-пикселях)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Порядок = приоритет: подписи объектов важнее подписей улиц и районов.
    const boxes: Box[] = [];
    labelAnchors.sort(
      (a, b) =>
        Number(state.selectedId === b.o.props.id) - Number(state.selectedId === a.o.props.id) ||
        (a.o.props.importance ?? 3) - (b.o.props.importance ?? 3),
    );
    for (const la of labelAnchors) {
      const imp = la.o.props.importance ?? 3;
      const minZoom = imp === 1 ? 0.18 : imp === 2 ? 0.35 : imp === 3 ? 0.6 : Infinity;
      if (z * la.o.scale < minZoom && state.selectedId !== la.o.props.id) continue;
      this.drawObjectLabel(la.o, la.x, la.y, boxes, state.selectedId === la.o.props.id);
    }
    for (const mk of markers) this.drawMarker(mk.o, mk.x, mk.y, boxes);
    this.drawStations(cam, vis, boxes, state);
    this.drawWaterLabels(cam, vis, boxes);
    this.drawStreetLabels(cam, streets, boxes);
    if (z < 0.2) this.drawDistrictLabels(cam, vis, boxes);

    if (state.debug) this.drawDebug(cam, ground);
  }

  // ------------------------------------------------------------ пути

  private polyPath(p: WorldPolygon): Path2D {
    let path = this.paths.get(p);
    if (!path) {
      path = new Path2D();
      for (const ring of p.rings) addRing(path, ring);
      this.paths.set(p, path);
    }
    return path;
  }

  private plotPath(o: WorldObject): Path2D {
    let path = this.paths.get(o);
    if (!path) {
      path = new Path2D();
      addRing(path, o.plot);
      this.paths.set(o, path);
    }
    return path;
  }

  private runPath(run: object, pts: Pt[]): Path2D {
    let path = this.paths.get(run);
    if (!path) {
      path = new Path2D();
      pts.forEach((p, i) => (i === 0 ? path!.moveTo(p[0], p[1]) : path!.lineTo(p[0], p[1])));
      this.paths.set(run, path);
    }
    return path;
  }

  private strokeLine(l: WorldLine, widthM: number, minWidth: number, color: string) {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    for (const run of l.runs) {
      ctx.lineWidth = Math.max(widthM * run.k, minWidth);
      ctx.stroke(this.runPath(run, run.pts));
    }
  }

  private strokeLines(
    lines: WorldLine[],
    vis: Box,
    widthM: number,
    minWidth: number,
    color: string,
  ) {
    for (const l of lines) {
      const b = l.bbox;
      if (b.x0 > vis.x1 || b.x1 < vis.x0 || b.y0 > vis.y1 || b.y1 < vis.y0) continue;
      this.strokeLine(l, widthM, minWidth, color);
    }
  }

  /** Тень: контур основания, «протянутый» по направлению от солнца. */
  private shadowPath(o: WorldObject, modelId: string): Path2D | null {
    const key = `${o.props.id}|${modelId}`;
    let path = this.shadowPaths.get(key);
    if (path) return path;
    const m = this.model(modelId);
    if (!m) return null;
    path = new Path2D();
    const s = o.scale;
    const [ax, ay] = o.anchor;
    const toW = (x: number, y: number): Pt => [ax + x * s, ay - y * s];
    for (const fp of m.footprints) {
      const h = this.world.projection.height(fp.height) * 0.42;
      const sx = -0.22 * h;
      const sy = 0.6 * h;
      const base = fp.outline.map(([x, y]) => toW(x, y));
      const top = fp.outline.map(([x, y]) => toW(x + sx, y + sy));
      addRing(path, base, true);
      addRing(path, top, true);
      for (let i = 0; i < base.length; i++) {
        const j = (i + 1) % base.length;
        addRing(path, [base[i]!, base[j]!, top[j]!, top[i]!], true);
      }
    }
    this.shadowPaths.set(key, path);
    return path;
  }

  // ---------------------------------------------------------- спрайты

  private sprite(id: string, m: CompiledModel, ps: number): Sprite {
    // Спрайты кэшируются ступенями по трети октавы масштаба.
    const step = Math.round(Math.log2(ps) * 3);
    const key = `${id}|${step}`;
    let s = this.sprites.get(key);
    if (s) return s;
    let psB = Math.pow(2, step / 3);
    const b = m.bounds;
    const margin = 6;
    const maxSide = 3000;
    const side = Math.max(b.u1 - b.u0, b.v1 - b.v0) * psB;
    if (side > maxSide) psB *= maxSide / side;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((b.u1 - b.u0) * psB + margin * 2);
    canvas.height = Math.ceil((b.v1 - b.v0) * psB + margin * 2);
    const ctx = canvas.getContext('2d')!;
    const ox = margin - b.u0 * psB;
    const oy = margin - b.v0 * psB;
    ctx.translate(ox, oy);
    drawModel(ctx, m, this.view, psB);
    s = { canvas, ox, oy, ps: psB };
    if (this.sprites.size > 160) this.sprites.delete(this.sprites.keys().next().value!);
    this.sprites.set(key, s);
    return s;
  }

  /**
   * Деревья рисуются из атласа: все варианты в одном canvas, поэтому сотни вызовов
   * drawImage идут из одного источника и дёшевы даже на телефоне.
   */
  private drawTreeSprite(x: number, y: number, rpx: number, variant: number) {
    const R = rpx <= 14 ? 14 : 44;
    let a = this.treeAtlas.get(R);
    if (!a) {
      const canvas = document.createElement('canvas');
      const w = Math.ceil(R * 2.6 + 4);
      const h = Math.ceil(R * 3.6 + 4);
      canvas.width = w * 4;
      canvas.height = h;
      const ctx = canvas.getContext('2d')!;
      const ox = w / 2 - R * 0.2;
      const oy = h - 2;
      for (let i = 0; i < 4; i++) drawTree(ctx, i * w + ox, oy, R, this.view, i);
      a = { canvas, w, h, ox, oy };
      this.treeAtlas.set(R, a);
    }
    const k = rpx / R;
    this.ctx.drawImage(
      a.canvas,
      (variant % 4) * a.w,
      0,
      a.w,
      a.h,
      x - a.ox * k,
      y - a.oy * k,
      a.w * k,
      a.h * k,
    );
  }

  // ----------------------------------------------------------- подписи

  private placeBox(boxes: Box[], b: Box): boolean {
    for (const o of boxes)
      if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) return false;
    boxes.push(b);
    return true;
  }

  private drawObjectLabel(o: WorldObject, x: number, y: number, boxes: Box[], selected: boolean) {
    const ctx = this.ctx;
    const text = (o.props.label ?? o.props.name).toUpperCase();
    ctx.font = `700 11px ${FONT}`;
    const w = ctx.measureText(text).width + 14;
    const h = 20;
    const b = { x0: x - w / 2, y0: y - h - 6, x1: x + w / 2, y1: y };
    if (!this.placeBox(boxes, b) && !selected) return;
    ctx.fillStyle = selected ? '#fff6d8' : '#ffffff';
    ctx.strokeStyle = selected ? STYLE.plot.selected : 'rgba(0,0,0,0.12)';
    ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(b.x0, b.y0, w, h, 4);
    ctx.moveTo(x - 5, b.y0 + h);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 5, b.y0 + h);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = STYLE.label.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, b.y0 + h / 2 + 0.5);
  }

  private drawMarker(o: WorldObject, x: number, y: number, boxes: Box[]) {
    const imp = o.props.importance ?? 3;
    if (imp > 2) return;
    const r = imp === 1 ? 5 : 4;
    if (!this.placeBox(boxes, { x0: x - r, y0: y - r, x1: x + r, y1: y + r })) return;
    const ctx = this.ctx;
    ctx.fillStyle = KIND_INFO[o.props.kind].color;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private haloText(text: string, x: number, y: number, color: string, halo: string) {
    const ctx = this.ctx;
    ctx.lineWidth = 3;
    ctx.strokeStyle = halo;
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private drawStreetLabels(cam: Camera, streets: WorldLine[], boxes: Box[]) {
    const z = cam.zoom;
    if (z < 0.22) return;
    const ctx = this.ctx;
    const t = this.view.t;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const done = new Map<string, Pt[]>();
    const ranked = [...streets].sort((a, b) => a.rank - b.rank);
    for (const s of ranked) {
      if (!s.name || (s.rank === 3 && z < 0.5)) continue;
      const text = shortStreet(s.name);
      const tw = ctx.measureText(text).width;
      // Видимые прямые участки улицы, обрезанные краем экрана, от длинных к коротким. У
      // спрямлённой улицы узлы стоят на каждом перекрёстке, поэтому отрезки без поворота сливаются.
      const stretches: [Pt, Pt, number][] = [];
      for (const run of s.runs) {
        const pts = run.pts.map((p) => cam.planeToScreen(p[0], p[1] * t));
        let start = 0;
        for (let i = 1; i < pts.length; i++) {
          if (i < pts.length - 1 && !turns(pts[i - 1]!, pts[i]!, pts[i + 1]!)) continue;
          const seg = clipSegment(pts[start]!, pts[i]!, 20, 20, cam.width - 20, cam.height - 20);
          start = i;
          if (!seg) continue;
          const len = Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]);
          if (len >= tw + 24) stretches.push([seg[0], seg[1], len]);
        }
      }
      stretches.sort((p, q) => q[2] - p[2]);
      const prev = done.get(s.name) ?? [];
      // Подпись — посередине участка, а если там занято другой подписью — ближе к краям.
      placing: for (const [a, b, len] of stretches.slice(0, 3)) {
        let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        if (ang > Math.PI / 2) ang -= Math.PI;
        if (ang < -Math.PI / 2) ang += Math.PI;
        const ext = Math.abs(Math.cos(ang)) * tw + 8;
        const exty = Math.abs(Math.sin(ang)) * tw + 12;
        const room = (len - tw - 16) / (2 * len);
        for (const f of [0, -0.5, 0.5, -0.9, 0.9]) {
          const u = 0.5 + f * room;
          const mx = a[0] + (b[0] - a[0]) * u;
          const my = a[1] + (b[1] - a[1]) * u;
          if (prev.some((p) => Math.hypot(p[0] - mx, p[1] - my) < 260)) continue;
          const box = { x0: mx - ext / 2, y0: my - exty / 2, x1: mx + ext / 2, y1: my + exty / 2 };
          if (!this.placeBox(boxes, box)) continue;
          prev.push([mx, my]);
          done.set(s.name, prev);
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(ang);
          this.haloText(text, 0, 0, STYLE.label.street, STYLE.label.halo);
          ctx.restore();
          break placing;
        }
      }
    }
  }

  private drawWaterLabels(cam: Camera, vis: Box, boxes: Box[]) {
    const ctx = this.ctx;
    const z = cam.zoom;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of this.world.water) {
      if (!p.name || !p.labelAt) continue;
      const sizePx = Math.sqrt(p.area) * z;
      if (sizePx < 90) continue;
      const [x, y] = cam.planeToScreen(p.labelAt[0], p.labelAt[1] * this.view.t);
      if (x < 0 || y < 0 || x > cam.width || y > cam.height) continue;
      const text = spaced(p.name.toUpperCase());
      ctx.font = `600 ${sizePx > 300 ? 14 : 11}px ${FONT}`;
      const w = ctx.measureText(text).width;
      if (!this.placeBox(boxes, { x0: x - w / 2, y0: y - 9, x1: x + w / 2, y1: y + 9 })) continue;
      ctx.fillStyle = STYLE.label.water;
      ctx.fillText(text, x, y);
    }
    void vis;
  }

  private drawDistrictLabels(cam: Camera, vis: Box, boxes: Box[]) {
    const ctx = this.ctx;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const d of this.world.districts) {
      if (d.at[0] < vis.x0 || d.at[0] > vis.x1 || d.at[1] < vis.y0 || d.at[1] > vis.y1) continue;
      const [x, y] = cam.planeToScreen(d.at[0], d.at[1] * this.view.t);
      const text = spaced(d.name.toUpperCase());
      const w = ctx.measureText(text).width;
      if (!this.placeBox(boxes, { x0: x - w / 2 - 4, y0: y - 8, x1: x + w / 2 + 4, y1: y + 8 }))
        continue;
      this.haloText(text, x, y, STYLE.label.district, STYLE.label.halo);
    }
  }

  private drawStations(cam: Camera, vis: Box, boxes: Box[], state: RenderState) {
    const ctx = this.ctx;
    const z = cam.zoom;
    const metroObjects = this.world.objects.filter(
      (o) => o.props.kind === 'metro' && this.modelIdOf(o, state) !== null,
    );
    for (const s of this.world.stations) {
      if (s.at[0] < vis.x0 || s.at[0] > vis.x1 || s.at[1] < vis.y0 || s.at[1] > vis.y1) continue;
      // Если станция есть на карте отдельной моделью и та видна крупно — значок не нужен.
      const own = metroObjects.find(
        (o) => Math.hypot(o.anchor[0] - s.at[0], o.anchor[1] - s.at[1]) < 200,
      );
      if (own && z * own.scale > 0.35) continue;
      const [x, y] = cam.planeToScreen(s.at[0], s.at[1] * this.view.t);
      const r = 7;
      if (!this.placeBox(boxes, { x0: x - r, y0: y - r, x1: x + r, y1: y + r })) continue;
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#d6262b';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      drawMetroM(ctx, x, y, r * 1.25, '#d6262b');
      if (z > 0.09) {
        ctx.font = `600 10px ${FONT}`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(s.name).width;
        if (this.placeBox(boxes, { x0: x + r + 2, y0: y - 7, x1: x + r + 4 + tw, y1: y + 7 })) {
          this.haloText(s.name, x + r + 3, y, '#2b2b2b', STYLE.label.halo);
        }
        ctx.textAlign = 'center';
      }
    }
  }

  private drawDebug(cam: Camera, ground: () => void) {
    const ctx = this.ctx;
    const P = this.world.projection;
    const px = 1 / cam.zoom;
    ground();
    ctx.lineWidth = 1.5 * px;
    for (const zone of P.config.zones) {
      const rw =
        zone.radius *
        Math.pow(1 + (zone.radius / P.config.warp.radius) ** 2, -P.config.warp.power / 2);
      ctx.strokeStyle = 'rgba(200, 60, 40, 0.6)';
      ctx.setLineDash([8 * px, 6 * px]);
      ctx.beginPath();
      ctx.arc(0, 0, rw, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // Сетка реальных километров: показывает, как сжимаются окраины.
    ctx.strokeStyle = 'rgba(40, 90, 200, 0.25)';
    ctx.lineWidth = px;
    for (let km = 1; km <= 11; km++) {
      const r = km * 1000;
      const rw = r * Math.pow(1 + (r / P.config.warp.radius) ** 2, -P.config.warp.power / 2);
      ctx.beginPath();
      ctx.arc(0, 0, rw, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Граф улиц: прямые линии цветом своей группы параллельных, узлы — точками.
    const roads = this.world.roads;
    ctx.lineWidth = 3 * px;
    for (const line of roads.network.lines) {
      ctx.strokeStyle = GROUP_COLORS[line.group % GROUP_COLORS.length]!;
      ctx.beginPath();
      line.nodes.forEach((n, i) => {
        const [x, y] = roads.nodes[n]!;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.fillStyle = '#333';
    roads.nodes.forEach(([x, y], i) => {
      if (roads.edges[i]!.length === 2) return;
      ctx.fillRect(x - 2 * px, y - 2 * px, 4 * px, 4 * px);
    });
    ctx.fillStyle = '#c0392b';
    for (const o of this.world.objects) {
      ctx.beginPath();
      ctx.arc(o.anchor[0], o.anchor[1], 3 * px, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = 'left';
    for (const zone of P.config.zones) {
      const rw =
        zone.radius *
        Math.pow(1 + (zone.radius / P.config.warp.radius) ** 2, -P.config.warp.power / 2);
      const [x, y] = cam.planeToScreen(0, -rw * this.view.t);
      this.haloText(
        `${zone.name} · ${zone.radius / 1000} км`,
        x + 4,
        y - 8,
        '#a33',
        STYLE.label.halo,
      );
    }
  }

  // -------------------------------------------------------------- выбор

  /** Объект под точкой экрана (CSS-пиксели): по непрозрачным пикселям спрайта или по участку. */
  pick(cam: Camera, x: number, y: number): WorldObject | null {
    const sx = x * this.dpr;
    const sy = y * this.dpr;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i]!;
      const [x0, y0, x1, y1] = h.rect;
      if (sx < x0 || sx > x1 || sy < y0 || sy > y1 || !h.sprite) continue;
      const u = Math.floor((sx - x0) / h.scale);
      const v = Math.floor((sy - y0) / h.scale);
      const ctx = h.sprite.canvas.getContext('2d');
      if (!ctx) continue;
      const alpha = ctx.getImageData(u, v, 1, 1).data[3] ?? 0;
      if (alpha > 40) return h.obj;
    }
    const [px, py] = cam.screenToPlane(x, y);
    const X = px;
    const Y = py / this.view.t;
    for (const o of this.world.objects) {
      if (pointInRing(X, Y, o.plot)) return o;
    }
    return null;
  }
}

// ------------------------------------------------------------- утилиты

function addRing(path: Path2D, ring: Pt[], positive = false) {
  let pts = ring;
  if (positive) {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i]!;
      const q = ring[(i + 1) % ring.length]!;
      s += p[0] * q[1] - q[0] * p[1];
    }
    if (s < 0) pts = [...ring].reverse();
  }
  pts.forEach((p, i) => (i === 0 ? path.moveTo(p[0], p[1]) : path.lineTo(p[0], p[1])));
  path.closePath();
}

/** Поворачивает ли линия в точке b больше чем на ~1,5°. */
function turns(a: Pt, b: Pt, c: Pt): boolean {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  return Math.abs(ux * vy - uy * vx) > 0.026 * Math.hypot(ux, uy) * Math.hypot(vx, vy);
}

/** Часть отрезка внутри прямоугольника (Лианг — Барски) или null. */
function clipSegment(a: Pt, b: Pt, x0: number, y0: number, x1: number, y1: number) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [
    [-dx, a[0] - x0],
    [dx, x1 - a[0]],
    [-dy, a[1] - y0],
    [dy, y1 - a[1]],
  ] as const) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ] as [Pt, Pt];
}

function shortStreet(name: string): string {
  return name
    .replace(/^улица /, 'ул. ')
    .replace(/ улица$/, ' ул.')
    .replace(/^проспект /, 'пр. ')
    .replace(/^переулок /, 'пер. ');
}

function spaced(s: string): string {
  return s.split('').join(' ');
}
