import type { ModelData } from './types';

/**
 * Картинки моделей: текстуры фасадов, билборды, готовые спрайты. Модель ссылается на файл
 * по имени относительно папки моделей ("city-hall/facade.png"); здесь имя превращается в
 * загруженную картинку. Пока картинка не загружена, модель рисуется без неё.
 */
const images = new Map<string, HTMLImageElement>();

export function getImage(name: string): HTMLImageElement | null {
  const img = images.get(name);
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}

/** Все картинки, на которые ссылается модель. */
export function imagesOf(model: ModelData): string[] {
  const names: string[] = [];
  for (const p of model.parts) {
    if (p.type === 'billboard' || p.type === 'image') names.push(p.image);
    if (p.type === 'prism') for (const s of p.skins ?? []) names.push(s.image);
  }
  return names;
}

/** Загружает картинки моделей. urls: имя → адрес (из import.meta.glob). */
export function loadModelImages(
  models: Record<string, ModelData>,
  urls: Record<string, string>,
): Promise<void> {
  const names = new Set(Object.values(models).flatMap(imagesOf));
  const jobs = [...names].map((name) => {
    const url = urls[name];
    if (!url || images.has(name)) return Promise.resolve();
    const img = new Image();
    images.set(name, img);
    img.src = url;
    return img.decode().catch(() => console.warn(`Картинка модели не загрузилась: ${name}`));
  });
  return Promise.all(jobs).then(() => undefined);
}
