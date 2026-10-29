import { describe, expect, it } from 'vitest';
import { MAP_CONFIG, MAP_LAYERS, MAP_MODELS, MAP_OBJECTS } from '../src/map/data';
import { compileModel } from '../src/map/model';
import {
  createProjection,
  radialScale,
  tangentialScale,
  unwarpRadius,
  warpRadius,
} from '../src/map/projection';
import { KIND_INFO } from '../src/map/style';
import type { LonLat } from '../src/map/types';
import { buildWorld, pointInRing, splitByScale } from '../src/map/world';

const P = createProjection(MAP_CONFIG);
const { radius, power, extent } = MAP_CONFIG.warp;

describe('проекция', () => {
  it('гео → мир → гео возвращает исходную точку', () => {
    const points: LonLat[] = [
      [MAP_CONFIG.origin.lon, MAP_CONFIG.origin.lat],
      [60.5907, 56.8436], // башня «Исеть»
      [60.6053, 56.8585], // вокзал
      [60.47, 56.79], // окраина
    ];
    for (const p of points) {
      const [X, Y] = P.geoToWorld(p);
      const [lon, lat] = P.worldToGeo(X, Y);
      expect(lon).toBeCloseTo(p[0], 7);
      expect(lat).toBeCloseTo(p[1], 7);
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
    expect(MAP_LAYERS.streets.features.some((f) => f.properties.name === 'проспект Ленина')).toBe(
      true,
    );
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
