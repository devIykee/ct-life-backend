/**
 * The `GET /config` blocks owned by the chain package (unlock WP-C). core.ts spreads
 * `chainConfigPayload(ctx)` into the config response, so chain features add their
 * keys here instead of editing core.ts. A key is present only while its capability is
 * on and the deployment can serve it; a missing key means "unavailable" to the client.
 *
 *   seasonPass {sku, priceUsdc, currency, seasonId, endsAt}   C1 (seasonPassPurchase)
 *   factory {livePhase: 2, cluster: 'devnet'}                 C3 (factory), only while real
 *                                                              launches are configured
 *                                                              (docs/FACTORY-REAL.md)
 */
import type { AppContext } from './context.js';
import { seasonPassOffer, type SeasonPassOffer } from './season-pass.js';
import { isCapabilityOn } from './capabilities.js';
import { realFactoryEnabled } from './factory-real.js';

/** `GET /config` `factory`: the client opens the Launchpad Tower desk with it. */
export interface FactoryGate {
  /** The client's Factory gate phase; 2 = real launches (prepare -> MWA -> confirm). */
  readonly livePhase: 2;
  readonly cluster: 'devnet';
}

export interface ChainConfigPayload {
  readonly seasonPass?: SeasonPassOffer;
  readonly factory?: FactoryGate;
}

/**
 * @param ctx - The app context.
 * @param now - The current time.
 * @returns Only the chain keys that are on right now.
 */
export function chainConfigPayload(
  ctx: Pick<AppContext, 'config' | 'db'>,
  now: Date = new Date(),
): ChainConfigPayload {
  const out: { seasonPass?: SeasonPassOffer; factory?: FactoryGate } = {};
  const pass = seasonPassOffer(ctx, now);
  if (pass !== null) out.seasonPass = pass;
  // Capability first, so a dark deployment never even looks at the Factory env.
  if (
    isCapabilityOn(ctx, 'factory') &&
    ctx.config.solana.cluster === 'devnet' &&
    realFactoryEnabled(ctx as AppContext)
  ) {
    out.factory = { livePhase: 2, cluster: 'devnet' };
  }
  return out;
}
