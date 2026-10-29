import { describe, expect, it } from 'vitest';
import { applyAction, createInitialState, nextInt, nextRandom } from '../src/core';

describe('rng', () => {
  it('детерминирован: одинаковый seed даёт одинаковую последовательность', () => {
    const seq = (seed: number) => {
      let rng = { seed };
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        const [v, next] = nextRandom(rng);
        out.push(v);
        rng = next;
      }
      return out;
    };
    expect(seq(42)).toEqual(seq(42));
    expect(seq(42)).not.toEqual(seq(43));
  });

  it('nextInt остаётся в границах', () => {
    let rng = { seed: 1 };
    for (let i = 0; i < 1000; i++) {
      const [v, next] = nextInt(rng, 1, 6);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      rng = next;
    }
  });
});

describe('applyAction', () => {
  it('endTurn увеличивает номер хода и не мутирует исходное состояние', () => {
    const s0 = createInitialState(1);
    const s1 = applyAction(s0, { type: 'endTurn' });
    expect(s1.turn).toBe(2);
    expect(s0.turn).toBe(1);
  });

  it('состояние сериализуется в JSON без потерь', () => {
    const s = applyAction(createInitialState(7), { type: 'endTurn' });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});
