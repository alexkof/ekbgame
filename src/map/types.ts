/**
 * Типы данных карты. Сами данные лежат в src/map/data/ (JSON/GeoJSON) и правятся вручную,
 * в geojson.io / QGIS или скриптом scripts/map/osm_tool.py. Подробно — docs/MAP.md.
 */

/** [долгота, широта] — порядок как в GeoJSON. */
export type LonLat = [number, number];
/** Точка в метрах относительно привязки модели: x — восток, y — север. */
export type XY = [number, number];

export interface MapConfig {
  /** Начало координат и центр радиального сжатия. */
  origin: { lon: number; lat: number; name: string };
  /**
   * Радиальное сжатие: масштаб в центре 1:1, дальше плавно падает.
   * radius — где сжатие становится заметным (м), power — сила сжатия на окраинах (0…1),
   * extent — граница карты (м от центра).
   */
  warp: { radius: number; power: number; extent: number };
  /**
   * Косоугольная проекция «север сверху»: groundTilt — сжатие земли по вертикали,
   * heightFactor — сколько экранных единиц даёт метр высоты, lean — наклон высоты вправо
   * (видны южные и западные фасады).
   */
  camera: { groundTilt: number; heightFactor: number; lean: number };
  /** Высоты до linearUpTo м умножаются на linearScale, выше растут как степень power. */
  heights: { linearUpTo: number; linearScale: number; power: number };
  /** Зоны детализации: центр, срединная зона, окраины (радиус в реальных метрах). */
  zones: { id: ZoneId; name: string; radius: number }[];
}

export type ZoneId = 'center' | 'middle' | 'outskirts';

export interface Feature<G extends Geometry, P> {
  type: 'Feature';
  properties: P;
  geometry: G;
}

export type Geometry =
  | { type: 'Point'; coordinates: LonLat }
  | { type: 'LineString'; coordinates: LonLat[] }
  | { type: 'Polygon'; coordinates: LonLat[][] };

export type PointGeom = Extract<Geometry, { type: 'Point' }>;
export type LineGeom = Extract<Geometry, { type: 'LineString' }>;
export type PolygonGeom = Extract<Geometry, { type: 'Polygon' }>;

export interface FeatureCollection<G extends Geometry = Geometry, P = Record<string, unknown>> {
  type: 'FeatureCollection';
  name?: string;
  description?: string;
  features: Feature<G, P>[];
}

export interface StreetProps {
  name: string;
  /** 1 — проспект/магистраль, 2 — улица, 3 — малая улица. */
  rank: 1 | 2 | 3;
}
export interface WaterProps {
  kind: string;
  name?: string;
}
export interface LandProps {
  kind: 'park' | 'forest' | 'plaza';
  name?: string;
}
export interface MetroProps {
  kind: 'line' | 'station';
  name?: string;
}
export interface NameProps {
  name: string;
}

/** Тип объекта — для значка, подписи и игровой логики. */
export type ObjectKind =
  | 'skyscraper'
  | 'civic'
  | 'church'
  | 'theatre'
  | 'museum'
  | 'dam'
  | 'park'
  | 'metro'
  | 'station'
  | 'square';

/** Свойства объекта карты (objects.geo.json). Геометрия объекта — его участок. */
export interface ObjectProps {
  id: string;
  name: string;
  /** Короткая подпись на карте (если отличается от name). */
  label?: string;
  kind: ObjectKind;
  /** Модель по умолчанию (src/map/data/models/<model>.json). */
  model: string;
  /** Точка привязки модели; по умолчанию — центр участка. */
  anchor?: LonLat;
  /** Дополнительное укрупнение модели (1 — реальный размер в масштабе карты). */
  emphasis?: number;
  /** 1 — главные достопримечательности (подписаны всегда), 2 — важные, 3 — прочие. */
  importance?: 1 | 2 | 3;
  /** Покрытие участка: замощение, газон, песок. */
  ground?: 'paving' | 'lawn' | 'sand';
  address?: string;
  description?: string;
  /** Исходный объект OSM, например "way/158181674". */
  osm?: string;
}

export type ObjectFeature = Feature<PolygonGeom, ObjectProps>;

// ------------------------------------------------------------------ модели

/** Модель — набор примитивов в метрах относительно точки привязки (x — восток, y — север). */
export interface ModelData {
  id: string;
  name: string;
  /** Откуда взяты размеры и облик (OSM, фото и т. п.). */
  source?: string;
  parts: ModelPart[];
}

export type ModelPart = PrismPart | CylinderPart | DomePart | GroundPart | TreesPart | SignPart;

export type Facade = 'none' | 'grid' | 'glass' | 'arches' | 'columns' | 'ribbon';

interface SolidBase {
  /** Нижняя и верхняя отметки в метрах. */
  z: [number, number];
  color: string;
  /** Цвет крыши (по умолчанию — чуть светлее стен). */
  roof?: string;
  facade?: Facade;
  /** Высота этажа для рисования окон, м (по умолчанию 3,6). */
  floor?: number;
}

/** Призма по контуру (здание, стилобат, плотина). */
export interface PrismPart extends SolidBase {
  type: 'prism';
  outline: XY[];
  /** Скатная крыша: высота конька над z[1] (шатёр к центру контура). */
  pyramid?: number;
}

/** Цилиндр/эллипс/конус (башни, шпили, барабаны). */
export interface CylinderPart extends SolidBase {
  type: 'cylinder';
  center: XY;
  /** Радиусы по x и y (или один радиус). */
  radius: number | [number, number];
  /** Масштаб верхнего основания: 1 — цилиндр, 0 — конус. */
  top?: number;
  segments?: number;
  /** Поворот эллипса, градусы против часовой от востока. */
  rotate?: number;
}

/** Купол: полусфера, луковица или плоский. */
export interface DomePart {
  type: 'dome';
  center: XY;
  radius: number;
  /** Отметка основания купола, м. */
  z: number;
  height: number;
  shape?: 'sphere' | 'onion' | 'flat';
  color: string;
  segments?: number;
}

/** Плоская заливка на земле (замощение, газон, вода каскада). */
export interface GroundPart {
  type: 'ground';
  outline: XY[];
  color: string;
}

/** Деревья: точки [x, y, радиус кроны?]. */
export interface TreesPart {
  type: 'trees';
  points: ([number, number] | [number, number, number])[];
}

/** Значок в пространстве: буква «М» метро, крест, звезда, флаг, вывеска. */
export interface SignPart {
  type: 'sign';
  kind: 'metro' | 'cross' | 'star' | 'flag' | 'text';
  at: [number, number, number];
  /** Размер в метрах. */
  size: number;
  text?: string;
  color?: string;
}
