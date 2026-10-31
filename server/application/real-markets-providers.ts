/**
 * Real Markets provider registry: which venue adapter serves a provider id, and which
 * capability opens it. Adding a venue is one adapter file plus one line here.
 *
 *   panta    capability `realMarkets`
 *   jupiter  capabilities `realMarkets` AND `realMarketsJupiter` (off until Jupiter's
 *            written OK on its licence's gambling clause)
 */
import type { AppContext } from './context.js';
import { assertCapabilityOn, isCapabilityOn } from './capabilities.js';
import type { MarketProvider, RealMarketProviderId } from '../shared/domain/real-markets.js';
import { REAL_MARKET_PROVIDERS } from '../shared/domain/real-markets.js';
import { PantaProvider } from '../shared/real-markets/panta.js';
import { JupiterPredictionProvider } from '../shared/real-markets/jupiter.js';

const overrides = new Map<RealMarketProviderId, MarketProvider>();
const cache = new WeakMap<object, Map<RealMarketProviderId, MarketProvider>>();

/** Test-only: serve `id` with `provider` (null restores the real adapter). */
export function _setRealMarketProviderForTests(
  id: RealMarketProviderId,
  provider: MarketProvider | null,
): void {
  if (provider === null) overrides.delete(id);
  else overrides.set(id, provider);
}

/**
 * @param ctx - The app context.
 * @param id - The provider.
 * @returns Its adapter, built once per loaded config.
 */
export function providerFor(
  ctx: Pick<AppContext, 'config'>,
  id: RealMarketProviderId,
): MarketProvider {
  const o = overrides.get(id);
  if (o) return o;
  let byId = cache.get(ctx.config);
  if (!byId) {
    byId = new Map();
    cache.set(ctx.config, byId);
  }
  let p = byId.get(id);
  if (!p) {
    const rm = ctx.config.realMarkets;
    p =
      id === 'panta'
        ? new PantaProvider({ apiKey: rm.panta.apiKey, baseUrl: rm.panta.baseUrl })
        : new JupiterPredictionProvider({ apiKey: rm.jupiter.apiKey, baseUrl: rm.jupiter.baseUrl });
    byId.set(id, p);
  }
  return p;
}

/**
 * Throw 503 CAPABILITY_OFF unless `id` is open on this deployment.
 * @param ctx - The app context.
 * @param id - The provider.
 */
export function assertProviderOn(ctx: Pick<AppContext, 'config'>, id: RealMarketProviderId): void {
  assertCapabilityOn(ctx, 'realMarkets');
  if (id === 'jupiter') assertCapabilityOn(ctx, 'realMarketsJupiter');
}

/**
 * @param ctx - The app context.
 * @returns The providers whose capabilities are on, with whether each is configured.
 */
export function openProviders(
  ctx: Pick<AppContext, 'config'>,
): Array<{ id: RealMarketProviderId; configured: boolean }> {
  if (!isCapabilityOn(ctx, 'realMarkets')) return [];
  return REAL_MARKET_PROVIDERS.filter(
    (id) => id !== 'jupiter' || isCapabilityOn(ctx, 'realMarketsJupiter'),
  ).map((id) => ({ id, configured: providerFor(ctx, id).isConfigured() }));
}
