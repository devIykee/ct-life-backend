/**
 * Real Markets provider web pages: the `providerUrl` on every market and position and the
 * `claimUrl` on a claimable position (docs/REAL-MARKETS.md "Provider pages"). CT Life builds
 * no claims or sells yet, so the client opens the venue's own page. Pure.
 */
import type { RealMarket, RealMarketProviderId, RealPosition } from './real-markets.js';

/**
 * The URL slug panta.market builds from a market title (lifted from panta.market's own web
 * bundle, read 2026-10-31; Panta's API docs publish no web URL format): NFKD, accents
 * dropped, lower case, every run of non-alphanumerics turned into one `-`, trimmed, at most
 * 80 characters, `market` when empty.
 *
 * @param title - The market title (may be null).
 * @returns The slug.
 */
export function pantaSlug(title: string | null): string {
  return (
    (title ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
      .replace(/-+$/g, '') || 'market'
  );
}

/** Jupiter Predict's documented web entry points (docs.jup.ag user docs, read 2026-10-31). */
export const JUPITER_PREDICT_URL = 'https://jup.ag/prediction';
export const JUPITER_PREDICT_PROFILE_URL = 'https://jup.ag/prediction/profile';

/**
 * The provider page where the player can see (and trade) one market.
 *
 *   panta    https://panta.market/market/{marketId}/{slug}   (marketId is the event PDA)
 *   jupiter  https://jup.ag/prediction                       ([Unverified] per-event deep link;
 *                                                            the landing page is documented)
 *
 * @param provider - The venue.
 * @param marketId - The venue's market id.
 * @param title - The market title, for Panta's slug.
 * @returns An https URL.
 */
export function providerMarketUrl(
  provider: RealMarketProviderId,
  marketId: string,
  title: string | null,
): string {
  if (provider === 'panta') {
    return `https://panta.market/market/${encodeURIComponent(marketId)}/${pantaSlug(title)}`;
  }
  return JUPITER_PREDICT_URL;
}

/**
 * Where the player claims a resolved winning position (CT Life builds no claim yet).
 *
 *   panta    the market page ([Unverified] that panta.market shows the claim action there)
 *   jupiter  https://jup.ag/prediction/profile (documented: claims are made from Profile)
 *
 * @param provider - The venue.
 * @param marketId - The venue's market id.
 * @param title - The market title, for Panta's slug.
 * @returns An https URL.
 */
export function providerClaimUrl(
  provider: RealMarketProviderId,
  marketId: string,
  title: string | null,
): string {
  return provider === 'panta'
    ? providerMarketUrl(provider, marketId, title)
    : JUPITER_PREDICT_PROFILE_URL;
}

/** A market as the API returns it: the venue's data plus its web page. */
export type RealMarketView = RealMarket & { readonly providerUrl: string };

/** A position as the API returns it: plus the market page and, when claimable, the claim page. */
export type RealPositionView = RealPosition & {
  readonly providerUrl: string;
  /** Set only while the position is claimable and not yet claimed. */
  readonly claimUrl: string | null;
};

/**
 * @param m - A venue market.
 * @returns It with `providerUrl`.
 */
export function withMarketUrl(m: RealMarket): RealMarketView {
  return { ...m, providerUrl: providerMarketUrl(m.provider, m.marketId, m.title) };
}

/**
 * @param p - A venue position.
 * @returns It with `providerUrl` and `claimUrl`.
 */
export function withPositionUrls(p: RealPosition): RealPositionView {
  return {
    ...p,
    providerUrl: providerMarketUrl(p.provider, p.marketId, p.title),
    claimUrl: p.claimable && !p.claimed ? providerClaimUrl(p.provider, p.marketId, p.title) : null,
  };
}
