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

/**
 * Граф улиц (layers/roads.json, строит scripts/map/roads.py). Узлы — перекрёстки, концы и
 * изломы; улица — цепочка узлов. Две улицы с общим узлом пересекаются, поэтому граф готов для
 * поиска пути (roads.ts). Подробно — docs/MAP.md, «Граф улиц».
 */
export interface RoadNetwork {
  nodes: LonLat[];
  streets: RoadStreet[];
  /** Прямые участки: узлы линии на карте лежат на одной прямой. */
  lines: RoadLine[];
  /** Группы параллельных линий. */
  groups: RoadGroup[];
}

export interface RoadStreet {
  name: string;
  /** 1 — проспект/магистраль, 2 — улица, 3 — малая улица. */
  rank: 1 | 2 | 3;
  /** Класс дороги в OSM: primary, secondary, tertiary… */
  class: string;
  /** Одностороннее движение: 1 — в порядке узлов, −1 — против. */
  oneway?: 1 | -1;
  /** По улице идёт трамвай. */
  tram?: boolean;
  /** Индексы узлов в RoadNetwork.nodes. */
  nodes: number[];
}

export interface RoadLine {
  /** Индекс группы в RoadNetwork.groups: линии одной группы параллельны. */
  group: number;
  nodes: number[];
}

export interface RoadGroup {
  /** Реальное направление, градусы от севера по часовой (0…180). */
  azimuth: number;
  /** Улицы группы (для читаемости файла). */
  streets: string[];
  /** Группа, которой эта строго перпендикулярна. */
  perpendicular?: number;
}

/**
 * Поле спрямления (layers/straighten.json, считает scripts/map/straighten.py): смещение мировых
 * координат после радиального сжатия, после которого прямые улицы прямые и параллельные.
 */
export interface StraightenGrid {
  /** Параметры сжатия, для которых посчитано поле (должны совпадать с MapConfig.warp). */
  warp: { radius: number; power: number };
  x0: number;
  y0: number;
  cell: number;
  nx: number;
  ny: number;
  /** Единица хранения смещений, м. */
  unit: number;
  /** base64 Int16 little-endian: по строкам сетки пары dx, dy. */
  data: string;
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

export type ModelPart =
  | PrismPart
  | CylinderPart
  | DomePart
  | GroundPart
  | TreesPart
  | SignPart
  | BillboardPart
  | ImagePart;

export type Facade =
  'none' | 'grid' | 'glass' | 'arches' | 'columns' | 'ribbon' | 'bays' | 'balusters';

/**
 * Цвета фасада «bays» (сталинский ордер): цоколь, опоры-пилястры, заполнение между опорами,
 * переплёты окон. Остальные фасады берут цвет из color.
 */
export interface BaysStyle {
  /** Ширина пролёта между опорами, м. */
  bay: number;
  /** Окон в пролёте. */
  windows: number;
  pier: string;
  panel: string;
  plinth: string;
  frame: string;
  /** Высота цоколя (м от низа стены) и верхнего фризового этажа (м от верха). */
  plinthHeight: number;
  friezeHeight: number;
}

/** Картинка, натянутая на стену (выпрямленный фасад с фото, рисунок, плитка-пролёт). */
export interface Skin {
  /** Имя файла относительно папки моделей, например "city-hall/facade.png". */
  image: string;
  /** Какую стену покрыть: самую длинную из обращённых в эту сторону света. */
  side: 'south' | 'north' | 'east' | 'west';
  /** Отметки низа и верха картинки, м (по умолчанию — вся стена). */
  z?: [number, number];
  /** Повторять картинку каждые repeat метров (плитка); по умолчанию растянуть на стену. */
  repeat?: number;
}

interface SolidBase {
  /** Нижняя и верхняя отметки в метрах. */
  z: [number, number];
  color: string;
  /** Цвет крыши (по умолчанию — чуть светлее стен). */
  roof?: string;
  facade?: Facade;
  /** Высота этажа для рисования окон, м (по умолчанию 3,6). */
  floor?: number;
  /** Параметры фасада «bays». */
  bays?: Partial<BaysStyle>;
}

/** Призма по контуру (здание, стилобат, плотина). */
export interface PrismPart extends SolidBase {
  type: 'prism';
  outline: XY[];
  /** Скатная крыша: высота конька над z[1] (шатёр к центру контура). */
  pyramid?: number;
  /** Вальмовая крыша над четырёхугольником: высота конька над z[1], конёк вдоль длинной стороны. */
  hip?: number;
  /** Картинки на стенах вместо нарисованного фасада. */
  skins?: Skin[];
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
  kind: 'metro' | 'cross' | 'star' | 'flag' | 'text' | 'clock' | 'statue';
  at: [number, number, number];
  /** Размер в метрах. */
  size: number;
  text?: string;
  color?: string;
}

/**
 * Билборд: картинка в вертикальной плоскости «запад — восток», обращённой к зрителю.
 * Камера не вращается, поэтому симметричные башни, шпили, статуи, деревья так выглядят
 * объёмными — это классический приём 2,5D-игр.
 */
export interface BillboardPart {
  type: 'billboard';
  image: string;
  /** Точка на земле под центром картинки, м. */
  center: XY;
  /** Ширина картинки, м. */
  width: number;
  /** Отметки низа и верха картинки, м. */
  z: [number, number];
}

/**
 * Готовый спрайт: картинка, нарисованная (художником, ИИ или запеканием) уже в проекции карты.
 * origin — пиксель картинки, где начало координат модели; ppm — пикселей на метр.
 * footprint и height нужны только для тени и выбора детализации.
 */
export interface ImagePart {
  type: 'image';
  image: string;
  origin: [number, number];
  ppm: number;
  footprint?: XY[];
  height?: number;
}
