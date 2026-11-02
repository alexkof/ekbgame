import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAP_CONFIG,
  MAP_GROUND,
  MAP_GROUND_URLS,
  MAP_LAYERS,
  MAP_OBJECTS,
  MAP_STRAIGHTEN,
} from '../src/map/data';
import { groundCovers, groundProjectionKey, loadGroundImages } from '../src/map/ground';
import { createProjection } from '../src/map/projection';
import { buildWorld } from '../src/map/world';

const key = () => groundProjectionKey(MAP_CONFIG, MAP_STRAIGHTEN);

describe('статичный фон квартала', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('соответствует исходному кадру и охватывает все объекты пилотного квартала', () => {
    const art = MAP_GROUND.find((a) => a.id === 'sevastyanov')!;
    const frame = JSON.parse(
      readFileSync(
        join(__dirname, '../art/backgrounds/sevastyanov/codex-20261102.frame.json'),
        'utf8',
      ),
    );
    const quarter = JSON.parse(
      readFileSync(join(__dirname, '../art/quarters/sevastyanov.json'), 'utf8'),
    );
    expect(MAP_GROUND_URLS[art.image]).toBeDefined();
    expect(art.projection).toBe(key());
    expect(art.bounds).toEqual(frame.bounds);
    expect(art.size).toEqual(frame.size);
    expect(art.objects).toEqual(quarter.objects);
    const world = buildWorld(createProjection(MAP_CONFIG, MAP_STRAIGHTEN), MAP_LAYERS, MAP_OBJECTS);
    for (const id of art.objects) {
      const obj = world.objects.find((o) => o.props.id === id)!;
      expect(obj, id).toBeDefined();
      expect(
        groundCovers(art, obj.anchor[0], obj.anchor[1] * MAP_CONFIG.camera.groundTilt),
        id,
      ).toBe(true);
    }
    expect(groundCovers(art, art.bounds.x0, art.bounds.y0)).toBe(false);
  });

  it('отключает фон после изменения геометрии земли, но не высоты зданий', () => {
    for (const config of [
      { ...MAP_CONFIG, origin: { ...MAP_CONFIG.origin, lon: MAP_CONFIG.origin.lon + 0.001 } },
      { ...MAP_CONFIG, warp: { ...MAP_CONFIG.warp, power: MAP_CONFIG.warp.power + 0.01 } },
      { ...MAP_CONFIG, camera: { ...MAP_CONFIG.camera, groundTilt: 0.7 } },
    ]) {
      expect(groundProjectionKey(config, MAP_STRAIGHTEN)).not.toBe(key());
    }
    expect(
      groundProjectionKey(MAP_CONFIG, { ...MAP_STRAIGHTEN, unit: MAP_STRAIGHTEN.unit * 2 }),
    ).not.toBe(key());
    expect(
      groundProjectionKey(
        { ...MAP_CONFIG, heights: { ...MAP_CONFIG.heights, linearScale: 2 } },
        MAP_STRAIGHTEN,
      ),
    ).toBe(key());
  });

  it('пропускает устаревший фон и оставляет векторную карту при ошибке загрузки', async () => {
    const created: string[] = [];
    vi.stubGlobal(
      'Image',
      class {
        set src(url: string) {
          created.push(url);
        }
        decode = () => Promise.reject(new Error('Недоступна картинка'));
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const art = MAP_GROUND[0]!;
      expect(
        await loadGroundImages([{ ...art, projection: 'old' }], MAP_GROUND_URLS, key()),
      ).toEqual([]);
      expect(created).toHaveLength(0);
      expect(await loadGroundImages(MAP_GROUND, MAP_GROUND_URLS, key())).toEqual([]);
      expect(created).toEqual([MAP_GROUND_URLS[art.image]]);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
