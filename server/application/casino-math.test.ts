/**
 * The Rug Room maths: RTP simulations (1,000,000 rounds each, seeded RNG),
 * the exact slots RTP, the commit-reveal derivation and the crash settlement
 * against a controlled clock. No database.
 */
import { describe, expect, it } from 'vitest';
import { SeededRng } from '../shared/domain/rng.js';
import {
  crashMultiplierX100At,
  crashPointX100,
  crashTimeMs,
  drawStream,
  flipCoin,
  h2hSplit,
  hashSeed,
  newSeed,
  payoutFor,
  readCasinoConfigFile,
  scoreSlots,
  settleCrashAuto,
  settleCrashManual,
  slotsStats,
  spinSlots,
  toX100,
} from './casino-math.js';

const cfg = readCasinoConfigFile();
const SPINS = 1_000_000;

describe('RTP simulations (1,000,000 rounds, seeded RNG)', () => {
  it('slots land within 94-96% and match the exact enumeration', () => {
    const rng = new SeededRng(20261024);
    const stake = 10_000; // large enough that cent rounding is invisible
    let staked = 0;
    let paid = 0;
    for (let i = 0; i < SPINS; i++) {
      const spin = spinSlots(() => rng.float(), cfg);
      staked += stake;
      paid += payoutFor(stake, spin.multiplierX100);
    }
    const rtp = paid / staked;
    const exact = slotsStats(cfg);
    console.log(
      `slots: simulated RTP ${(rtp * 100).toFixed(3)}%, exact ${(exact.rtp * 100).toFixed(3)}%`,
    );
    expect(rtp).toBeGreaterThanOrEqual(0.94);
    expect(rtp).toBeLessThanOrEqual(0.96);
    expect(exact.rtp).toBeGreaterThanOrEqual(0.94);
    expect(exact.rtp).toBeLessThanOrEqual(0.96);
    expect(Math.abs(rtp - exact.rtp)).toBeLessThan(0.01);
  });

  it('the RTP printed in casino.json is the one the paytable computes', () => {
    expect(Math.abs(slotsStats(cfg).rtp - cfg.slots.computedRtp)).toBeLessThan(0.00005);
  });

  it.each([1.5, 2, 5, 10])('crash with an auto-cashout at %sx lands within 94-96%', (target) => {
    const rng = new SeededRng(7 + toX100(target));
    const stake = 10_000;
    const targetX100 = toX100(target);
    let staked = 0;
    let paid = 0;
    for (let i = 0; i < SPINS; i++) {
      const crash = crashPointX100(rng.float(), cfg);
      staked += stake;
      paid += settleCrashAuto(stake, targetX100, crash).payoutCents;
    }
    const rtp = paid / staked;
    console.log(`crash @${target}x: simulated RTP ${(rtp * 100).toFixed(3)}%`);
    // 10x pays rarely, so its sampling error is wider; the band still holds.
    expect(rtp).toBeGreaterThanOrEqual(0.94);
    expect(rtp).toBeLessThanOrEqual(0.96);
  });

  it('crash shows 1.00x (no cashout possible) about 5.9% of the time: P(crash >= 1.01x) = 0.95/1.01', () => {
    const rng = new SeededRng(99);
    let instant = 0;
    for (let i = 0; i < SPINS; i++) {
      if (crashPointX100(rng.float(), cfg) === 100) instant++;
    }
    const expected = 1 - 0.95 / 1.01;
    expect(Math.abs(instant / SPINS - expected)).toBeLessThan(0.002);
    expect(settleCrashAuto(1000, 101, 100).payoutCents).toBe(0);
  });

  it('coinflip against the house lands within 94-96%', () => {
    const rng = new SeededRng(31337);
    const stake = 1_000;
    const win = payoutFor(stake, toX100(cfg.coinflip.payoutMultiplier));
    expect(win).toBe(1_900);
    let paid = 0;
    for (let i = 0; i < SPINS; i++) {
      if (flipCoin(rng.float()) === 'heads') paid += win; // the player always calls heads
    }
    const rtp = paid / (stake * SPINS);
    console.log(`coinflip: simulated RTP ${(rtp * 100).toFixed(3)}%`);
    expect(rtp).toBeGreaterThanOrEqual(0.94);
    expect(rtp).toBeLessThanOrEqual(0.96);
  });

  it('head-to-head returns 95% to the two players together: 5% of the pot is the house cut', () => {
    const s = h2hSplit(1_000, cfg.coinflip.h2hHouseCutBps);
    expect(s).toEqual({ potCents: 2_000, cutCents: 100, payoutCents: 1_900 });
    expect(s.payoutCents / s.potCents).toBe(0.95);
  });
});

describe('slots scoring', () => {
  it('pays three of a kind, two of a kind, wilds as stand-ins and the wild jackpot', () => {
    expect(scoreSlots(['rocket', 'rocket', 'rocket'], cfg).multiplierX100).toBe(3000);
    expect(scoreSlots(['rocket', 'rocket', 'ape'], cfg).multiplierX100).toBe(150);
    expect(scoreSlots(['rocket', 'wild', 'rocket'], cfg).multiplierX100).toBe(3000);
    expect(scoreSlots(['wild', 'wild', 'ape'], cfg).multiplierX100).toBe(500);
    const jackpot = scoreSlots(['wild', 'wild', 'wild'], cfg);
    expect(jackpot.multiplierX100).toBe(2500);
    expect(jackpot.jackpot).toBe(true);
    expect(scoreSlots(['rocket', 'ape', 'laser_eyes'], cfg).multiplierX100).toBe(0);
  });

  it('a rug pays nothing and a wild does not rescue it', () => {
    expect(scoreSlots(['rug', 'rug', 'rug'], cfg).multiplierX100).toBe(0);
    expect(scoreSlots(['rug', 'wild', 'wild'], cfg).multiplierX100).toBe(0);
    expect(scoreSlots(['rug', 'rug', 'wild'], cfg).multiplierX100).toBe(0);
  });
});

describe('commit and reveal', () => {
  it('the same seed and label always give the same stream; a different one does not', () => {
    const seed = newSeed();
    const a = drawStream(seed, 'slots:r1');
    const b = drawStream(seed, 'slots:r1');
    const c = drawStream(seed, 'slots:r2');
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect([c(), c(), c()]).not.toEqual(xs);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('the published hash is SHA-256 of the revealed seed and seeds do not repeat', () => {
    const seed = newSeed();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSeed(seed)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSeed(seed)).toBe(hashSeed(seed));
    expect(hashSeed(newSeed())).not.toBe(hashSeed(seed));
  });

  it('the stream is roughly uniform', () => {
    const next = drawStream(newSeed(), 'test:uniform');
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) sum += next();
    expect(sum / n).toBeGreaterThan(0.49);
    expect(sum / n).toBeLessThan(0.51);
  });
});

describe('crash settlement against the server clock', () => {
  // A 4.00x crash point and a controlled clock: the round starts at t = 0.
  const crash = 400;
  const stake = 1_000;
  const tCrash = crashTimeMs(crash, cfg);

  it('crash time follows the growth curve', () => {
    // ln(4) / 0.07 = 19.8 s
    expect(tCrash).toBeGreaterThan(19_700);
    expect(tCrash).toBeLessThan(19_900);
    expect(crashMultiplierX100At(0, cfg)).toBe(100);
    expect(crashMultiplierX100At(tCrash, cfg)).toBeGreaterThanOrEqual(399);
  });

  it('a cashout before the crash pays the server multiplier at that instant', () => {
    const s = settleCrashManual(stake, 10_000, crash, cfg);
    const x = crashMultiplierX100At(10_000, cfg);
    expect(s.cashedOutX100).toBe(x);
    expect(s.payoutCents).toBe(payoutFor(stake, x));
    expect(s.payoutCents).toBeGreaterThan(stake);
  });

  it('a cashout one millisecond before the crash still pays, at no more than the crash point', () => {
    const s = settleCrashManual(stake, tCrash - 1, crash, cfg);
    expect(s.cashedOutX100).not.toBeNull();
    expect(s.cashedOutX100!).toBeLessThanOrEqual(crash);
  });

  it('a cashout at or after the crash pays nothing', () => {
    for (const t of [tCrash, tCrash + 1, tCrash + 60_000]) {
      const s = settleCrashManual(stake, t, crash, cfg);
      expect(s.cashedOutX100).toBeNull();
      expect(s.payoutCents).toBe(0);
    }
  });

  it('an instant bust at 1.00x can never be cashed out of', () => {
    expect(settleCrashManual(stake, 0, 100, cfg).payoutCents).toBe(0);
    expect(settleCrashManual(stake, 5_000, 100, cfg).payoutCents).toBe(0);
  });

  it('the crash point is capped', () => {
    expect(crashPointX100(0.999999999, cfg)).toBe(cfg.crash.maxMultiplier * 100);
  });
});
