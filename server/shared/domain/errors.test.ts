import { describe, expect, it } from 'vitest';
import { InsufficientCashError } from './errors.js';

describe('InsufficientCashError', () => {
  it('adds shortfallCents (a number) next to have and need', () => {
    const e = new InsufficientCashError({ have: '1200', need: '24900' });
    expect(e.details).toEqual({ have: '1200', need: '24900', shortfallCents: 23_700 });
    expect(new InsufficientCashError({ have: 10, need: 25 }).details.shortfallCents).toBe(15);
  });

  it('never goes negative, keeps an explicit value, and leaves other details alone', () => {
    expect(new InsufficientCashError({ have: '50', need: '40' }).details.shortfallCents).toBe(0);
    expect(
      new InsufficientCashError({ have: '1', need: '9', shortfallCents: 3 }).details.shortfallCents,
    ).toBe(3);
    expect(new InsufficientCashError({ reason: 'would sell more than held' }).details).toEqual({
      reason: 'would sell more than held',
    });
    expect(new InsufficientCashError().httpStatus).toBe(402);
  });
});
