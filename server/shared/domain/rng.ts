/**
 * Seeded RNG. Tests inject a deterministic Rng so NPCs behave
 * reproducibly and the market sim can be replayed.
 *
 * Mulberry32 — a fast 32-bit generator with adequate randomness for
 * game logic. Not suitable for cryptography.
 */
export interface Rng {
  /**
   * @param n - Upper bound (exclusive).
   * @returns A random integer in [0, n).
   */
  int(n: number): number;
  /** @returns A random float in [0, 1). */
  float(): number;
  /**
   * @param p - Probability of true.
   * @returns A random boolean with probability p.
   */
  chance(p: number): boolean;
  /**
   * @param items - Array to pick from.
   * @returns A uniformly-chosen item.
   */
  pick<T>(items: readonly T[]): T;
  /**
   * @param items - Array to pick from.
   * @param weights - Non-negative weights, same length as items.
   * @returns A weighted-random item.
   */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** @returns A sample from a standard normal distribution. */
  normal(): number;
}

export class SeededRng implements Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  private next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  float(): number {
    return this.next();
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty array');
    return items[this.int(items.length)] as T;
  }
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    if (items.length !== weights.length) throw new Error('length mismatch');
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) throw new Error('weights must be positive');
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i] as number;
      if (r <= 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }
  normal(): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}
