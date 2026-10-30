/**
 * The `GET /config` blocks owned by the chain package (unlock WP-C). core.ts spreads
 * `chainConfigPayload(ctx)` into the config response, so chain features add their
 * keys here instead of editing core.ts. A key is present only while its capability is
 * on and the deployment can serve it; a missing key means "unavailable" to the client.
 *
 *   seasonPass {sku, priceUsdc, currency, seasonId, endsAt}   C1 (seasonPassPurchase)
 */
import type { AppContext } from './context.js';
import { seasonPassOffer, type SeasonPassOffer } from './season-pass.js';

export interface ChainConfigPayload {
  readonly seasonPass?: SeasonPassOffer;
}

/**
 * @param ctx - The app context.
 * @param now - The current time.
 * @returns Only the chain keys that are on right now.
 */
export function chainConfigPayload(
  ctx: Pick<AppContext, 'config'>,
  now: Date = new Date(),
): ChainConfigPayload {
  const out: { seasonPass?: SeasonPassOffer } = {};
  const pass = seasonPassOffer(ctx, now);
  if (pass !== null) out.seasonPass = pass;
  return out;
}
