import { resetStructure, setStructure } from './cityMap';
import type { GameState } from './state';

/**
 * Все изменения состояния идут через действия и чистую функцию applyAction.
 * Новые механики (бюджет, районы, выборы, ...) добавляют свои варианты в union.
 */
export type GameAction =
  | { type: 'endTurn' }
  /** Поставить на участок объекта другую модель; model: null — снести. */
  | { type: 'setStructure'; objectId: string; model: string | null }
  /** Вернуть объект, который был на участке изначально. */
  | { type: 'resetStructure'; objectId: string };

export function applyAction(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'endTurn':
      return {
        ...state,
        turn: state.turn + 1,
        log: [...state.log, `Ход ${state.turn} завершён`],
      };
    case 'setStructure':
      return { ...state, cityMap: setStructure(state.cityMap, action.objectId, action.model) };
    case 'resetStructure':
      return { ...state, cityMap: resetStructure(state.cityMap, action.objectId) };
  }
}
