import type {
  FeatureCollection,
  MapConfig,
  ModelData,
  ObjectProps,
  PolygonGeom,
  StraightenGrid,
} from '../types';
import type { MapLayers } from '../world';
import config from './config.json';
import districts from './layers/districts.geo.json';
import land from './layers/land.geo.json';
import metro from './layers/metro.geo.json';
import rail from './layers/rail.geo.json';
import roads from './layers/roads.json';
import straighten from './layers/straighten.json';
import tram from './layers/tram.geo.json';
import water from './layers/water.geo.json';
import objects from './objects.geo.json';

/**
 * Данные карты, собранные при сборке. Файлы — обычный JSON/GeoJSON:
 * их можно открыть в geojson.io или QGIS, поправить и сохранить обратно.
 */
export const MAP_CONFIG = config as MapConfig;

/** Поле спрямления улиц — передаётся в createProjection вместе с MAP_CONFIG. */
export const MAP_STRAIGHTEN = straighten as StraightenGrid;

export const MAP_LAYERS = {
  roads,
  tram,
  rail,
  metro,
  water,
  land,
  districts,
} as unknown as MapLayers;

export const MAP_OBJECTS = objects as unknown as FeatureCollection<PolygonGeom, ObjectProps>;

const modelFiles = import.meta.glob<ModelData>('./models/*.json', {
  eager: true,
  import: 'default',
});

/** Модели по id (имя файла = id модели). */
export const MAP_MODELS: Record<string, ModelData> = Object.fromEntries(
  Object.values(modelFiles).map((m) => [m.id, m]),
);

const imageFiles = import.meta.glob<string>('./models/**/*.{png,jpg,webp}', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** Картинки моделей (рисунки, текстуры): имя относительно папки моделей → адрес. */
export const MAP_IMAGE_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(imageFiles).map(([path, url]) => [path.replace('./models/', ''), url]),
);
