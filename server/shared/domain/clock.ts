/**
 * Clock interface. Production uses SystemClock; tests use SimulatedClock.
 */
export interface Clock {
  /** @returns Epoch milliseconds. */
  now(): number;
  /**
   * @param epochMs - The target epoch milliseconds.
   * @param cb - The callback to invoke at that time.
   * @returns A function that cancels the scheduled callback.
   */
  scheduleAt(epochMs: number, cb: () => void): () => void;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  scheduleAt(epochMs: number, cb: () => void): () => void {
    const delay = Math.max(0, epochMs - this.now());
    const t = setTimeout(cb, delay);
    return () => clearTimeout(t);
  }
}

export class SimulatedClock implements Clock {
  private _now = 0;
  private readonly _cbs: Array<{ at: number; cb: () => void }> = [];

  now(): number {
    return this._now;
  }

  /**
   * Set the clock to a specific epoch ms.
   * @param at - The new epoch milliseconds.
   */
  set(at: number): void {
    this._now = at;
  }

  /**
   * Advance the clock by `ms` and fire any scheduled callbacks whose
   * target time is now in the past, in order.
   * @param ms - Milliseconds to advance.
   */
  advance(ms: number): void {
    this._now += ms;
    // Fire due callbacks in order.
    const due = this._cbs.filter((c) => c.at <= this._now);
    for (const c of due) {
      c.cb();
      this._cbs.splice(this._cbs.indexOf(c), 1);
    }
  }

  scheduleAt(epochMs: number, cb: () => void): () => void {
    const entry = { at: epochMs, cb };
    this._cbs.push(entry);
    return () => {
      const i = this._cbs.indexOf(entry);
      if (i >= 0) this._cbs.splice(i, 1);
    };
  }
}
