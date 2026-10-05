/**
 * Cash value object.
 *
 * Cash is int64 cents. The constructor takes a bigint, number (asserted as
 * integer), or decimal string (parsed as cents). No floating-point math.
 *
 * All money math in the domain layer uses Cents. REST serialises it as a
 * JSON integer in fields whose name ends with `Cents`.
 */
export class Cents {
  private readonly _cents: bigint;

  private constructor(cents: bigint) {
    this._cents = cents;
  }

  /**
   * Construct from a bigint, integer number, or decimal string like "12.34".
   * Decimal strings split on the dot and pad the fractional part to two
   * digits; no floating-point math is used.
   *
   * @param value - int64 cents, integer number, or decimal string.
   * @throws If `value` is a non-integer number.
   */
  static of(value: bigint | number | string): Cents {
    if (typeof value === 'bigint') return new Cents(value);
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) throw new Error(`Cents must be integer, got ${value}`);
      return new Cents(BigInt(value));
    }
    // string: accept decimal strings like "12.34" representing dollars.
    // We parse to cents by splitting on the decimal point. No float math.
    const s = value.trim();
    const dot = s.indexOf('.');
    if (dot === -1) {
      return new Cents(BigInt(s));
    }
    const whole = s.slice(0, dot);
    const frac = s
      .slice(dot + 1)
      .padEnd(2, '0')
      .slice(0, 2);
    const cents = BigInt(whole === '' || whole === '-' ? '0' : whole) * 100n + BigInt(frac);
    return new Cents(cents);
  }

  /** @returns The zero cents value. */
  static zero(): Cents {
    return new Cents(0n);
  }

  /** @returns The integer cents as a bigint. */
  get cents(): bigint {
    return this._cents;
  }

  /**
   * Add two Cents. No rounding; result is exact.
   * @param other - The Cents to add.
   */
  add(other: Cents): Cents {
    return new Cents(this._cents + other._cents);
  }

  /**
   * Subtract. Result may be negative; the ledger layer rejects negatives
   * on cash via `InsufficientCashError`.
   * @param other - The Cents to subtract.
   */
  sub(other: Cents): Cents {
    return new Cents(this._cents - other._cents);
  }

  /**
   * Multiply by a rational basis-points factor (e.g. fee 100 bps = 1.00%).
   * Half-up rounding at the cents level.
   * @param bps - The factor in basis points. Negative values are allowed.
   */
  mulBps(bps: number | bigint): Cents {
    const b = typeof bps === 'bigint' ? bps : BigInt(Math.round(bps));
    // Round half-up at the cents level.
    const num = this._cents * b;
    const rem = num % 10000n;
    const rounded = num / 10000n + (rem >= 5000n ? 1n : 0n);
    return new Cents(rounded);
  }

  /** @returns True if this value is non-negative. */
  isNonNegative(): boolean {
    return this._cents >= 0n;
  }

  /** @returns True if this value is strictly greater than `other`. */
  gt(other: Cents): boolean {
    return this._cents > other._cents;
  }

  /** @returns True if the two values are equal. */
  equals(other: Cents): boolean {
    return this._cents === other._cents;
  }

  /**
   * Format as a display string (e.g. "$12.34" or "-$5.00"). For logs and
   * user-facing displays only; never use this for math.
   */
  toDisplay(): string {
    const cents = this._cents;
    const negative = cents < 0n;
    const abs = negative ? -cents : cents;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, '0');
    return `${negative ? '-' : ''}$${whole.toString()}.${frac}`;
  }

  toJSON(): string {
    // JSON cannot represent bigint directly. The transport layer converts
    // this string to a number when the field name ends with Cents.
    return this._cents.toString();
  }
}
