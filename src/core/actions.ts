import type { GameState } from './state';

/**
 * Все изменения состояния идут через действия и чистую функцию applyAction.
 * Новые механики (бюджет, районы, выборы, ...) добавляют свои варианты в union.
 */
export type GameAction = { type: 'endTurn' };

export function applyAction(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'endTurn':
      return {
        ...state,
        turn: state.turn + 1,
        log: [...state.log, `Ход ${state.turn} завершён`],
      };
  }
}
