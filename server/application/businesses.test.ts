/**
 * Business payout rules (pure). The DB flows (buy, collect, sell)
 * run through the routes in server/api/city-routes.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  pendingPeriods,
  rollPeriod,
  sellBackCents,
  type BusinessKindConfig,
} from './businesses.js';

const catalog = JSON.parse(
  readFileSync(join(process.cwd(), 'contract/config/businesses.json'), 'utf8'),
) as { businesses: BusinessKindConfig[] };
const lab = catalog.businesses.find((b) => b.id === 'memecoin_lab')!;
const DAY = 24 * 3_600_000;

describe('rollPeriod', () => {
  it('gives the same day for the same business and period', () => {
    expect(rollPeriod(lab, 'biz-1', 4)).toEqual(rollPeriod(lab, 'biz-1', 4));
  });

  it('pays inside incomeRangeCents on a normal day', () => {
    const [min, max] = lab.incomeRangeCents;
    for (let i = 0; i < 500; i++) {
      const d = rollPeriod(lab, 'biz-range', i);
      if (d.kind !== 'normal') continue;
      expect(d.payCents).toBeGreaterThanOrEqual(min);
      expect(d.payCents).toBeLessThanOrEqual(max);
      expect(d.reasonId).toBeNull();
    }
  });

  it('pays floor(min * badDayMultiplier) and names a catalog reason on a bad day', () => {
    const always = { ...lab, badDayChanceBps: 10_000 };
    const ids = new Set(lab.badDays!.map((r) => r.id));
    for (let i = 0; i < 50; i++) {
      const d = rollPeriod(always, 'biz-bad', i);
      expect(d.kind).toBe('bad_day');
      expect(d.payCents).toBe(Math.floor(lab.incomeRangeCents[0] * lab.badDayMultiplier));
      expect(ids.has(d.reasonId!)).toBe(true);
    }
  });

  it('rolls bad days near badDayChanceBps', () => {
    let bad = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) if (rollPeriod(lab, 'biz-rate', i).kind === 'bad_day') bad++;
    expect(bad / n).toBeGreaterThan(0.025);
    expect(bad / n).toBeLessThan(0.045); // memecoin_lab is 350 bps
  });
});

describe('pendingPeriods', () => {
  it('owes the whole periods since the last collect', () => {
    expect(pendingPeriods(lab, 0, 0, 3.5 * DAY, 7)).toEqual({
      first: 0,
      count: 3,
      accruedUntilMs: 3 * DAY,
    });
    expect(pendingPeriods(lab, 0, 3 * DAY, 3.9 * DAY, 7).count).toBe(0);
  });

  it('caps the pile at maxPendingPayouts, newest first', () => {
    expect(pendingPeriods(lab, 0, 0, 20 * DAY, 7)).toEqual({
      first: 13,
      count: 7,
      accruedUntilMs: 20 * DAY,
    });
  });
});

it('sells back for sellBackBps of the cost', () => {
  expect(sellBackCents(lab)).toBe(lab.costCents / 2);
});
