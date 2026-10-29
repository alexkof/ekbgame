import { createCityMap, type CityMapState } from './cityMap';
import type { RngState } from './rng';

/**
 * Корневое состояние партии. Должно оставаться простым сериализуемым объектом
 * (без классов, функций, Map/Set), чтобы его можно было сохранять в JSON.
 */
export interface GameState {
  /** Версия формата сохранения — повышать при несовместимых изменениях. */
  schemaVersion: 1;
  /** Номер хода, начиная с 1. Длительность хода — открытый вопрос (см. docs/QUESTIONS.md). */
  turn: number;
  rng: RngState;
  /** Объекты на карте, изменённые по ходу партии. */
  cityMap: CityMapState;
  /** Журнал событий партии — пригодится для UI-ленты новостей и отладки. */
  log: string[];
}

export function createInitialState(seed: number): GameState {
  return {
    schemaVersion: 1,
    turn: 1,
    rng: { seed },
    cityMap: createCityMap(),
    log: [],
  };
}
