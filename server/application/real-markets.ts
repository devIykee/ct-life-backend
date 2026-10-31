/**
 * Real Markets service: browse, quote and build real-money prediction orders that the
 * player signs with their own wallet (docs/REAL-MARKETS.md). Orders after build live in
 * real-markets-orders.ts.
 *
 * The server proxies the venue (its API key never reaches the client), gates every call
 * (real-markets-gate.ts), caches venue reads briefly (with `asOf`, because Panta's terms
 * forbid showing stale data as live), and builds UNSIGNED mainnet transactions for the
 * caller's linked wallet. It never signs, never broadcasts and never touches Cash.
 *
 * Over the 300-line soft limit on purpose: config, markets, quote and build share the gate,
 * cache and amount rules kept private here; splitting them would export those internals.
 */
import type { AppContext } from './context.js';
import { assertProviderOn, openProviders, providerFor } from './real-markets-providers.js';
import { geoDecision, loadPlayerGate, passGate, type RequestGeo } from './real-markets-gate.js';
import { isCapabilityOn } from './capabilities.js';
import {
  NotFoundError,
  RateLimitedError,
  RealMarketsProviderUnavailableError,
  RealMarketsWalletMismatchError,
  RiskNotAcceptedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import {
  ATTRIBUTION,
  REAL_MARKETS_CHAIN,
  REAL_MARKETS_RISK_WARNING,
  USDC_MAINNET_MINT,
  baseToUsdc,
  usdcToBase,
  type Attribution,
  type MarketProvider,
  type RealMarket,
  type RealMarketProviderId,
  type RealQuote,
  type RealSide,
} from '../shared/domain/real-markets.js';
import { withMarketUrl, type RealMarketView } from '../shared/domain/real-markets-links.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import { uuidv7 } from '../shared/domain/uuid.js';

/** Seconds a venue catalog page / market detail is served from cache. */
export const LIST_CACHE_SEC = 30;
export const DETAIL_CACHE_SEC = 5;
/** Default and maximum slippage the build passes to the venue (Panta: default 100, max 5000). */
export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 500;

type Bucket = 'read' | 'quote' | 'build' | 'submit';
const BUCKETS: Record<Bucket, { capacity: number; perSec: number }> = {
  read: { capacity: 60, perSec: 1 },
  quote: { capacity: 20, perSec: 20 / 60 },
  build: { capacity: 10, perSec: 10 / 60 },
  submit: { capacity: 20, perSec: 20 / 60 },
};

/**
 * Per-player token bucket for Real Markets (on top of the global write limiter).
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param bucket - Which family.
 */
export async function rateLimit(
  ctx: Pick<AppContext, 'redis'>,
  userId: string,
  bucket: Bucket,
): Promise<void> {
  const b = BUCKETS[bucket];
  const d = await perUserTokenBucket(
    ctx.redis.main,
    `rl:rm:${bucket}:${userId}`,
    b.capacity,
    b.perSec,
    1,
  );
  if (!d.allowed) throw new RateLimitedError(d.retryAfterMs, { reason: `real_markets_${bucket}` });
}

/**
 * The open, configured adapter for `id`, or a 503.
 * @param ctx - The app context.
 * @param id - The provider.
 */
function venue(ctx: Pick<AppContext, 'config'>, id: RealMarketProviderId): MarketProvider {
  assertProviderOn(ctx, id);
  const p = providerFor(ctx, id);
  if (!p.isConfigured()) {
    throw new RealMarketsProviderUnavailableError({ provider: id, reason: 'not_configured' });
  }
  return p;
}

// --- Config / eligibility ------------------------------------------------------

/**
 * What the client needs before it shows the terminal: whether this player may use it
 * here, which providers are open, the chain to authorize in MWA, attribution, risk copy
 * and limits. Never refuses for geo/age/wallet: it reports them.
 *
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 */
export async function realMarketsConfig(
  ctx: Pick<AppContext, 'config' | 'db'>,
  userId: string,
  geo: RequestGeo,
): Promise<Record<string, unknown>> {
  const providers = openProviders(ctx);
  const g = geoDecision(ctx.config, geo);
  const p = await loadPlayerGate(ctx, userId);
  const reasons: string[] = [];
  if (!isCapabilityOn(ctx, 'realMarkets')) reasons.push('capability_off');
  if (!g.allowed) reasons.push(g.reason);
  if (!p.ageConfirmed) reasons.push('age_required');
  if (p.wallet === null) reasons.push('wallet_required');
  if (providers.length > 0 && !providers.some((x) => x.configured)) {
    reasons.push('provider_not_configured');
  }
  return {
    enabled: isCapabilityOn(ctx, 'realMarkets'),
    eligible: reasons.length === 0,
    reasons,
    country: g.country,
    // Whether this request's country came from the trusted edge. False means the location
    // was ignored: the server has no edge secret (`edge_not_configured`) or the request did
    // not come through the Cloudflare-proxied host (`not_via_edge`).
    geoTrusted: geo.trusted,
    geoUntrustedReason: geo.trusted ? null : geo.untrustedReason,
    ageConfirmed: p.ageConfirmed,
    wallet: p.wallet,
    chain: REAL_MARKETS_CHAIN,
    cluster: 'mainnet',
    settlementMint: USDC_MAINNET_MINT,
    providers: providers.map((x) => ({
      id: x.id,
      configured: x.configured,
      attribution: ATTRIBUTION[x.id],
      categories: providerFor(ctx, x.id).categories,
      minOrderUsdc: minOrderUsdc(providerFor(ctx, x.id)),
    })),
    riskWarning: REAL_MARKETS_RISK_WARNING,
    limits: {
      maxOrderUsdc: String(ctx.config.realMarkets.maxOrderUsdc),
      dailyOrders: ctx.config.realMarkets.dailyOrderCap,
      defaultSlippageBps: DEFAULT_SLIPPAGE_BPS,
      maxSlippageBps: MAX_SLIPPAGE_BPS,
    },
    distribution: 'dapp_store_only',
  };
}

function minOrderUsdc(p: MarketProvider): string | null {
  return p.minOrderBase === null ? null : baseToUsdc(p.minOrderBase);
}

// --- Markets ----------------------------------------------------------------------

interface Cached<T> {
  readonly data: T;
  readonly asOf: string;
}

async function cached<T>(
  ctx: Pick<AppContext, 'redis'>,
  key: string,
  ttlSec: number,
  load: () => Promise<T>,
): Promise<Cached<T>> {
  const hit = await ctx.redis.main.get(key);
  if (hit) return JSON.parse(hit) as Cached<T>;
  const fresh: Cached<T> = { data: await load(), asOf: new Date().toISOString() };
  await ctx.redis.main.set(key, JSON.stringify(fresh), 'EX', ttlSec);
  return fresh;
}

/**
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @param q - Provider, category, cursor, limit.
 */
export async function listRealMarkets(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  q: {
    provider: RealMarketProviderId;
    category: string | null;
    cursor: string | null;
    limit: number;
  },
): Promise<{
  provider: RealMarketProviderId;
  items: RealMarketView[];
  nextCursor: string | null;
  asOf: string;
  attribution: Attribution;
}> {
  const p = venue(ctx, q.provider);
  await passGate(ctx, userId, geo);
  await rateLimit(ctx, userId, 'read');
  if (q.category !== null && !p.categories.includes(q.category)) {
    throw new ValidationFailedError({ reason: 'unknown_category', allowed: p.categories });
  }
  const key = `rm:list:${q.provider}:${q.category ?? '*'}:${q.cursor ?? '0'}:${q.limit}`;
  const page = await cached(ctx, key, LIST_CACHE_SEC, () =>
    p.listMarkets({ category: q.category, cursor: q.cursor, limit: q.limit }),
  );
  return {
    provider: q.provider,
    items: page.data.items.map(withMarketUrl),
    nextCursor: page.data.nextCursor,
    asOf: page.asOf,
    attribution: ATTRIBUTION[q.provider],
  };
}

/**
 * @param ctx - The app context.
 * @param id - The provider.
 * @param marketId - The venue's market id.
 * @returns The market (cached a few seconds) and when it was read.
 */
export async function marketDetail(
  ctx: AppContext,
  id: RealMarketProviderId,
  marketId: string,
): Promise<Cached<RealMarket>> {
  const p = venue(ctx, id);
  const r = await cached<RealMarket | null>(
    ctx,
    `rm:market:${id}:${marketId}`,
    DETAIL_CACHE_SEC,
    () => p.getMarket(marketId),
  );
  if (r.data === null) throw new NotFoundError({ kind: 'real_market', provider: id, marketId });
  return { data: r.data, asOf: r.asOf };
}

/**
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @param id - The provider.
 * @param marketId - The venue's market id.
 */
export async function getRealMarket(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  id: RealMarketProviderId,
  marketId: string,
): Promise<{ market: RealMarketView; asOf: string; attribution: Attribution }> {
  venue(ctx, id);
  await passGate(ctx, userId, geo);
  await rateLimit(ctx, userId, 'read');
  const r = await marketDetail(ctx, id, marketId);
  return { market: withMarketUrl(r.data), asOf: r.asOf, attribution: ATTRIBUTION[id] };
}

// --- Quote and build -----------------------------------------------------------------

export interface OrderRequest {
  readonly provider: RealMarketProviderId;
  readonly marketId: string;
  readonly side: RealSide;
  readonly amountUsdc: string;
}

function amountBase(
  ctx: Pick<AppContext, 'config'>,
  p: MarketProvider,
  amountUsdc: string,
): bigint {
  const base = usdcToBase(amountUsdc);
  if (base === null) throw new ValidationFailedError({ reason: 'invalid_amount' });
  const max = BigInt(ctx.config.realMarkets.maxOrderUsdc) * 1_000_000n;
  if (base > max) {
    throw new ValidationFailedError({ reason: 'amount_above_cap', maxUsdc: baseToUsdc(max) });
  }
  if (p.minOrderBase !== null && base < p.minOrderBase) {
    throw new ValidationFailedError({
      reason: 'amount_below_minimum',
      minUsdc: baseToUsdc(p.minOrderBase),
    });
  }
  return base;
}

/**
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @param req - Provider, market, side, USDC amount.
 */
export async function quoteRealOrder(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  req: OrderRequest,
): Promise<{
  quote: RealQuote;
  attribution: Attribution;
  riskWarning: typeof REAL_MARKETS_RISK_WARNING;
}> {
  const p = venue(ctx, req.provider);
  const gate = await passGate(ctx, userId, geo);
  await rateLimit(ctx, userId, 'quote');
  const base = amountBase(ctx, p, req.amountUsdc);
  const quote = await p.quote({
    wallet: gate.wallet,
    marketId: req.marketId,
    side: req.side,
    amountBase: base,
  });
  return { quote, attribution: ATTRIBUTION[req.provider], riskWarning: REAL_MARKETS_RISK_WARNING };
}

export interface BuildRequest extends OrderRequest {
  readonly quoteId?: string | undefined;
  readonly maxSlippageBps?: number | undefined;
  /** Optional echo of the wallet the client believes it signs with; must be the linked one. */
  readonly wallet?: string | undefined;
  readonly riskAccepted: boolean;
  readonly riskWarningVersion?: string | undefined;
}

/**
 * Build an unsigned mainnet transaction for the caller's linked wallet and record it.
 *
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param geo - The request location.
 * @param req - The order.
 * @param now - Injectable clock.
 */
export async function buildRealOrder(
  ctx: AppContext,
  userId: string,
  geo: RequestGeo,
  req: BuildRequest,
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  const p = venue(ctx, req.provider);
  const gate = await passGate(ctx, userId, geo);
  if (req.wallet !== undefined && req.wallet !== gate.wallet) {
    throw new RealMarketsWalletMismatchError({ linkedWallet: gate.wallet });
  }
  if (
    req.riskAccepted !== true ||
    (req.riskWarningVersion ?? REAL_MARKETS_RISK_WARNING.version) !==
      REAL_MARKETS_RISK_WARNING.version
  ) {
    throw new RiskNotAcceptedError({
      feature: 'realMarkets',
      version: REAL_MARKETS_RISK_WARNING.version,
    });
  }
  await rateLimit(ctx, userId, 'build');
  const base = amountBase(ctx, p, req.amountUsdc);
  const cap = ctx.config.realMarkets.dailyOrderCap;
  const today = await ctx.db.withConnection((c) =>
    c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM real_market_orders WHERE user_id = $1 AND created_at > $2`,
      [userId, new Date(now.getTime() - 86_400_000)],
    ),
  );
  if ((today.rows[0]?.n ?? 0) >= cap) {
    throw new RateLimitedError(undefined, { reason: 'real_markets_daily_cap', cap });
  }

  const built = await p.buildOrder({
    wallet: gate.wallet,
    marketId: req.marketId,
    side: req.side,
    amountBase: base,
    quoteId: req.quoteId ?? null,
    maxSlippageBps: req.maxSlippageBps ?? DEFAULT_SLIPPAGE_BPS,
  });

  const orderId = uuidv7(now.getTime());
  await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO real_market_orders
         (order_id, user_id, wallet, provider, market_id, side, amount_base, est_shares, fee_usdc,
          provider_order_id, provider_quote_id, program_ids, last_valid_block_height, country,
          risk_warning_version, created_at, expires_at, updated_at, recent_blockhash,
          ix_fingerprints)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$16,$18,$19)`,
      [
        orderId,
        userId,
        gate.wallet,
        req.provider,
        req.marketId,
        req.side,
        base.toString(),
        built.estShares,
        built.feeUsdc,
        built.providerOrderId,
        built.providerQuoteId,
        built.programIds,
        built.lastValidBlockHeight,
        gate.country,
        REAL_MARKETS_RISK_WARNING.version,
        now,
        built.expiresAt,
        built.recentBlockhash,
        built.fingerprints,
      ],
    ),
  );
  return {
    orderId,
    provider: req.provider,
    txBase64: built.txBase64,
    expiresAt: built.expiresAt.toISOString(),
    chain: REAL_MARKETS_CHAIN,
    wallet: gate.wallet,
    marketId: req.marketId,
    side: req.side,
    amountUsdc: baseToUsdc(base),
    estShares: built.estShares,
    feeUsdc: built.feeUsdc,
    attribution: ATTRIBUTION[req.provider],
  };
}
