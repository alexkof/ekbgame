import { MAP_CONFIG, MAP_LAYERS, MAP_MODELS, MAP_OBJECTS, MAP_STRAIGHTEN } from '../src/map/data';
import { imagesOf, loadModelImages } from '../src/map/images';
import { MapView } from '../src/map/mapView';
import {
  compileModel,
  drawModel,
  type CompiledModel,
  type RenderMode,
  type ViewParams,
} from '../src/map/model';
import { createProjection } from '../src/map/projection';
import { STYLE } from '../src/map/style';
import type { ModelData } from '../src/map/types';
import { buildWorld } from '../src/map/world';

/**
 * Лаборатория моделей: варианты одного объекта рядом, на карте и в виде каркаса для
 * художника/генератора. Открывается по адресу /lab/ (и в npm run dev, и на сайте).
 */

const labModels = import.meta.glob<ModelData>('./models/*.json', {
  eager: true,
  import: 'default',
});
const labImages = import.meta.glob<string>('./models/**/*.{png,jpg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});
const IMAGE_URLS = Object.fromEntries(
  Object.entries(labImages).map(([path, url]) => [path.replace('./models/', ''), url]),
);
const MODELS: Record<string, ModelData> = {
  ...MAP_MODELS,
  ...Object.fromEntries(Object.values(labModels).map((m) => [m.id, m])),
};

const OBJECT_ID = 'city-hall';
const VARIANTS = [
  { id: 'city-hall', title: 'A. Сейчас', note: 'Примитивы, один рисунок фасада на все стены' },
  {
    id: 'city-hall-procedural',
    title: 'B. Процедурные фасады',
    note: 'Ордерный фасад «bays», портик из цилиндров, ярусная башня, статуи',
  },
  {
    id: 'city-hall-photo-raw',
    title: 'C. Фото как есть',
    note: 'Фасад выпрямлен с фото по 4 точкам, ничего не чистили',
  },
  {
    id: 'city-hall-photo-kit',
    title: 'D. Фото-кит',
    note: 'Фасад собран из чистых пролётов фото, башня — билборд',
  },
  {
    id: 'city-hall-sprite',
    title: 'E. Запечённый спрайт',
    note: 'Готовая картинка в проекции карты (запекание D + стилизация)',
  },
  {
    id: 'city-hall-art',
    title: 'F. Рисунок по каркасу',
    note: 'Рисунок художника или генератора поверх каркаса B, фон вырезан по силуэту модели',
  },
  // Картинки из фото не хранятся в git (см. lab/README.md): без них вариант не показываем.
].filter((v) => MODELS[v.id] && imagesOf(MODELS[v.id]!).every((name) => IMAGE_URLS[name]));

const projection = createProjection(MAP_CONFIG, MAP_STRAIGHTEN);
const cam = MAP_CONFIG.camera;
const VIEW: ViewParams = {
  a: cam.lean * cam.heightFactor,
  c: cam.heightFactor,
  t: cam.groundTilt,
  height: (z) => projection.height(z),
};
const world = buildWorld(projection, MAP_LAYERS, MAP_OBJECTS);
const object = world.objects.find((o) => o.props.id === OBJECT_ID)!;
const dpr = Math.min(window.devicePixelRatio || 1, 2);

const compiled = new Map<string, CompiledModel>();
function model(id: string): CompiledModel {
  let m = compiled.get(id);
  if (!m) compiled.set(id, (m = compileModel(MODELS[id]!, VIEW)));
  return m;
}

// ----------------------------------------------------------- отрисовка

interface Rendered {
  canvas: HTMLCanvasElement;
  /** Пиксель начала координат модели. */
  origin: [number, number];
}

/** Модель отдельно, ps — пикселей на метр (в пикселях холста). */
function renderModel(id: string, ps: number, mode: RenderMode, withGround: boolean): Rendered {
  const m = model(id);
  const plot = object.plot.map(([x, y]) => [
    (x - object.anchor[0]) / object.scale,
    -(y - object.anchor[1]) / object.scale,
  ]);
  const b = { ...m.bounds };
  if (withGround) {
    for (const [x, y] of plot) {
      b.u0 = Math.min(b.u0, x! - 4);
      b.u1 = Math.max(b.u1, x! + 4);
      b.v0 = Math.min(b.v0, -VIEW.t * y! - 4);
      b.v1 = Math.max(b.v1, -VIEW.t * y! + 4);
    }
  }
  const margin = 8;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil((b.u1 - b.u0) * ps + margin * 2);
  canvas.height = Math.ceil((b.v1 - b.v0) * ps + margin * 2);
  const ctx = canvas.getContext('2d')!;
  const ox = margin - b.u0 * ps;
  const oy = margin - b.v0 * ps;
  if (withGround) {
    ctx.fillStyle = STYLE.landCenter;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.translate(ox, oy);
    ctx.beginPath();
    plot.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x! * ps, -VIEW.t * y! * ps));
    ctx.closePath();
    ctx.fillStyle = STYLE.plot.paving;
    ctx.fill();
    ctx.strokeStyle = STYLE.plot.edge;
    ctx.stroke();
    // Тень — как на карте: основание, протянутое от солнца на северо-запад.
    ctx.beginPath();
    for (const fp of m.footprints) {
      const h = VIEW.height(fp.height) * 0.42;
      const base = fp.outline;
      const top = base.map(([x, y]) => [x - 0.22 * h, y + 0.6 * h] as const);
      const ring = (pts: readonly (readonly [number, number])[]) => {
        pts.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](x * ps, -VIEW.t * y * ps));
        ctx.closePath();
      };
      ring(base);
      ring(top);
      for (let i = 0; i < base.length; i++) {
        const j = (i + 1) % base.length;
        ring([base[i]!, base[j]!, top[j]!, top[i]!]);
      }
    }
    ctx.fillStyle = STYLE.shadow;
    ctx.fill('nonzero');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  ctx.translate(ox, oy);
  drawModel(ctx, m, VIEW, ps, mode);
  return { canvas, origin: [ox, oy] };
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function radio(container: HTMLElement, items: [string, () => void][], initial = 0) {
  const buttons = items.map(([label, fn], i) =>
    button(label, () => {
      buttons.forEach((b, j) => b.classList.toggle('active', i === j));
      fn();
    }),
  );
  container.append(...buttons);
  buttons[initial]?.click();
  return buttons;
}

// ------------------------------------------------------------ варианты

const SCALES: [string, number][] = [
  ['Как на стартовом экране · 0,8 px/м', 0.8],
  ['Приближено · 2 px/м', 2],
  ['Крупно · 5 px/м', 5],
];

function showTiles(ps: number) {
  const tiles = document.querySelector<HTMLElement>('#tiles')!;
  tiles.innerHTML = '';
  for (const v of VARIANTS) {
    const { canvas } = renderModel(v.id, ps * object.scale * dpr, 'color', true);
    canvas.style.width = `${canvas.width / dpr}px`;
    canvas.style.maxWidth = '100%';
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.variant = v.id;
    tile.append(canvas);
    tile.insertAdjacentHTML('beforeend', `<b>${v.title}</b><small>${v.note}</small>`);
    tiles.append(tile);
  }
}

// --------------------------------------------------------------- карта

const mapEl = document.querySelector<HTMLElement>('#map')!;
let view: MapView;

function setVariant(id: string) {
  view.setState({ structures: { [OBJECT_ID]: id } });
}

function setZoom(zoom: number) {
  const t = VIEW.t;
  view.flyTo(object.anchor[0] + 40, object.anchor[1] * t - 20, zoom, false);
}

// ------------------------------------------------------------- каркас

function download(name: string, url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

const GUIDE_PPM = 8;
const GUIDE_MODES: [RenderMode, string][] = [
  ['color', 'Цвет'],
  ['clay', 'Глина'],
  ['normals', 'Нормали'],
  ['lines', 'Контуры'],
];

function guideMeta(id: string, r: Rendered) {
  return {
    model: id,
    ppm: GUIDE_PPM,
    origin: r.origin.map((v) => Math.round(v * 100) / 100),
    size: [r.canvas.width, r.canvas.height],
    camera: MAP_CONFIG.camera,
    heights: MAP_CONFIG.heights,
    note: 'Спрайт рисовать в тех же пикселях; в модели: {"type":"image","origin":…,"ppm":…}',
  };
}

function showGuides(id: string) {
  const box = document.querySelector<HTMLElement>('#guides')!;
  box.innerHTML = '';
  for (const [mode, title] of GUIDE_MODES) {
    const r = renderModel(id, GUIDE_PPM, mode, false);
    if (mode === 'lines' || mode === 'normals') {
      // Подложка: генераторы ждут непрозрачный фон.
      const bg = document.createElement('canvas');
      bg.width = r.canvas.width;
      bg.height = r.canvas.height;
      const ctx = bg.getContext('2d')!;
      ctx.fillStyle = mode === 'lines' ? '#ffffff' : '#000000';
      ctx.fillRect(0, 0, bg.width, bg.height);
      ctx.drawImage(r.canvas, 0, 0);
      r.canvas = bg;
    }
    r.canvas.style.width = '100%';
    r.canvas.style.background = 'repeating-conic-gradient(#eee 0 25%, #fff 0 50%) 0 0 / 16px 16px';
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.append(r.canvas);
    tile.insertAdjacentHTML('beforeend', `<b>${title}</b>`);
    const controls = document.createElement('div');
    controls.className = 'controls';
    controls.append(
      button('PNG', () => download(`${id}-${mode}.png`, r.canvas.toDataURL('image/png'))),
      button('JSON', () =>
        download(
          `${id}-guide.json`,
          URL.createObjectURL(
            new Blob([JSON.stringify(guideMeta(id, r), null, 2)], { type: 'application/json' }),
          ),
        ),
      ),
    );
    tile.append(controls);
    box.append(tile);
  }
}

// --------------------------------------------------------------- старт

await loadModelImages(MODELS, IMAGE_URLS);

radio(
  document.querySelector<HTMLElement>('#scales')!,
  SCALES.map(([label, ps]) => [label, () => showTiles(ps)]),
);

view = new MapView(mapEl, world, MODELS, {
  structures: { [OBJECT_ID]: 'city-hall' },
  selectedId: null,
  debug: false,
});
radio(
  document.querySelector<HTMLElement>('#variants')!,
  VARIANTS.map((v) => [v.title, () => setVariant(v.id)]),
);
radio(document.querySelector<HTMLElement>('#zooms')!, [
  ['Стартовый зум', () => setZoom(0.62)],
  ['Ближе', () => setZoom(1.6)],
  ['Крупно', () => setZoom(4)],
]);
radio(
  document.querySelector<HTMLElement>('#guideModels')!,
  ['city-hall-procedural', 'city-hall', 'city-hall-photo-kit']
    .filter((id) => MODELS[id])
    .map((id) => [MODELS[id]!.name, () => showGuides(id)]),
);

/** Для автоматических снимков (Playwright). */
Object.assign(window, {
  lab: {
    setVariant,
    setZoom,
    showTiles,
    render(id: string, mode: RenderMode, ppm: number, withGround = false) {
      const r = renderModel(id, ppm, mode, withGround);
      return { url: r.canvas.toDataURL('image/png'), origin: r.origin, ppm };
    },
  },
});
