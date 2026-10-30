import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rollVcTerms, shouldOffer, vcDumpShockBps, type VcConfig } from './vc.js';
import { SeededRng, type Rng } from './rng.js';

const cfg = (JSON.parse(readFileSync('contract/config/projects.json', 'utf8')) as { vc: VcConfig })
  .vc;

const fixed = (int: number, chance: boolean): Rng => ({
  int: () => int,
  float: () => 0,
  chance: () => chance,
  pick: <T>(xs: readonly T[]) => xs[0] as T,
  weighted: <T>(xs: readonly T[]) => xs[0] as T,
  normal: () => 0,
});

describe('VC terms', () => {
  it('values the project at half its market cap and buys 8-18% of it, in 50 bps steps', () => {
    const lo = rollVcTerms(cfg, 1_000_000, fixed(0, true));
    expect(lo).toEqual({ vcArchetypeId: 'vc', equityBps: 800, investCents: 40_000 });
    const hi = rollVcTerms(cfg, 1_000_000, fixed(20, true));
    expect(hi).toEqual({ vcArchetypeId: 'vc', equityBps: 1800, investCents: 90_000 });
    const rng = new SeededRng(7);
    for (let i = 0; i < 200; i++) {
      const t = rollVcTerms(cfg, 50_000_000, rng)!;
      expect(t.equityBps % 50).toBe(0);
      expect(t.equityBps).toBeGreaterThanOrEqual(cfg.equityBps.min);
      expect(t.equityBps).toBeLessThanOrEqual(cfg.equityBps.max);
      expect(t.investCents).toBeLessThanOrEqual(cfg.investCents.max);
    }
  });

  it('caps the cheque and skips projects too small to invest in', () => {
    expect(rollVcTerms(cfg, 1_000_000_000, fixed(20, true))?.investCents).toBe(cfg.investCents.max);
    expect(rollVcTerms(cfg, 100_000, fixed(0, true))).toBeNull();
  });

  it('dumps proportionally to the stake, capped', () => {
    expect(vcDumpShockBps(cfg, 1500)).toBe(-2250);
    expect(vcDumpShockBps(cfg, 1800)).toBe(-2700);
    expect(vcDumpShockBps(cfg, 5000)).toBe(-cfg.maxDumpShockBps);
  });
});

describe('shouldOffer', () => {
  const now = Date.parse('2026-11-10T15:00:00Z');
  const base = {
    treasuryCents: 0,
    liveSinceMs: now - 3 * 86_400_000,
    nowMs: now,
    hasPendingOffer: false,
    offersLast7d: 0,
    lastOfferAtMs: now - 2 * 86_400_000,
  };

  it('rolls the daily chance when eligible', () => {
    expect(shouldOffer(cfg, base, fixed(0, true))).toBe(true);
    expect(shouldOffer(cfg, base, fixed(0, false))).toBe(false);
  });

  it('never offers to a rich, brand-new, already-offered or capped project', () => {
    const yes = fixed(0, true);
    expect(shouldOffer(cfg, { ...base, treasuryCents: cfg.treasuryThresholdCents }, yes)).toBe(
      false,
    );
    expect(shouldOffer(cfg, { ...base, liveSinceMs: now - 3_600_000 }, yes)).toBe(false);
    expect(shouldOffer(cfg, { ...base, hasPendingOffer: true }, yes)).toBe(false);
    expect(shouldOffer(cfg, { ...base, offersLast7d: cfg.maxOffersPerWeek }, yes)).toBe(false);
  });

  it('guarantees one a week: no offer for 7 days means an offer today', () => {
    const quiet = {
      ...base,
      liveSinceMs: now - 30 * 86_400_000,
      lastOfferAtMs: now - 8 * 86_400_000,
    };
    expect(shouldOffer(cfg, quiet, fixed(0, false))).toBe(true);
  });
});
