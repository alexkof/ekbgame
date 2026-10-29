/**
 * Что стоит на участках карты. Статические данные (участки, модели по умолчанию) лежат
 * в src/map/data; в состоянии партии хранятся только отличия от них — так сохранение
 * остаётся маленьким, а карта может обновляться независимо от сохранений.
 */
export interface CityMapState {
  /** id объекта → id модели, которая сейчас стоит на участке, или null (участок пуст). */
  structures: Record<string, string | null>;
}

export function createCityMap(): CityMapState {
  return { structures: {} };
}

/** Поставить на участок другую модель (null — снести, участок станет пустым). */
export function setStructure(
  map: CityMapState,
  objectId: string,
  model: string | null,
): CityMapState {
  return { structures: { ...map.structures, [objectId]: model } };
}

/** Вернуть участку исходный объект из данных карты. */
export function resetStructure(map: CityMapState, objectId: string): CityMapState {
  const structures = { ...map.structures };
  delete structures[objectId];
  return { structures };
}
