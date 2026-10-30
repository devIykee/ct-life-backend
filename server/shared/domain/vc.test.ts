import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  dumpStepBps,
  publicUnlockAt,
  rollVcTerms,
  scheduleDumpStart,
  shouldOffer,
  vcDumpShockBps,
  type VcConfig,
} from './vc.js';
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

describe('dump schedule (security review H2)', () => {
  it('publishes the unlock day only, starts inside the hidden window, and steps add up', () => {
    const t = Date.parse('2026-11-17T15:42:10Z');
    expect(new Date(publicUnlockAt(t)).toISOString()).toBe('2026-11-17T00:00:00.000Z');
    const rng = new SeededRng(3);
    for (let i = 0; i < 100; i++) {
      const s = scheduleDumpStart(cfg, t, rng);
      expect(s).toBeGreaterThanOrEqual(t);
      expect(s).toBeLessThan(t + cfg.dumpWindowHours * 3_600_000);
    }
    const per = dumpStepBps(-2250, cfg.dumpSteps);
    expect(per).toBeLessThan(0);
    expect(per).toBeGreaterThan(-150); // ~-1% a step, under one tick's noise (±80-400 bps)
    expect(Math.pow(1 + per / 10_000, cfg.dumpSteps)).toBeCloseTo(0.775, 2);
  });
});

/**
 * Monte Carlo against the market engine's price model for a sideways coin
 * (market-engine.ts: every 2 s tick multiplies the price by 1 + U(-80, 80) bps;
 * hidden-arc.ts `sideways`), aggregated per 5-minute worker run, with the perp
 * payoff (perp-pit.ts: no fees, settle at spot, liquidation at
 * entry*(lev+1)/lev for a short, loss capped at the margin).
 */
describe('a short cannot reliably front-run the VC dump (simulation)', () => {
  const TICKS_PER_RUN = 150; // 5 min of 2 s ticks
  const a = 0.008;
  const mu = (-TICKS_PER_RUN * a * a) / 6; // E[log(1+u)] per run
  const sd = Math.sqrt((TICKS_PER_RUN * a * a) / 3);
  const RUNS_PER_HOUR = 12;
  const totalLog = Math.log(1 + vcDumpShockBps(cfg, 1500) / 10_000); // 15% stake: -22.5%

  /** One short: true if it closes in profit. */
  function shortWins(rng: Rng, lev: number, dump: boolean): boolean {
    const liq = Math.log((lev + 1) / lev);
    let logp = 0;
    // Opened at the last allowed moment: perps freeze perpFreezeLeadHours
    // before unlock; the dump starts a hidden U(0, window) later.
    const wait =
      cfg.perpFreezeLeadHours * RUNS_PER_HOUR + rng.int(cfg.dumpWindowHours * RUNS_PER_HOUR);
    for (let i = 0; i < wait; i++) {
      logp += mu + sd * rng.normal();
      if (logp >= liq) return false;
    }
    const step = totalLog / cfg.dumpSteps;
    let done = 0;
    for (let r = 0; done < cfg.dumpSteps; r++) {
      logp += mu + sd * rng.normal();
      const overdue = r >= cfg.maxBleedHours * RUNS_PER_HOUR;
      if (rng.chance(cfg.dumpStepChanceBps / 10_000) || overdue) {
        const k = overdue ? cfg.dumpSteps - done : 1;
        if (dump) logp += step * k;
        done += k;
      }
      if (logp >= liq) return false;
    }
    return 1 - Math.exp(logp) > 0;
  }

  function winRate(lev: number, dump: boolean, n = 1500): number {
    const rng = new SeededRng(42); // same paths with and without the dump
    let w = 0;
    for (let i = 0; i < n; i++) if (shortWins(rng, lev, dump)) w++;
    return w / n;
  }

  it('the latest allowed short wins about as often with the dump as without', () => {
    for (const lev of [1, 3]) {
      const withDump = winRate(lev, true);
      const without = winRate(lev, false);
      expect(Math.abs(withDump - without), `lev ${lev}`).toBeLessThan(0.05);
      expect(withDump, `lev ${lev}`).toBeLessThan(0.65);
    }
  });

  it('the old exploit (short one run before a known single step) was near-certain; one bleed step is a coin flip', () => {
    const rng = new SeededRng(9);
    let oldWins = 0;
    let newWins = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      // Old: the whole -22.5% lands in one known run.
      if (mu + sd * rng.normal() + totalLog < 0) oldWins++;
      // New: even if a short were open across one run with a step in it.
      if (mu + sd * rng.normal() + totalLog / cfg.dumpSteps < 0) newWins++;
    }
    expect(oldWins / n).toBeGreaterThan(0.95);
    expect(newWins / n).toBeLessThan(0.6);
  });
});
