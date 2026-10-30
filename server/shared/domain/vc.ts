/**
 * VC Row: pure rules for NPC term sheets and the dump at unlock.
 *
 * A VC "buys player projects cheap, dumps at unlock" (spec). Terms come from
 * the project coin's market cap: the VC values the project at
 * `valuationDiscountBps` below market cap and buys `equityBps` of it.
 * Defaults lean on real seed rounds (Carta, July 2026: median seed dilution
 * 18%) and token-unlock research (Keyrock: team unlocks the worst at about
 * -25%). The money goes into the project treasury only (an NPC faucet that
 * feeds sinks), never to a player.
 */
import type { Rng } from './rng.js';

export interface VcConfig {
  readonly archetypeIds: readonly string[];
  readonly treasuryThresholdCents: number;
  readonly minLiveHours: number;
  readonly dailyOfferChanceBps: number;
  readonly maxOffersPerWeek: number;
  readonly guaranteeAfterDays: number;
  readonly equityBps: { readonly min: number; readonly max: number };
  readonly valuationDiscountBps: number;
  readonly investCents: { readonly min: number; readonly max: number };
  readonly offerTtlHours: number;
  readonly unlockDays: number;
  readonly dumpChanceBps: number;
  readonly dumpShockPerEquityBps: number;
  readonly maxDumpShockBps: number;
  readonly dumpWindowHours: number;
  readonly dumpSteps: number;
  readonly dumpStepChanceBps: number;
  readonly maxBleedHours: number;
  readonly perpFreezeLeadHours: number;
}

export interface VcTerms {
  readonly vcArchetypeId: string;
  readonly equityBps: number;
  readonly investCents: number;
}

/**
 * Roll a term sheet for a coin with this market cap.
 * @param cfg - projects.json `vc`.
 * @param mcapCents - The project coin's market cap.
 * @param rng - Injected randomness.
 * @returns The terms, or null when the implied investment is under the minimum.
 */
export function rollVcTerms(cfg: VcConfig, mcapCents: number, rng: Rng): VcTerms | null {
  const steps = Math.floor((cfg.equityBps.max - cfg.equityBps.min) / 50);
  const equityBps = cfg.equityBps.min + 50 * rng.int(steps + 1);
  const valuation = Math.floor(
    (Math.max(0, mcapCents) * (10_000 - cfg.valuationDiscountBps)) / 10_000,
  );
  const raw = Math.floor((valuation * equityBps) / 10_000);
  if (raw < cfg.investCents.min) return null;
  return {
    vcArchetypeId: rng.pick(cfg.archetypeIds),
    equityBps,
    investCents: Math.min(raw, cfg.investCents.max),
  };
}

/**
 * The price shock when a VC dumps its stake: proportional to the stake, capped.
 * @param cfg - projects.json `vc`.
 * @param equityBps - The VC's stake.
 * @returns A negative basis-point shock (e.g. -2250 for a 15% stake).
 */
export function vcDumpShockBps(cfg: VcConfig, equityBps: number): number {
  const shock = Math.floor((equityBps * cfg.dumpShockPerEquityBps) / 10_000);
  return -Math.min(cfg.maxDumpShockBps, shock);
}

export interface OfferDecisionInput {
  readonly treasuryCents: number;
  readonly liveSinceMs: number;
  readonly nowMs: number;
  readonly hasPendingOffer: boolean;
  readonly offersLast7d: number;
  readonly lastOfferAtMs: number | null;
}

/**
 * Whether a live project gets a term sheet today: under the treasury
 * threshold, live long enough, no open offer, under the weekly cap; then a
 * daily chance, or for sure when it has had none for `guaranteeAfterDays`.
 * @param cfg - projects.json `vc`.
 * @param q - The project facts.
 * @param rng - Injected randomness.
 * @returns True to make an offer.
 */
export function shouldOffer(cfg: VcConfig, q: OfferDecisionInput, rng: Rng): boolean {
  if (q.treasuryCents >= cfg.treasuryThresholdCents) return false;
  if (q.nowMs - q.liveSinceMs < cfg.minLiveHours * 3_600_000) return false;
  if (q.hasPendingOffer || q.offersLast7d >= cfg.maxOffersPerWeek) return false;
  const since = q.lastOfferAtMs ?? q.liveSinceMs;
  if (q.nowMs - since >= cfg.guaranteeAfterDays * 86_400_000) return true;
  return rng.chance(cfg.dailyOfferChanceBps / 10_000);
}

const DAY_MS = 86_400_000;

/**
 * What players see of an unlock: the UTC day only. The exact time, and when
 * the dump really starts, stay on the server (security review H2).
 * @param unlockAtMs - The exact unlock time.
 * @returns 00:00 UTC of that day (epoch ms).
 */
export function publicUnlockAt(unlockAtMs: number): number {
  return Math.floor(unlockAtMs / DAY_MS) * DAY_MS;
}

/**
 * When the dump starts: a hidden uniform time in [unlock, unlock + window).
 * @param cfg - projects.json `vc`.
 * @param unlockAtMs - The exact unlock time.
 * @param rng - Injected randomness.
 * @returns The start (epoch ms).
 */
export function scheduleDumpStart(cfg: VcConfig, unlockAtMs: number, rng: Rng): number {
  return unlockAtMs + Math.floor(rng.float() * cfg.dumpWindowHours * 3_600_000);
}

/**
 * The per-step shock so `steps` equal multiplicative steps add up to the
 * total: (1 + s)^steps = 1 + total.
 * @param totalBps - The whole dump (negative), e.g. -2250.
 * @param steps - How many steps.
 * @returns The per-step shock in bps (negative, rounded toward zero).
 */
export function dumpStepBps(totalBps: number, steps: number): number {
  if (steps <= 0 || totalBps === 0) return 0;
  const per = Math.pow(1 + totalBps / 10_000, 1 / steps) - 1;
  return Math.trunc(per * 10_000);
}
