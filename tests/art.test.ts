import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAP_IMAGE_URLS, MAP_MODELS } from '../src/map/data';
import { artGeometryKey, compileModel, insetRing, type ViewParams } from '../src/map/model';
import type { ModelData, XY } from '../src/map/types';

const VIEW: ViewParams = { a: 0.15, c: 0.62, t: 0.78, height: (z) => z };
const ART = join(__dirname, '..', 'art');

const box = (w: number, h: number): XY[] => [
  [-w / 2, -h / 2],
  [w / 2, -h / 2],
  [w / 2, h / 2],
  [-w / 2, h / 2],
];

describe('рисунки зданий', () => {
  it('у каждого рисунка есть картинка, и он нарисован по текущей модели', () => {
    for (const m of Object.values(MAP_MODELS)) {
      if (!m.art) continue;
      expect(MAP_IMAGE_URLS[m.art.image], `${m.id}: нет картинки ${m.art.image}`).toBeDefined();
      expect(m.art.ppm).toBeGreaterThan(0);
      expect(m.art.size[0] * m.art.size[1]).toBeGreaterThan(0);
      expect(
        m.art.geometry,
        `${m.id}: модель изменилась после рисунка — python scripts/art/art.py prepare ${m.id}, ` +
          `затем нарисовать заново или art.py import ${m.id} (старый рисунок по новому каркасу)`,
      ).toBe(artGeometryKey(m));
    }
  });

  it('каркасы в art/ построены по текущим моделям', () => {
    const dirs = readdirSync(ART, { withFileTypes: true }).filter(
      (d) => d.isDirectory() && !['quarters', 'tasks'].includes(d.name),
    );
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const path = join(ART, d.name, 'frame.json');
      expect(existsSync(path), `art/${d.name}: нет frame.json (art.py prepare)`).toBe(true);
      const frame = JSON.parse(readFileSync(path, 'utf-8'));
      const model = MAP_MODELS[d.name];
      expect(model, `art/${d.name}: нет модели`).toBeDefined();
      expect(
        frame.geometry,
        `art/${d.name}: модель изменилась — python scripts/art/art.py prepare ${d.name}`,
      ).toBe(artGeometryKey(model!));
      expect([1024, 1536]).toContain(frame.size[0]);
      expect([1024, 1536]).toContain(frame.size[1]);
    }
  });

  it('у каждого объекта квартала есть каркас', () => {
    const dir = join(ART, 'quarters');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const q = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      for (const id of q.objects ?? []) {
        expect(MAP_MODELS[id], `${file}: нет модели ${id}`).toBeDefined();
        expect(
          existsSync(join(ART, id, 'frame.json')),
          `${file}: нет каркаса art/${id}/ (art.py prepare ${id})`,
        ).toBe(true);
      }
    }
  });

  it('отпечаток геометрии не зависит от цветов и фасадов, но чувствует высоту', () => {
    const m: ModelData = {
      id: 't',
      name: 't',
      parts: [{ type: 'prism', outline: box(10, 6), z: [0, 12], color: '#ffffff' }],
    };
    const recolored: ModelData = {
      ...m,
      parts: [{ ...(m.parts[0] as object), color: '#000000', facade: 'glass' } as never],
    };
    const taller: ModelData = {
      ...m,
      parts: [{ ...(m.parts[0] as object), z: [0, 13] } as never],
    };
    expect(artGeometryKey(recolored)).toBe(artGeometryKey(m));
    expect(artGeometryKey(taller)).not.toBe(artGeometryKey(m));
  });

  it('рисунок расширяет габарит спрайта до размера картинки', () => {
    const m: ModelData = {
      id: 't',
      name: 't',
      parts: [{ type: 'prism', outline: box(10, 10), z: [0, 10], color: '#ccc' }],
      art: { image: 't.webp', size: [400, 300], origin: [100, 250], ppm: 10, geometry: '' },
    };
    const b = compileModel(m, VIEW).bounds;
    expect(b.u0).toBeLessThanOrEqual(-10);
    expect(b.u1).toBeGreaterThanOrEqual(30);
    expect(b.v0).toBeLessThanOrEqual(-25);
    expect(b.v1).toBeGreaterThanOrEqual(5);
  });
});

describe('крыши и дворы', () => {
  it('сдвиг контура внутрь: квадрат остаётся квадратом, слишком большой сдвиг — null', () => {
    const inner = insetRing(box(10, 10), 2)!;
    expect(inner).not.toBeNull();
    for (const [x, y] of inner) {
      expect(Math.abs(x)).toBeCloseTo(3);
      expect(Math.abs(y)).toBeCloseTo(3);
    }
    expect(insetRing(box(10, 10), 6)).toBeNull();
  });

  it('двускатная и вальмовая крыши поднимают верх модели, двор не ломает сборку', () => {
    const base = { type: 'prism' as const, outline: box(20, 10), z: [0, 10] as [number, number] };
    const flat = compileModel({ id: 'f', name: 'f', parts: [{ ...base, color: '#ccc' }] }, VIEW);
    const gable = compileModel(
      { id: 'g', name: 'g', parts: [{ ...base, color: '#ccc', gable: 4 }] },
      VIEW,
    );
    const lshape: XY[] = [
      [0, 0],
      [20, 0],
      [20, 8],
      [8, 8],
      [8, 20],
      [0, 20],
    ];
    const hip = compileModel(
      {
        id: 'h',
        name: 'h',
        parts: [{ type: 'prism', outline: lshape, z: [0, 10], color: '#ccc', hip: 3 }],
      },
      VIEW,
    );
    const yard = compileModel(
      {
        id: 'y',
        name: 'y',
        parts: [
          { type: 'prism', outline: box(30, 30), z: [0, 15], color: '#ccc', holes: [box(10, 10)] },
        ],
      },
      VIEW,
    );
    expect(flat.topZ).toBe(10);
    expect(gable.topZ).toBe(14);
    expect(hip.topZ).toBe(13);
    // Во дворе видна стена, обращённая на юг: у модели со двором граней больше.
    const faces = (m: typeof yard) => m.groups.flatMap((g) => g.items).length;
    const solid = compileModel(
      {
        id: 's',
        name: 's',
        parts: [{ type: 'prism', outline: box(30, 30), z: [0, 15], color: '#ccc' }],
      },
      VIEW,
    );
    expect(faces(yard)).toBeGreaterThan(faces(solid));
  });
});
