/**
 * Real Markets: real-money prediction markets the player trades from their OWN wallet
 * (docs/REAL-MARKETS.md). Panta first, Jupiter's Prediction Market API second.
 *
 * Invariants every provider and the service honour:
 *
 *   - Non-custodial. A provider returns an UNSIGNED Solana mainnet transaction whose
 *     only required signer is the player's linked SIWS wallet. The server never signs,
 *     never broadcasts and never holds a key for these routes.
 *   - No Cash. In-game Cash is play money and never converts. No Real Markets type has
 *     a Cash field, and nothing here credits or debits the ledger.
 *   - Mainnet only, isolated. Both providers run on Solana mainnet (neither has a devnet).
 *     The module uses its own mainnet RPC (`config.realMarkets.mainnetRpcUrl`) and never
 *     reads or changes `config.solana.cluster`, so the D0 boot guard (APP_ENV=prod needs
 *     ALLOW_MAINNET=1) keeps protecting the devnet economy.
 *
 * This file is pure: types, the provider interface, and value helpers. Adapters live in
 * server/shared/real-markets/, orchestration in server/application/real-markets.ts.
 * Over the 300-line soft limit because the provider contract, money helpers and the
 * documented deny-list belong in one reviewed place.
 */

/** Providers this build knows, in rollout order. */
export const REAL_MARKET_PROVIDERS = ['panta', 'jupiter'] as const;
export type RealMarketProviderId = (typeof REAL_MARKET_PROVIDERS)[number];

/** @returns True when `v` is a provider id. */
export function isRealMarketProvider(v: string): v is RealMarketProviderId {
  return (REAL_MARKET_PROVIDERS as readonly string[]).includes(v);
}

/** Panta `GET /categories/` (docs.panta.market, read 2026-10-31). */
export const PANTA_CATEGORIES = [
  'sports',
  'crypto',
  'politics',
  'entertainment',
  'finance',
  'science',
  'world',
  'other',
] as const;

/** Jupiter `GET /events` `category` enum (prediction.yaml, read 2026-10-31), minus `all`. */
export const JUPITER_CATEGORIES = [
  'crypto',
  'sports',
  'politics',
  'esports',
  'culture',
  'economics',
  'tech',
] as const;

/** The Solana chain both providers settle on, as MWA 2.x names it in `authorize`. */
export const REAL_MARKETS_CHAIN = 'solana:mainnet' as const;

/** Circle USDC on mainnet; both providers settle in it. */
export const USDC_MAINNET_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Genesis hash of Solana mainnet-beta (`getGenesisHash`, read 2026-10-31). */
export const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

export interface Attribution {
  /** Text the client must show next to every provider-powered surface. */
  readonly text: string;
  /** Where the attribution links. */
  readonly url: string;
  /** True when the provider's terms make the attribution mandatory. */
  readonly required: true;
  /** The specific API name, where the provider's terms ask for it to be named. */
  readonly apiName: string;
}

/**
 * Panta Public API Terms §6: "Powered by Panta", reasonably prominent, next to the
 * feature; may be required to link to panta.market. Jupiter licence §8.4: "Powered by
 * Jupiter"; §2.3 asks integrators to name the specific API (written for Swap; we name
 * the Prediction Market API to be safe).
 */
export const ATTRIBUTION: Readonly<Record<RealMarketProviderId, Attribution>> = {
  panta: {
    text: 'Powered by Panta',
    url: 'https://panta.market',
    required: true,
    apiName: 'Panta API',
  },
  jupiter: {
    text: 'Powered by Jupiter',
    url: 'https://jup.ag',
    required: true,
    apiName: 'Jupiter Prediction Market API',
  },
};

/** Shown on every order sheet and echoed back as `riskAccepted` on build. Bump the version on copy changes. */
export const REAL_MARKETS_RISK_WARNING = {
  version: '2026-10-31',
  text:
    'Real Markets use real USDC on Solana mainnet, from your own wallet. Predictions can ' +
    'lose all the money you put in. CT Life never holds your funds and cannot reverse a ' +
    'trade. In-game Cash is play money and is never used, paid or converted here. Nothing ' +
    'here is financial advice.',
} as const;

export type RealSide = 'yes' | 'no';
export type RealMarketStatus = 'open' | 'closed' | 'resolved' | 'cancelled';

/** One binary market, normalised across providers. Prices are USDC per share, decimal strings. */
export interface RealMarket {
  readonly provider: RealMarketProviderId;
  readonly marketId: string;
  /** Jupiter groups markets in events; null for Panta. */
  readonly eventId: string | null;
  /** The event's title (Jupiter); null when the market title stands alone (Panta). */
  readonly eventTitle: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly imageUrl: string | null;
  readonly status: RealMarketStatus;
  /** The provider's own phase or status string, unchanged. */
  readonly providerPhase: string | null;
  /** True when this build can open a position on it now. */
  readonly tradable: boolean;
  readonly yesPrice: string | null;
  readonly noPrice: string | null;
  readonly sellYesPrice: string | null;
  readonly sellNoPrice: string | null;
  readonly volumeUsdc: string | null;
  /** Unix seconds. */
  readonly closeTime: number | null;
  /** Unix seconds. */
  readonly resolveTime: number | null;
  readonly result: RealSide | null;
  readonly rules: string | null;
}

export interface RealMarketPage {
  readonly items: readonly RealMarket[];
  readonly nextCursor: string | null;
}

export interface QuoteInput {
  readonly wallet: string;
  readonly marketId: string;
  readonly side: RealSide;
  /** USDC base units (6 decimals). */
  readonly amountBase: bigint;
}

export interface RealQuote {
  readonly provider: RealMarketProviderId;
  readonly marketId: string;
  readonly side: RealSide;
  readonly amountUsdc: string;
  /** Session id to pass to build (Panta `quoteId`, ~90 s); null when the provider has none. */
  readonly quoteId: string | null;
  readonly estShares: string | null;
  readonly avgPrice: string | null;
  readonly feeUsdc: string | null;
  /** ISO time the provider stops honouring this quote; null when it gives none. */
  readonly expiresAt: string | null;
}

export interface BuildInput extends QuoteInput {
  readonly quoteId: string | null;
  readonly maxSlippageBps: number;
}

export interface BuiltOrder {
  /** Base64 of an unsigned VersionedTransaction; the wallet is fee payer and only signer. */
  readonly txBase64: string;
  /** Panta `orderId` / Jupiter `orderPubkey`. */
  readonly providerOrderId: string | null;
  readonly providerQuoteId: string | null;
  readonly lastValidBlockHeight: number | null;
  /** When the transaction stops being worth signing (blockhash or provider session). */
  readonly expiresAt: Date;
  /** Top-level programs the transaction invokes; a confirmed signature must invoke all of them. */
  readonly programIds: readonly string[];
  readonly estShares: string | null;
  readonly feeUsdc: string | null;
}

export interface SubmittedInput {
  readonly providerOrderId: string | null;
  readonly providerQuoteId: string | null;
  readonly signature: string;
  readonly wallet: string;
  readonly marketId: string;
}

/** Provider-side progress after the transaction lands (Jupiter keepers fill later). */
export type ProviderOrderState = 'pending' | 'filled' | 'failed' | 'unknown';

export interface RealPosition {
  readonly provider: RealMarketProviderId;
  readonly marketId: string;
  readonly title: string | null;
  readonly side: RealSide;
  readonly shares: string;
  readonly status: string | null;
  readonly claimable: boolean;
  readonly claimed: boolean;
  readonly outcome: RealSide | null;
  readonly avgPrice: string | null;
  readonly costUsdc: string | null;
  /** Mark-to-market estimate for display; not a settlement amount. */
  readonly estValueUsdc: string | null;
}

/**
 * One real-money prediction venue. Adapters must keep the non-custodial invariant: a
 * built order needs only `wallet`'s signature. They throw the Real Markets domain
 * errors (errors.ts) and never log credentials.
 */
export interface MarketProvider {
  readonly id: RealMarketProviderId;
  readonly categories: readonly string[];
  /** Smallest order the venue documents, in USDC base units; null when undocumented. */
  readonly minOrderBase: bigint | null;
  /** True when the adapter has what it needs to call the venue (e.g. an API key). */
  isConfigured(): boolean;
  listMarkets(q: {
    category: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<RealMarketPage>;
  getMarket(marketId: string): Promise<RealMarket | null>;
  quote(input: QuoteInput): Promise<RealQuote>;
  buildOrder(input: BuildInput): Promise<BuiltOrder>;
  /** The wallet broadcast the transaction: tell the venue (Panta submit). Best effort. */
  notifySubmitted(input: SubmittedInput): Promise<void>;
  /** We verified it on chain: report it for attribution (Panta /trades/). Best effort. */
  notifyConfirmed(input: SubmittedInput): Promise<void>;
  /** Venue-side state of an order whose transaction landed. */
  orderState(input: SubmittedInput): Promise<ProviderOrderState>;
  positions(wallet: string): Promise<RealPosition[]>;
}

// --- Money ------------------------------------------------------------------

const USDC_RE = /^(0|[1-9]\d{0,11})(\.\d{1,6})?$/;

/**
 * @param amount - A decimal USDC string, at most 6 decimals ("20", "20.5", "0.000001").
 * @returns Base units, or null when the string is not a positive USDC amount.
 */
export function usdcToBase(amount: string): bigint | null {
  if (!USDC_RE.test(amount)) return null;
  const [whole, frac = ''] = amount.split('.');
  const base = BigInt(whole ?? '0') * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
  return base > 0n ? base : null;
}

/**
 * @param base - USDC base units.
 * @returns A decimal string with 2 to 6 decimals ("20.00", "0.000001").
 */
export function baseToUsdc(base: bigint): string {
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * Jupiter quotes prices and USD values in micro USD (1,000,000 = $1).
 * @param micro - A micro-USD number or integer string; null/undefined pass through.
 * @returns The decimal USD string, or null when absent or not an integer.
 */
export function microUsdToDecimal(micro: number | string | null | undefined): string | null {
  if (micro === null || micro === undefined || micro === '') return null;
  const s = typeof micro === 'number' ? Math.trunc(micro).toString() : micro.trim();
  if (!/^-?\d+$/.test(s)) return null;
  return baseToUsdc(BigInt(s));
}

// --- Geography -------------------------------------------------------------

/**
 * The built-in deny-list: the union of the providers' published restrictions (research
 * REAL-MONEY-PREDICTIONS.md §2.3, §3.1, read 2026-10-30). Panta publishes no country list.
 * The operator ADDS countries with REAL_MARKETS_BLOCKED_COUNTRIES (the lawyer's list);
 * removing one from here is a reviewed code change.
 *
 *   US, KR          Jupiter Prediction API ("restricted United States and South Korea IPs")
 *   US CN TW SG MM CI CU CD IR IQ LY ML NI KP SO SD SY YE ZW
 *                   Jupiter Terms "Prohibited Localities". "The Republic of China" is
 *                   Taiwan's formal name; it may mean the PRC, so both are listed.
 *   RU BY           [Inference] Jupiter's "subject to sanctions enforced by the US, UK or
 *                   EU" catch-all; the lawyer confirms or widens.
 */
export const DEFAULT_BLOCKED_COUNTRIES: readonly string[] = [
  'US',
  'KR',
  'CN',
  'TW',
  'SG',
  'MM',
  'CI',
  'CU',
  'CD',
  'IR',
  'IQ',
  'LY',
  'ML',
  'NI',
  'KP',
  'SO',
  'SD',
  'SY',
  'YE',
  'ZW',
  'RU',
  'BY',
];

/**
 * Sanctioned regions inside an otherwise-allowed country (Crimea, Sevastopol, Donetsk,
 * Luhansk), as ISO 3166-2 codes. [Unverified] that the edge's region header uses these
 * subdivision codes; see docs/REAL-MARKETS.md before relying on it.
 */
export const DEFAULT_BLOCKED_REGIONS: readonly string[] = ['UA-43', 'UA-40', 'UA-14', 'UA-09'];

/** Cloudflare's CF-IPCountry for "no country data" and for Tor. */
const UNKNOWN_COUNTRY_CODES = new Set(['XX', 'T1']);

/**
 * Parse a comma list of ISO 3166-1 alpha-2 codes (case-insensitive).
 * @param raw - The env value.
 * @returns The upper-cased codes and any entries that are not two letters.
 */
export function parseCountryList(raw: string | undefined): { codes: string[]; invalid: string[] } {
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const v = part.trim().toUpperCase();
    if (v === '') continue;
    if (/^[A-Z]{2}$/.test(v)) codes.push(v);
    else invalid.push(part.trim());
  }
  return { codes, invalid };
}

/**
 * Parse a comma list of ISO 3166-2 codes ("UA-43").
 * @param raw - The env value.
 * @returns The upper-cased codes and the entries that do not look like CC-XXX.
 */
export function parseRegionList(raw: string | undefined): { codes: string[]; invalid: string[] } {
  const codes: string[] = [];
  const invalid: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const v = part.trim().toUpperCase();
    if (v === '') continue;
    if (/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(v)) codes.push(v);
    else invalid.push(part.trim());
  }
  return { codes, invalid };
}

export type GeoDecision =
  | { readonly allowed: true; readonly country: string }
  | {
      readonly allowed: false;
      readonly country: string | null;
      readonly reason: 'blocked_country' | 'blocked_region' | 'unknown_country';
    };

/**
 * Decide whether a request's location may use Real Markets. Fails closed: no trusted
 * country (missing header, XX, Tor) is refused unless `allowUnknown`.
 *
 * @param input - The trusted country and region (null when absent or untrusted) and the lists.
 * @returns The decision.
 */
export function decideGeo(input: {
  readonly country: string | null;
  readonly region: string | null;
  readonly blockedCountries: ReadonlySet<string>;
  readonly blockedRegions: ReadonlySet<string>;
  readonly allowUnknown: boolean;
}): GeoDecision {
  const c = input.country?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(c) || UNKNOWN_COUNTRY_CODES.has(c)) {
    if (input.allowUnknown) return { allowed: true, country: 'XX' };
    return { allowed: false, country: c === '' ? null : c, reason: 'unknown_country' };
  }
  if (input.blockedCountries.has(c)) {
    return { allowed: false, country: c, reason: 'blocked_country' };
  }
  const r = input.region?.trim().toUpperCase() ?? '';
  if (r !== '') {
    const full = r.includes('-') ? r : `${c}-${r}`;
    if (input.blockedRegions.has(full)) {
      return { allowed: false, country: c, reason: 'blocked_region' };
    }
  }
  return { allowed: true, country: c };
}
