/**
 * The Rug Room: pure game maths. No database, no clock, no I/O except
 * reading the config file.
 *
 * Randomness. The server picks a 32-byte seed per round and publishes
 * SHA-256(seed) before the outcome is known (commit). Every random number
 * of the round comes from HMAC-SHA256 keyed by the seed over
 * `<game>:<roundId>:<counter>` (`drawStream`). The client sends no seed
 * and no nonce, so it cannot steer the outcome. After the round settles
 * the seed is revealed and anyone can recompute the outcome (reveal).
 *
 * Every game takes a `() => number` source of floats in [0, 1) so the RTP
 * simulations can drive the exact same code with the seeded test RNG.
 *
 * Money is integer cents. Multipliers in the config are decimals with at
 * most 2 places; here they become integers in hundredths ("x100") and a
 * payout is floor(stake * x100 / 100), so rounding never favours the
 * player.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SLOT_SYMBOLS = [
  'rocket',
  'diamond_hands',
  'ape',
  'laser_eyes',
  'rug',
  'wild',
] as const;
export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

type PerSymbol<T> = Readonly<Record<SlotSymbol, T>>;

export interface CasinoConfig {
  readonly version: string;
  readonly disclaimer: string;
  readonly limits: {
    readonly minStakeCents: number;
    readonly maxStakeCents: number;
    readonly sessionReminderMinutes: number;
    readonly sessionGapMinutes: number;
    readonly minSelfExcludeDays: number;
    readonly maxSelfExcludeDays: number;
  };
  readonly slots: {
    readonly reelWeights: PerSymbol<number>;
    readonly paytable: { readonly three: PerSymbol<number>; readonly two: PerSymbol<number> };
    readonly computedRtp: number;
  };
  readonly crash: {
    readonly targetRtp: number;
    readonly growthPerSecond: number;
    readonly maxMultiplier: number;
    readonly minAutoCashout: number;
  };
  readonly coinflip: {
    readonly payoutMultiplier: number;
    readonly h2hHouseCutBps: number;
    readonly challengeTtlSeconds: number;
  };
}

/**
 * Read `contract/config/casino.json` straight from disk (tests and the
 * contract checker; the API uses the cached `ctx.configCache`).
 * @param root - The repository root.
 */
export function readCasinoConfigFile(root: string = process.cwd()): CasinoConfig {
  return JSON.parse(
    readFileSync(join(root, 'contract', 'config', 'casino.json'), 'utf8'),
  ) as CasinoConfig;
}

/** A float in [0, 1). */
export type Draw = () => number;

// --- Seeds: commit and reveal -------------------------------------------

/** @returns A fresh 256-bit seed as 64 lowercase hex characters. */
export function newSeed(): string {
  return randomBytes(32).toString('hex');
}

/**
 * @param seed - The seed hex string.
 * @returns The commitment: SHA-256 of the seed string (UTF-8), lowercase hex.
 */
export function hashSeed(seed: string): string {
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/**
 * The deterministic stream of floats for one round.
 * @param seed - The round seed.
 * @param label - `<game>:<roundId>`.
 * @returns A function returning the next float in [0, 1), 53 bits each.
 */
export function drawStream(seed: string, label: string): Draw {
  let counter = 0;
  return () => {
    const h = createHmac('sha256', seed).update(`${label}:${counter}`).digest();
    counter += 1;
    const hi = h.readUInt32BE(0) & 0x1fffff; // 21 bits
    const lo = h.readUInt32BE(4); // 32 bits
    return (hi * 2 ** 32 + lo) / 2 ** 53;
  };
}

// --- Multipliers and payouts --------------------------------------------

/**
 * @param m - A decimal multiplier from the config.
 * @returns The multiplier in hundredths.
 */
export function toX100(m: number): number {
  return Math.round(m * 100);
}

/**
 * @param stakeCents - The stake in cents.
 * @param x100 - The multiplier in hundredths.
 * @returns The payout in cents, floored.
 */
export function payoutFor(stakeCents: number, x100: number): number {
  return Math.floor((stakeCents * x100) / 100);
}

// --- Slots --------------------------------------------------------------

export interface SlotsSpin {
  readonly reels: readonly [SlotSymbol, SlotSymbol, SlotSymbol];
  /** Winning multiplier in hundredths (0 = no win). */
  readonly multiplierX100: number;
  readonly jackpot: boolean;
  /** The symbol the win is paid on, or null. */
  readonly winSymbol: SlotSymbol | null;
}

/**
 * Score three reels. A wild stands in for any symbol except the rug. Three
 * wilds pay the jackpot. Otherwise the best symbol (counting wilds) pays
 * `three` on three and `two` on two. A rug never pays and wilds do not
 * rescue it.
 * @param reels - The three symbols.
 * @param config - The casino config.
 */
export function scoreSlots(
  reels: readonly [SlotSymbol, SlotSymbol, SlotSymbol],
  config: CasinoConfig,
): SlotsSpin {
  const { three, two } = config.slots.paytable;
  const wilds = reels.filter((s) => s === 'wild').length;
  if (wilds === 3) {
    return { reels, multiplierX100: toX100(three.wild), jackpot: true, winSymbol: 'wild' };
  }
  let best = 0;
  let winSymbol: SlotSymbol | null = null;
  for (const s of SLOT_SYMBOLS) {
    if (s === 'wild' || s === 'rug') continue;
    const own = reels.filter((r) => r === s).length;
    if (own === 0) continue;
    const n = own + wilds;
    const m = n >= 3 ? toX100(three[s]) : n === 2 ? toX100(two[s]) : 0;
    if (m > best) {
      best = m;
      winSymbol = s;
    }
  }
  return { reels, multiplierX100: best, jackpot: false, winSymbol };
}

/**
 * Spin the reels.
 * @param draw - Float source.
 * @param config - The casino config.
 */
export function spinSlots(draw: Draw, config: CasinoConfig): SlotsSpin {
  const weights = SLOT_SYMBOLS.map((s) => config.slots.reelWeights[s]);
  const total = weights.reduce((a, b) => a + b, 0);
  const pick = (): SlotSymbol => {
    let r = draw() * total;
    for (let i = 0; i < SLOT_SYMBOLS.length; i++) {
      r -= weights[i]!;
      if (r < 0) return SLOT_SYMBOLS[i]!;
    }
    return SLOT_SYMBOLS[SLOT_SYMBOLS.length - 1]!;
  };
  return scoreSlots([pick(), pick(), pick()], config);
}

/**
 * Exact slots RTP by enumerating all 6^3 weighted outcomes.
 * @param config - The casino config.
 * @returns RTP, standard deviation of the return per unit stake, and hit rate.
 */
export function slotsStats(config: CasinoConfig): { rtp: number; sigma: number; hitRate: number } {
  const w = SLOT_SYMBOLS.map((s) => config.slots.reelWeights[s]);
  const total = w.reduce((a, b) => a + b, 0);
  let e = 0;
  let e2 = 0;
  let hit = 0;
  for (let a = 0; a < 6; a++)
    for (let b = 0; b < 6; b++)
      for (let c = 0; c < 6; c++) {
        const p = (w[a]! * w[b]! * w[c]!) / total ** 3;
        const m =
          scoreSlots([SLOT_SYMBOLS[a]!, SLOT_SYMBOLS[b]!, SLOT_SYMBOLS[c]!], config)
            .multiplierX100 / 100;
        e += p * m;
        e2 += p * m * m;
        if (m > 0) hit += p;
      }
  return { rtp: e, sigma: Math.sqrt(e2 - e * e), hitRate: hit };
}

// --- Crash --------------------------------------------------------------

/**
 * The crash point in hundredths of the multiplier, from one uniform draw
 * with the standard house-edge distribution:
 * P(crash >= m) = targetRtp / m, so cashing out at any fixed target m has
 * an expected return of targetRtp. A draw under (1 - targetRtp) busts at
 * 1.00x, before any cashout is possible. Clamped to `maxMultiplier`.
 * @param u - A float in [0, 1).
 * @param config - The casino config.
 */
export function crashPointX100(u: number, config: CasinoConfig): number {
  const raw = Math.floor((config.crash.targetRtp * 100) / (1 - u));
  return Math.min(Math.max(100, raw), config.crash.maxMultiplier * 100);
}

/**
 * Milliseconds from round start until the multiplier reaches the crash
 * point, on the curve m(t) = e^(r t).
 * @param crashX100 - The crash point in hundredths.
 * @param config - The casino config.
 */
export function crashTimeMs(crashX100: number, config: CasinoConfig): number {
  if (crashX100 <= 100) return 0;
  return Math.ceil((Math.log(crashX100 / 100) / config.crash.growthPerSecond) * 1000);
}

/**
 * The multiplier in hundredths shown `elapsedMs` after the round started.
 * @param elapsedMs - Server time since the round started.
 * @param config - The casino config.
 */
export function crashMultiplierX100At(elapsedMs: number, config: CasinoConfig): number {
  if (elapsedMs <= 0) return 100;
  return Math.floor(100 * Math.exp((config.crash.growthPerSecond * elapsedMs) / 1000));
}

export interface CrashSettlement {
  readonly crashPointX100: number;
  /** The multiplier the player left at (hundredths), or null if they rugged. */
  readonly cashedOutX100: number | null;
  readonly payoutCents: number;
}

/**
 * Settle a crash round with an auto-cashout target.
 * @param stakeCents - The stake.
 * @param autoCashoutX100 - The target in hundredths.
 * @param crashX100 - The crash point in hundredths.
 */
export function settleCrashAuto(
  stakeCents: number,
  autoCashoutX100: number,
  crashX100: number,
): CrashSettlement {
  const won = autoCashoutX100 <= crashX100;
  return {
    crashPointX100: crashX100,
    cashedOutX100: won ? autoCashoutX100 : null,
    payoutCents: won ? payoutFor(stakeCents, autoCashoutX100) : 0,
  };
}

/**
 * Settle a manual cashout request against the server clock. Valid only
 * while the server-side multiplier has not reached the crash point; the
 * client's own view of the multiplier plays no part.
 * @param stakeCents - The stake.
 * @param elapsedMs - Server time since the round started.
 * @param crashX100 - The crash point in hundredths.
 * @param config - The casino config.
 */
export function settleCrashManual(
  stakeCents: number,
  elapsedMs: number,
  crashX100: number,
  config: CasinoConfig,
): CrashSettlement {
  if (elapsedMs >= crashTimeMs(crashX100, config)) {
    return { crashPointX100: crashX100, cashedOutX100: null, payoutCents: 0 };
  }
  const x100 = Math.min(crashMultiplierX100At(elapsedMs, config), crashX100);
  return {
    crashPointX100: crashX100,
    cashedOutX100: x100,
    payoutCents: payoutFor(stakeCents, x100),
  };
}

// --- Coinflip -----------------------------------------------------------

export type CoinSide = 'heads' | 'tails';

/**
 * @param u - A float in [0, 1).
 * @returns Heads below 0.5, else tails.
 */
export function flipCoin(u: number): CoinSide {
  return u < 0.5 ? 'heads' : 'tails';
}

/**
 * Head-to-head pot split.
 * @param stakeCents - One player's stake.
 * @param cutBps - House cut in basis points of the pot.
 */
export function h2hSplit(
  stakeCents: number,
  cutBps: number,
): { potCents: number; cutCents: number; payoutCents: number } {
  const potCents = stakeCents * 2;
  const cutCents = Math.floor((potCents * cutBps) / 10_000);
  return { potCents, cutCents, payoutCents: potCents - cutCents };
}
