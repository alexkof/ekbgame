import type { MapConfig, StraightenGrid } from './types';

/** Статичная земля в плоскости карты. Здания и игровые изменения рисуются поверх. */
export interface GroundArt {
  id: string;
  objects: string[];
  image: string;
  size: [number, number];
  bounds: { x0: number; y0: number; x1: number; y1: number };
  /** Ширина прозрачного перехода к обычной карте, в пикселях исходника. */
  feather: number;
  projection: string;
}

export interface GroundImage {
  art: GroundArt;
  image: HTMLImageElement;
}

/** Фон привязан и к сжатию города, и к полю спрямления улиц. */
export function groundProjectionKey(config: MapConfig, straighten: StraightenGrid): string {
  const source = JSON.stringify([config.origin, config.warp, config.camera.groundTilt, straighten]);
  let hash = 2166136261;
  for (let i = 0; i < source.length; i++) {
    hash = Math.imul(hash ^ source.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Проверка непрозрачной части фона; координаты уже в плоскости изображения. */
export function groundCovers(art: GroundArt, x: number, y: number): boolean {
  const { bounds: b, size, feather } = art;
  const dx = ((b.x1 - b.x0) * feather) / size[0];
  const dy = ((b.y1 - b.y0) * feather) / size[1];
  return x >= b.x0 + dx && x <= b.x1 - dx && y >= b.y0 + dy && y <= b.y1 - dy;
}

export async function loadGroundImages(
  art: GroundArt[],
  urls: Record<string, string>,
  projection: string,
): Promise<GroundImage[]> {
  const jobs = art
    .filter((a) => a.projection === projection)
    .map(async (a) => {
      const url = urls[a.image];
      if (!url) return null;
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        return { art: a, image };
      } catch {
        console.warn(`Фон квартала не загрузился: ${a.id}`);
        return null;
      }
    });
  return (await Promise.all(jobs)).filter((g): g is GroundImage => g !== null);
}
