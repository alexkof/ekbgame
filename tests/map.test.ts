import { describe, expect, it } from 'vitest';
import { MAP_CONFIG, MAP_LAYERS, MAP_MODELS, MAP_OBJECTS, MAP_STRAIGHTEN } from '../src/map/data';
import { compileModel } from '../src/map/model';
import {
  createProjection,
  radialScale,
  tangentialScale,
  unwarpRadius,
  warpRadius,
} from '../src/map/projection';
import { nearestNode, pathLength, shortestPath } from '../src/map/roads';
import { KIND_INFO } from '../src/map/style';
import type { LonLat } from '../src/map/types';
import { buildWorld, pointInRing, splitByScale } from '../src/map/world';

const P = createProjection(MAP_CONFIG, MAP_STRAIGHTEN);
/** Только радиальное сжатие, без спрямления. */
const P0 = createProjection(MAP_CONFIG);
const { radius, power, extent } = MAP_CONFIG.warp;

describe('проекция', () => {
  it('гео → мир → гео возвращает исходную точку (и со спрямлением, и без)', () => {
    const points: LonLat[] = [
      [MAP_CONFIG.origin.lon, MAP_CONFIG.origin.lat],
      [60.5907, 56.8436], // башня «Исеть»
      [60.6053, 56.8585], // вокзал
      [60.6255, 56.8395], // Луначарского — Ленина
      [60.47, 56.79], // окраина
    ];
    for (const proj of [P, P0]) {
      for (const p of points) {
        const [X, Y] = proj.geoToWorld(p);
        const [lon, lat] = proj.worldToGeo(X, Y);
        expect(lon).toBeCloseTo(p[0], 7);
        expect(lat).toBeCloseTo(p[1], 7);
      }
    }
  });

  it('поле спрямления посчитано для текущих параметров сжатия и плавное', () => {
    expect(MAP_STRAIGHTEN.warp).toEqual({ radius, power });
    // Спрямление сдвигает точки, но не переворачивает и не рвёт карту: соседние точки
    // остаются соседними (локальное растяжение в разумных пределах).
    for (let x = -3000; x <= 3000; x += 137) {
      for (let y = -3000; y <= 3000; y += 137) {
        const g = P0.worldToGeo(x, y);
        const a = P.geoToWorld(g);
        const b = P.geoToWorld(P0.worldToGeo(x + 10, y));
        const c = P.geoToWorld(P0.worldToGeo(x, y + 10));
        const det = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 100;
        expect(det, `${x}, ${y}`).toBeGreaterThan(0.5);
        expect(det, `${x}, ${y}`).toBeLessThan(1.6);
      }
    }
  });

  it('север сверху: точка севернее имеет меньший Y мира', () => {
    const [, ySouth] = P.geoToWorld([60.6, 56.83]);
    const [, yNorth] = P.geoToWorld([60.6, 56.85]);
    expect(yNorth).toBeLessThan(ySouth);
  });

  it('в центре масштаб 1:1, к окраинам плавно уменьшается', () => {
    expect(P.scaleAtWorld(0, 0)).toBeCloseTo(1, 6);
    let prev = Infinity;
    for (let r = 0; r <= extent; r += 250) {
      const s = Math.sqrt(tangentialScale(r, radius, power) * radialScale(r, radius, power));
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
    expect(prev).toBeLessThan(0.6);
  });

  it('радиальное сжатие монотонно и обратимо', () => {
    let prev = -1;
    for (let r = 0; r <= extent * 1.2; r += 100) {
      const rw = warpRadius(r, radius, power);
      expect(rw).toBeGreaterThan(prev);
      expect(unwarpRadius(rw, radius, power)).toBeCloseTo(r, 3);
      prev = rw;
    }
  });

  it('искажение формы ограничено: радиальный масштаб не меньше (1 − power) от касательного', () => {
    for (let r = 0; r <= extent; r += 100) {
      const ratio = radialScale(r, radius, power) / tangentialScale(r, radius, power);
      expect(ratio).toBeGreaterThanOrEqual(1 - power - 1e-9);
      expect(ratio).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('зоны детализации: центр, срединная зона, окраины', () => {
    expect(P.zoneOfWorld(0, 0)).toBe('center');
    expect(P.zoneOfWorld(...P.geoToWorld([60.6053, 56.8585]))).toBe('middle');
    expect(P.zoneOfWorld(...P.geoToWorld([60.47, 56.79]))).toBe('outskirts');
  });

  it('преувеличение высот непрерывно и монотонно', () => {
    const { linearUpTo } = MAP_CONFIG.heights;
    expect(P.height(linearUpTo - 1e-6)).toBeCloseTo(P.height(linearUpTo + 1e-6), 4);
    let prev = -1;
    for (let z = 0; z <= 250; z += 5) {
      expect(P.height(z)).toBeGreaterThan(prev);
      prev = P.height(z);
    }
  });
});

describe('данные карты', () => {
  const ids = MAP_OBJECTS.features.map((f) => f.properties.id);

  it('у объектов уникальные id, известный тип и существующая модель', () => {
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of MAP_OBJECTS.features) {
      expect(KIND_INFO[f.properties.kind], f.properties.id).toBeDefined();
      expect(MAP_MODELS[f.properties.model], f.properties.model).toBeDefined();
    }
  });

  it('участки — замкнутые многоугольники в пределах карты, точка привязки внутри участка', () => {
    for (const f of MAP_OBJECTS.features) {
      const ring = f.geometry.coordinates[0]!;
      expect(ring.length, f.properties.id).toBeGreaterThanOrEqual(4);
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      const anchor = f.properties.anchor ?? ring[0]!;
      const [x, y] = P.geoToLocal(anchor);
      expect(Math.hypot(x, y), f.properties.id).toBeLessThan(extent);
      expect(pointInRing(anchor[0], anchor[1], ring), f.properties.id).toBe(true);
    }
  });

  it('id модели совпадает с именем файла, все модели собираются без NaN', () => {
    const view = { a: 0.15, c: 0.62, t: 0.78, height: P.height };
    for (const [id, data] of Object.entries(MAP_MODELS)) {
      expect(data.id).toBe(id);
      const m = compileModel(data, view);
      for (const v of Object.values(m.bounds)) expect(Number.isFinite(v), id).toBe(true);
      expect(m.size).toBeGreaterThan(0);
    }
  });

  it('слои содержат улицы, воду, трамвай и метро', () => {
    expect(MAP_LAYERS.roads.streets.some((s) => s.name === 'проспект Ленина')).toBe(true);
    expect(MAP_LAYERS.water.features.some((f) => f.properties.name === 'Городской пруд')).toBe(
      true,
    );
    expect(MAP_LAYERS.tram.features.length).toBeGreaterThan(0);
    const stations = MAP_LAYERS.metro.features.filter((f) => f.properties.kind === 'station');
    expect(stations.length).toBe(9);
  });
});

describe('мир', () => {
  const world = buildWorld(P, MAP_LAYERS, MAP_OBJECTS);

  it('собирается детерминированно', () => {
    const again = buildWorld(P, MAP_LAYERS, MAP_OBJECTS);
    expect(again.trees.length).toBe(world.trees.length);
    expect(again.trees[100]).toEqual(world.trees[100]);
  });

  it('деревья не растут на участках объектов', () => {
    for (const o of world.objects) {
      const inside = world.trees.filter((t) => pointInRing(t.x, t.y, o.plot));
      expect(inside.length, o.props.id).toBe(0);
    }
  });

  it('объекты на окраинах мельче, чем в центре', () => {
    const scale = (id: string) => {
      const o = world.objects.find((x) => x.props.id === id)!;
      return o.scale / (o.props.emphasis ?? 1);
    };
    expect(scale('plotinka')).toBeGreaterThan(scale('railway-station'));
  });

  it('линия делится на участки с почти постоянной толщиной', () => {
    const pts: [number, number][] = Array.from({ length: 50 }, (_, i) => [i * 200, 0]);
    const runs = splitByScale(pts, ([x, y]) => P.scaleAtWorld(x, y));
    expect(runs.length).toBeGreaterThan(1);
    expect(runs[0]!.pts[0]).toEqual(pts[0]);
    expect(runs[runs.length - 1]!.pts.at(-1)).toEqual(pts[pts.length - 1]);
  });
});

describe('граф улиц', () => {
  const roads = MAP_LAYERS.roads;
  const world = buildWorld(P, MAP_LAYERS, MAP_OBJECTS);
  const xy = world.roads.nodes;

  /** Название улицы, по которой идёт линия (по её первому отрезку). */
  const streetOf = (nodes: number[]) =>
    roads.streets.find((s) =>
      s.nodes.some(
        (n, i) => n === nodes[0] && (s.nodes[i + 1] === nodes[1] || s.nodes[i - 1] === nodes[1]),
      ),
    )?.name;
  const angle = (nodes: number[]) => {
    const a = xy[nodes[0]!]!;
    const b = xy[nodes[nodes.length - 1]!]!;
    return ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 180) % 180;
  };
  const angleDiff = (a: number, b: number) => {
    const d = Math.abs(a - b) % 180;
    return Math.min(d, 180 - d);
  };

  it('ссылки на узлы и группы корректны', () => {
    const n = roads.nodes.length;
    for (const s of roads.streets) {
      expect(s.nodes.length).toBeGreaterThanOrEqual(2);
      for (const k of s.nodes) expect(k >= 0 && k < n).toBe(true);
    }
    for (const l of roads.lines) {
      expect(roads.groups[l.group]).toBeDefined();
      for (const k of l.nodes) expect(k >= 0 && k < n).toBe(true);
    }
  });

  it('прямые улицы на карте прямые: узлы линии лежат на одной прямой', () => {
    for (const l of roads.lines) {
      const a = xy[l.nodes[0]!]!;
      const b = xy[l.nodes[l.nodes.length - 1]!]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (const k of l.nodes) {
        const p = xy[k]!;
        const off = ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len;
        expect(Math.abs(off), streetOf(l.nodes)).toBeLessThan(0.1);
      }
    }
  });

  it('линии одной группы параллельны, перпендикулярные группы перпендикулярны', () => {
    const dir = roads.groups.map((_, g) => {
      const l = roads.lines.find((x) => x.group === g);
      return l ? angle(l.nodes) : NaN;
    });
    for (const l of roads.lines) {
      expect(angleDiff(angle(l.nodes), dir[l.group]!), streetOf(l.nodes)).toBeLessThan(0.02);
    }
    roads.groups.forEach((g, i) => {
      if (g.perpendicular === undefined) return;
      expect(Math.abs(angleDiff(dir[i]!, dir[g.perpendicular]!) - 90)).toBeLessThan(0.02);
    });
  });

  it('Московская, 8 Марта, Луначарского, Восточная — в одной группе параллельных', () => {
    const groupOf = (name: string) =>
      roads.lines.filter((l) => streetOf(l.nodes) === name).map((l) => l.group);
    const lunacharskogo = groupOf('улица Луначарского');
    expect(lunacharskogo.length).toBeGreaterThan(0);
    const g = lunacharskogo[0]!;
    for (const name of ['Московская улица', 'улица 8 Марта', 'Восточная улица']) {
      expect(groupOf(name), name).toContain(g);
    }
    const lenina = groupOf('проспект Ленина');
    expect(lenina).toContain(roads.groups[g]!.perpendicular);
  });

  it('граф связный, путь по улицам находится', () => {
    // Все узлы центра и срединной зоны достижимы от Плотинки (оторванными могут быть
    // только дороги у края карты, к которым не ведут выбранные магистрали).
    const from = nearestNode(world.roads, 0, 0); // Плотинка
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      for (const e of world.roads.edges[stack.pop()!]!) {
        if (!seen.has(e.to)) {
          seen.add(e.to);
          stack.push(e.to);
        }
      }
    }
    xy.forEach(([x, y], i) => {
      if (P.realRadiusOfWorld(x, y) < 4500) expect(seen.has(i), `узел ${i}`).toBe(true);
    });
    expect(seen.size / xy.length).toBeGreaterThan(0.85);

    const to = nearestNode(world.roads, ...P.geoToWorld([60.6053, 56.8585])); // вокзал
    const straight = Math.hypot(
      ...([0, 1].map(
        (i) => P.geoToLocal(roads.nodes[to]!)[i]! - P.geoToLocal(roads.nodes[from]!)[i]!,
      ) as [number, number]),
    );
    for (const mode of ['walk', 'car'] as const) {
      const path = shortestPath(world.roads, from, to, mode);
      expect(path, mode).not.toBeNull();
      const len = pathLength(world.roads, path!);
      expect(len).toBeGreaterThanOrEqual(straight);
      expect(len).toBeLessThan(straight * 2);
    }
  });
});
