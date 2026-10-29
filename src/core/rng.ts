/**
 * Детерминированный генератор случайных чисел (mulberry32).
 * Вся случайность в симуляции идёт только через него: одинаковый seed и одинаковые
 * действия игрока дают одинаковую партию — это нужно для тестов, сохранений и реплеев.
 */
export interface RngState {
  seed: number;
}

export function nextRandom(rng: RngState): [value: number, next: RngState] {
  let t = (rng.seed + 0x6d2b79f5) | 0;
  const nextSeed = t;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return [value, { seed: nextSeed }];
}

export function nextInt(rng: RngState, minInclusive: number, maxInclusive: number) {
  const [value, next] = nextRandom(rng);
  const int = minInclusive + Math.floor(value * (maxInclusive - minInclusive + 1));
  return [int, next] as const;
}
