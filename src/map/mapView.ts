import { Camera } from './camera';
import { MapRenderer, type RenderState } from './renderer';
import type { LonLat, ModelData } from './types';
import type { World, WorldObject } from './world';

/**
 * Виджет карты: canvas, перетаскивание, зум колесом и щипком, выбор объекта касанием.
 * Перерисовка — только когда что-то изменилось.
 */
export class MapView {
  readonly camera = new Camera();
  readonly canvas: HTMLCanvasElement;
  readonly renderer: MapRenderer;
  private state: RenderState;
  private frame = 0;
  private pointers = new Map<number, { x: number; y: number }>();
  private tap: { x: number; y: number; time: number; moved: boolean } | null = null;
  private lastTap = 0;
  private velocity = { x: 0, y: 0, time: 0 };
  private anim: ((now: number) => boolean) | null = null;
  private resizeObserver: ResizeObserver;

  onSelect: (obj: WorldObject | null) => void = () => {};
  onHover: (geo: LonLat | null) => void = () => {};

  constructor(
    private container: HTMLElement,
    readonly world: World,
    models: Record<string, ModelData>,
    state: RenderState,
  ) {
    this.state = state;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'map-canvas';
    container.append(this.canvas);
    this.renderer = new MapRenderer(this.canvas, world, models);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.home(false);
    this.bindInput();
  }

  setState(patch: Partial<RenderState>): void {
    this.state = { ...this.state, ...patch };
    this.invalidate();
  }

  getState(): RenderState {
    return this.state;
  }

  invalidate(): void {
    if (!this.frame) this.frame = requestAnimationFrame((t) => this.draw(t));
  }

  private draw(now: number) {
    this.frame = 0;
    if (this.anim && this.anim(now)) this.invalidate();
    else this.anim = null;
    this.clamp();
    this.renderer.render(this.camera, this.state);
  }

  private resize() {
    const r = this.container.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cam = this.camera;
    cam.width = Math.max(1, r.width);
    cam.height = Math.max(1, r.height);
    this.canvas.width = Math.round(cam.width * dpr);
    this.canvas.height = Math.round(cam.height * dpr);
    this.canvas.style.width = `${cam.width}px`;
    this.canvas.style.height = `${cam.height}px`;
    this.renderer.dpr = dpr;
    const ext = this.world.projection.worldExtent;
    cam.minZoom = Math.min(cam.width, cam.height) / (ext * 2.1);
    this.invalidate();
  }

  /** Стартовый вид: центр города крупно. */
  home(animate = true): void {
    const zoom = Math.min(this.camera.width, this.camera.height) / 900;
    this.flyTo(-60, -140, Math.min(0.62, Math.max(zoom, 0.42)), animate);
  }

  /** Весь город целиком. */
  overview(): void {
    this.flyTo(0, 0, this.camera.minZoom * 1.05, true);
  }

  zoomBy(factor: number): void {
    const cam = this.camera;
    this.flyTo(cam.cx, cam.cy, cam.zoom * factor, true);
  }

  focusObject(obj: WorldObject): void {
    const t = this.renderer.view.t;
    const zoom = Math.max(this.camera.zoom, 0.9 / obj.scale);
    // Объект ставим чуть выше центра: снизу открывается карточка.
    this.flyTo(
      obj.anchor[0],
      obj.anchor[1] * t - 60 / zoom + (this.camera.height * 0.12) / zoom,
      zoom,
      true,
    );
  }

  flyTo(cx: number, cy: number, zoom: number, animate: boolean): void {
    const cam = this.camera;
    zoom = Math.min(cam.maxZoom, Math.max(cam.minZoom, zoom));
    if (!animate) {
      cam.cx = cx;
      cam.cy = cy;
      cam.zoom = zoom;
      this.invalidate();
      return;
    }
    const from = { cx: cam.cx, cy: cam.cy, lz: Math.log(cam.zoom) };
    const to = { cx, cy, lz: Math.log(zoom) };
    let start = 0;
    const dur = 450;
    this.anim = (now) => {
      if (!start) start = now;
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      cam.cx = from.cx + (to.cx - from.cx) * e;
      cam.cy = from.cy + (to.cy - from.cy) * e;
      cam.zoom = Math.exp(from.lz + (to.lz - from.lz) * e);
      return p < 1;
    };
    this.invalidate();
  }

  /** Не даём увести карту за пределы города. */
  private clamp() {
    const cam = this.camera;
    const ext = this.world.projection.worldExtent;
    const t = this.renderer.view.t;
    cam.zoom = Math.min(cam.maxZoom, Math.max(cam.minZoom, cam.zoom));
    cam.cx = Math.max(-ext, Math.min(ext, cam.cx));
    cam.cy = Math.max(-ext * t, Math.min(ext * t, cam.cy));
  }

  private bindInput() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      this.anim = null;
      this.velocity = { x: 0, y: 0, time: performance.now() };
      this.tap =
        this.pointers.size === 1
          ? { x: e.offsetX, y: e.offsetY, time: performance.now(), moved: false }
          : null;
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') this.hover(e.offsetX, e.offsetY);
        return;
      }
      const cam = this.camera;
      if (this.pointers.size === 1) {
        const dx = e.offsetX - p.x;
        const dy = e.offsetY - p.y;
        cam.panBy(dx, dy);
        const now = performance.now();
        const dt = Math.max(1, now - this.velocity.time);
        this.velocity = {
          x: (dx / dt) * 0.8 + this.velocity.x * 0.2,
          y: (dy / dt) * 0.8 + this.velocity.y * 0.2,
          time: now,
        };
        if (this.tap && Math.hypot(e.offsetX - this.tap.x, e.offsetY - this.tap.y) > 6)
          this.tap.moved = true;
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.entries()];
        const other = a![0] === e.pointerId ? b![1] : a![1];
        const before = Math.hypot(p.x - other.x, p.y - other.y);
        const after = Math.hypot(e.offsetX - other.x, e.offsetY - other.y);
        const mx0 = (p.x + other.x) / 2;
        const my0 = (p.y + other.y) / 2;
        const mx1 = (e.offsetX + other.x) / 2;
        const my1 = (e.offsetY + other.y) / 2;
        if (before > 0) cam.zoomAt(mx0, my0, after / before);
        cam.panBy(mx1 - mx0, my1 - my0);
      }
      p.x = e.offsetX;
      p.y = e.offsetY;
      this.invalidate();
    });
    const up = (e: PointerEvent) => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const now = performance.now();
      if (this.tap && !this.tap.moved && now - this.tap.time < 500) {
        if (now - this.lastTap < 300) {
          this.zoomAround(e.offsetX, e.offsetY, 2);
          this.lastTap = 0;
        } else {
          this.lastTap = now;
          this.onSelect(this.renderer.pick(this.camera, e.offsetX, e.offsetY));
        }
      } else if (this.pointers.size === 0 && now - this.velocity.time < 80) {
        this.fling();
      }
      this.tap = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => this.onHover(null));
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const k = e.deltaMode === 1 ? 40 : 1;
        this.anim = null;
        this.camera.zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * k * 0.0016));
        this.invalidate();
      },
      { passive: false },
    );
  }

  private zoomAround(x: number, y: number, factor: number) {
    const cam = this.camera;
    const [px, py] = cam.screenToPlane(x, y);
    const zoom = Math.min(cam.maxZoom, cam.zoom * factor);
    // Точка под пальцем остаётся на месте.
    const cx = px - (x - cam.width / 2) / zoom;
    const cy = py - (y - cam.height / 2) / zoom;
    this.flyTo(cx, cy, zoom, true);
  }

  private fling() {
    let { x: vx, y: vy } = this.velocity;
    if (Math.hypot(vx, vy) < 0.15) return;
    let last = 0;
    this.anim = (now) => {
      const dt = last ? now - last : 16;
      last = now;
      this.camera.panBy(vx * dt, vy * dt);
      vx *= Math.pow(0.994, dt);
      vy *= Math.pow(0.994, dt);
      return Math.hypot(vx, vy) > 0.02;
    };
    this.invalidate();
  }

  private hover(x: number, y: number) {
    const [px, py] = this.camera.screenToPlane(x, y);
    this.onHover(this.world.projection.worldToGeo(px, py / this.renderer.view.t));
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
    this.canvas.remove();
  }
}
