/**
 * Hidden-arc sampling.
 *
 * At launch, the market engine samples one of 'rug', 'slow_bleed',
 * 'sideways', 'moon' from the configured outcome mix and commits
 * it to the coin's `hidden_arc` column. The arc is never revealed
 * to clients; only the engine and admin read it.
 *
 * The sampling is pure (no I/O) so it can be tested deterministically
 * with a fixed seed.
 */
import { SeededRng } from '../shared/domain/rng.js';

/** Outcomes the engine can sample for a coin's hidden arc. */
export type ArcOutcome = 'rug' | 'slow_bleed' | 'sideways' | 'moon';

/** Per-coin script parameters, committed at launch. */
export interface HiddenArc {
  readonly outcome: ArcOutcome;
  readonly slopeBps: number;
  readonly noiseBps: number;
  readonly drawdownBps: number;
}

/**
 * Sample and commit a hidden arc for a coin. The same `seed`
 * always produces the same arc + same arc parameters.
 *
 * @param seed - The per-coin seed (uint32).
 * @param mix - The outcome mix in basis-point-like weights
 *   (sums to a positive total; the engine normalises).
 * @returns The committed hidden arc.
 */
export function sampleHiddenArc(
  seed: number,
  mix: { rug: number; slow_bleed: number; sideways: number; moon: number },
): HiddenArc {
  const rng = new SeededRng(seed >>> 0);
  const total = mix.rug + mix.slow_bleed + mix.sideways + mix.moon;
  if (total <= 0) throw new Error('outcome mix must have positive total');
  let r = rng.float() * total;
  let outcome: ArcOutcome;
  if ((r -= mix.rug) < 0) outcome = 'rug';
  else if ((r -= mix.slow_bleed) < 0) outcome = 'slow_bleed';
  else if ((r -= mix.sideways) < 0) outcome = 'sideways';
  else outcome = 'moon';
  switch (outcome) {
    case 'rug':
      return { outcome, slopeBps: -200, noiseBps: 400, drawdownBps: 9_500 };
    case 'slow_bleed':
      return { outcome, slopeBps: -30, noiseBps: 100, drawdownBps: 5_000 };
    case 'sideways':
      return { outcome, slopeBps: 0, noiseBps: 80, drawdownBps: 1_500 };
    case 'moon':
      return { outcome, slopeBps: 60, noiseBps: 200, drawdownBps: 2_000 };
  }
}
