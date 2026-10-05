/**
 * Seeded RNG.
 *
 * Mulberry32 — a fast 32-bit generator with adequate randomness
 * for game logic. Not suitable for cryptography. The brain uses
 * this so that the same seed + same input yields the same
 * behaviour, which is what tests rely on.
 */
export interface Rng {
  /** @returns Integer in [0, n). */
  int(n: number): number;
  /** @returns Float in [0, 1). */
  float(): number;
  /** @returns True with probability p. */
  chance(p: number): boolean;
  /** @returns A uniformly-chosen item. */
  pick<T>(items: readonly T[]): T;
  /** @returns A weighted-random item. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

export class SeededRng implements Rng {
  private state: number;

  /** @param seed - 32-bit seed. Zero is replaced with a constant. */
  constructor(seed: number) {
    this.state = seed | 0 || 0x9e3779b9;
  }

  /** @returns A float in [0, 1). */
  private next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** @param n - Upper bound (exclusive). */
  int(n: number): number {
    if (n <= 0) return 0;
    return Math.floor(this.next() * n);
  }

  /** @returns Float in [0, 1). */
  float(): number {
    return this.next();
  }

  /** @param p - Probability of true. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** @param items - Items to pick from. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    const i = this.int(items.length);
    return items[i] as T;
  }

  /**
   * Pick one item with weighted probability.
   * @param items - Items to choose from.
   * @param weights - Non-negative weights, same length as items.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length === 0) throw new Error('weighted from empty array');
    if (items.length !== weights.length) {
      throw new Error('weighted: items and weights must have the same length');
    }
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) {
      return items[0] as T;
    }
    const r = this.next() * total;
    let acc = 0;
    for (let i = 0; i < items.length; i++) {
      acc += weights[i] ?? 0;
      if (r < acc) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }
}
