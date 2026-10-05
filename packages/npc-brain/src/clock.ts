/**
 * Clock interface used by the NPC brains.
 *
 * Production uses SystemClock; tests use SimulatedClock. The brain
 * never constructs a clock — the room provides one.
 */

export interface Clock {
  /** @returns Epoch milliseconds. */
  now(): number;
  /**
   * @param epochMs - Target epoch ms.
   * @param cb - Callback to fire at that time.
   * @returns A cancel function.
   */
  scheduleAt(epochMs: number, cb: () => void): () => void;
}

export class SystemClock implements Clock {
  /** @returns Wall-clock epoch milliseconds. */
  now(): number {
    return Date.now();
  }
  /**
   * Schedule a callback at the given epoch ms.
   * @param epochMs - Target epoch ms.
   * @param cb - Callback to fire.
   * @returns Cancel function.
   */
  scheduleAt(epochMs: number, cb: () => void): () => void {
    const delay = Math.max(0, epochMs - this.now());
    const t = setTimeout(cb, delay);
    return () => clearTimeout(t);
  }
}

export class SimulatedClock implements Clock {
  private _now = 0;
  private readonly _cbs: Array<{ at: number; cb: () => void }> = [];

  /** @returns Current simulated epoch ms. */
  now(): number {
    return this._now;
  }

  /** Set the clock to a specific epoch ms. Fires due callbacks in order. */
  set(at: number): void {
    this._now = at;
    for (;;) {
      const next = this._cbs
        .map((c, i) => ({ c, i }))
        .filter((x) => x.c.at <= this._now)
        .sort((a, b) => a.c.at - b.c.at)[0];
      if (!next) break;
      this._cbs.splice(next.i, 1);
      next.c.cb();
    }
  }

  /** Advance the clock by deltaMs, firing due callbacks. */
  advance(deltaMs: number): void {
    this.set(this._now + deltaMs);
  }

  /**
   * Schedule a callback at the given simulated epoch ms.
   * @returns Cancel function.
   */
  scheduleAt(epochMs: number, cb: () => void): () => void {
    const entry = { at: epochMs, cb };
    this._cbs.push(entry);
    return () => {
      const i = this._cbs.indexOf(entry);
      if (i >= 0) this._cbs.splice(i, 1);
    };
  }
}
