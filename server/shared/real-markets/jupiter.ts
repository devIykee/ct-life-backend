/**
 * Jupiter Prediction Market API adapter (BETA; https://developers.jup.ag/docs/prediction,
 * OpenAPI prediction.yaml, re-read 2026-10-31). Aggregates Polymarket (and Kalshi)
 * liquidity on Solana.
 *
 *   GET  /events?provider=polymarket&includeMarkets=true&start&end&category&sortBy=volume
 *   GET  /markets/{marketId}           prices in micro USD (1,000,000 = $1)
 *   GET  /events/{eventId}             title and category for a single market
 *   POST /orders                       {ownerPubkey, marketId, isYes, isBuy, depositAmount, depositMint}
 *                                      -> unsigned transaction + order estimates (min $5)
 *   GET  /orders/status/{orderPubkey}  created | partiallyfilled | filled | failed
 *   GET  /positions?ownerPubkey=       contracts, cost basis, value, claimable (micro USD)
 *
 * Auth: `x-api-key` (JUPITER_API_KEY); keyless works at 0.5 req/s for exploration.
 * The wallet broadcasts through MWA `sign_and_send_transactions`, so `POST /execute` is
 * not used. Jupiter blocks US and South Korea IPs: the server that calls it must not be
 * in those regions (docs/REAL-MARKETS.md, rollout).
 *
 * Behind capability `realMarketsJupiter`, off by default: Jupiter's licence §3.1(h)
 * forbids content that "promotes ... gambling"; a written OK from Jupiter is pending.
 */
import {
  NotFoundError,
  RealMarketsOrderRejectedError,
  RealMarketsProviderError,
  RealMarketsProviderUnavailableError,
} from '../domain/errors.js';
import {
  JUPITER_CATEGORIES,
  USDC_MAINNET_MINT,
  baseToUsdc,
  microUsdToDecimal,
  type BuildInput,
  type BuiltOrder,
  type MarketProvider,
  type ProviderOrderState,
  type QuoteInput,
  type RealMarket,
  type RealMarketPage,
  type RealMarketStatus,
  type RealPosition,
  type RealQuote,
  type RealSide,
  type SubmittedInput,
} from '../domain/real-markets.js';
import { num, obj, str, venueFetch, type FetchLike, type VenueResponse } from './http.js';
import { inspectUnsignedTx } from './tx.js';

const ID = 'jupiter' as const;
const BLOCKHASH_SEC = 60;
/** "The minimum order is 5 USD (5000000 native token units)." */
const MIN_ORDER_BASE = 5_000_000n;

export interface JupiterOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
}

/**
 * @param r - A non-2xx Jupiter answer (429/5xx already handled by venueFetch).
 * @returns The domain error to throw.
 */
export function jupiterError(r: VenueResponse): Error {
  const b = obj(r.body);
  const code = str(b.code) ?? str(b.type);
  const message = str(b.message) ?? str(b.error);
  if (r.status === 401 || r.status === 403) {
    // A bad key, or the gateway refusing our server's IP region. Never echo the key.
    return new RealMarketsProviderUnavailableError({
      provider: ID,
      reason: r.status === 401 ? 'provider_auth' : 'provider_forbidden',
    });
  }
  if (r.status === 404) return new NotFoundError({ kind: 'real_market', provider: ID });
  if (r.status === 400 || r.status === 422) {
    return new RealMarketsOrderRejectedError({
      provider: ID,
      providerCode: code,
      providerMessage: message,
    });
  }
  return new RealMarketsProviderError({
    provider: ID,
    providerStatus: r.status,
    providerCode: code,
  });
}

function toUnix(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return Math.trunc(n);
  const s = str(v);
  if (s === null) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? Math.trunc(ms / 1000) : null;
}

function result(v: unknown): RealSide | null {
  const s = str(v)?.toLowerCase();
  return s === 'yes' || s === 'no' ? s : null;
}

/**
 * @param m - A Jupiter Market object.
 * @param event - Its event, when known.
 * @returns The normalised market.
 */
export function mapJupiterMarket(
  m: Record<string, unknown>,
  event: Record<string, unknown> | null,
): RealMarket {
  const pricing = obj(m.pricing);
  const meta = obj(event?.metadata);
  const raw = str(m.status);
  const res = result(m.result);
  let status: RealMarketStatus = 'open';
  if (raw === 'cancelled') status = 'cancelled';
  else if (res !== null) status = 'resolved';
  else if (raw === 'closed') status = 'closed';
  return {
    provider: ID,
    marketId: str(m.marketId) ?? '',
    eventId: str(m.eventId) ?? str(event?.eventId),
    eventTitle: str(meta.title),
    title: str(m.title) ?? '',
    description: null,
    category: str(event?.category),
    imageUrl: str(m.imageUrl) ?? str(meta.imageUrl),
    status,
    providerPhase: raw,
    tradable: raw === 'open' && m.tradable !== false,
    yesPrice: microUsdToDecimal(num(pricing.buyYesPriceUsd)),
    noPrice: microUsdToDecimal(num(pricing.buyNoPriceUsd)),
    sellYesPrice: microUsdToDecimal(num(pricing.sellYesPriceUsd)),
    sellNoPrice: microUsdToDecimal(num(pricing.sellNoPriceUsd)),
    // Event volume (micro USD); markets carry no USD volume of their own.
    volumeUsdc: microUsdToDecimal(str(event?.volumeUsd)),
    closeTime: toUnix(m.closeTime),
    resolveTime: toUnix(m.resolveAt),
    result: res,
    rules: str(m.rulesPrimary),
  };
}

/** Jupiter's Prediction Market API behind the provider interface. */
export class JupiterPredictionProvider implements MarketProvider {
  readonly id = ID;
  readonly categories: readonly string[] = JUPITER_CATEGORIES;
  readonly minOrderBase = MIN_ORDER_BASE;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly opts: JupiterOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? (() => new Date());
  }

  /** Keyless calls work (0.5 req/s); production needs JUPITER_API_KEY. */
  isConfigured(): boolean {
    return this.opts.apiKey !== '';
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new RealMarketsProviderUnavailableError({ provider: ID, reason: 'not_configured' });
    }
    const r = await venueFetch(
      ID,
      {
        method,
        url: `${this.opts.baseUrl.replace(/\/+$/, '')}${path}`,
        headers: { 'x-api-key': this.opts.apiKey },
        ...(body !== undefined ? { body } : {}),
        retry: method === 'GET',
      },
      this.fetchImpl,
    );
    if (r.status < 200 || r.status >= 300) throw jupiterError(r);
    return r.body;
  }

  async listMarkets(q: {
    category: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<RealMarketPage> {
    const start = q.cursor !== null && /^\d+$/.test(q.cursor) ? Number(q.cursor) : 0;
    const end = start + Math.min(q.limit, 50);
    const qs = new URLSearchParams({
      provider: 'polymarket',
      includeMarkets: 'true',
      sortBy: 'volume',
      start: String(start),
      end: String(end),
    });
    if (q.category) qs.set('category', q.category);
    const b = obj(await this.call('GET', `/events?${qs.toString()}`));
    const events = Array.isArray(b.data) ? b.data : [];
    const items: RealMarket[] = [];
    for (const e of events) {
      const ev = obj(e);
      for (const m of Array.isArray(ev.markets) ? ev.markets : []) {
        const mapped = mapJupiterMarket(obj(m), ev);
        if (mapped.marketId !== '') items.push(mapped);
      }
    }
    const hasNext = obj(b.pagination).hasNext === true;
    return { items, nextCursor: hasNext ? String(end) : null };
  }

  async getMarket(marketId: string): Promise<RealMarket | null> {
    let m: Record<string, unknown>;
    try {
      m = obj(await this.call('GET', `/markets/${encodeURIComponent(marketId)}`));
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
    let event: Record<string, unknown> | null = null;
    const eventId = str(m.eventId);
    if (eventId) {
      try {
        event = obj(await this.call('GET', `/events/${encodeURIComponent(eventId)}`));
      } catch {
        event = null; // Title and category are optional extras.
      }
    }
    return mapJupiterMarket(m, event);
  }

  private async createOrder(input: QuoteInput): Promise<Record<string, unknown>> {
    return obj(
      await this.call('POST', '/orders', {
        ownerPubkey: input.wallet,
        marketId: input.marketId,
        isYes: input.side === 'yes',
        isBuy: true,
        depositAmount: input.amountBase.toString(),
        depositMint: USDC_MAINNET_MINT,
      }),
    );
  }

  private estimates(order: Record<string, unknown>): {
    estShares: string | null;
    avgPrice: string | null;
    feeUsdc: string | null;
  } {
    const contractsMicro = str(order.contractsMicro);
    const costMicro = str(order.orderCostUsd);
    let avgPrice: string | null = null;
    if (contractsMicro && costMicro && /^\d+$/.test(contractsMicro) && /^\d+$/.test(costMicro)) {
      const c = BigInt(contractsMicro);
      if (c > 0n) avgPrice = baseToUsdc((BigInt(costMicro) * 1_000_000n) / c);
    }
    return {
      estShares: str(order.contractsDecimal),
      avgPrice,
      feeUsdc: microUsdToDecimal(str(order.estimatedTotalFeeUsd)),
    };
  }

  async quote(input: QuoteInput): Promise<RealQuote> {
    // Jupiter has no quote session: an order build doubles as the quote (its unsigned
    // transaction is discarded and never shown to the wallet).
    const b = await this.createOrder(input);
    const est = this.estimates(obj(b.order));
    return {
      provider: ID,
      marketId: input.marketId,
      side: input.side,
      amountUsdc: baseToUsdc(input.amountBase),
      quoteId: null,
      ...est,
      expiresAt: new Date(this.now().getTime() + BLOCKHASH_SEC * 1000).toISOString(),
    };
  }

  async buildOrder(input: BuildInput): Promise<BuiltOrder> {
    const b = await this.createOrder(input);
    const order = obj(b.order);
    const owner = str(order.userPubkey);
    if (owner !== null && owner !== input.wallet) {
      throw new RealMarketsProviderError({ provider: ID, reason: 'wallet_mismatch' });
    }
    const txB64 = str(b.transaction);
    if (!txB64) throw new RealMarketsProviderError({ provider: ID, reason: 'missing_transaction' });
    const tx = inspectUnsignedTx(ID, input.wallet, txB64);
    return {
      txBase64: tx.txBase64,
      providerOrderId: str(order.orderPubkey),
      providerQuoteId: null,
      lastValidBlockHeight: num(obj(b.txMeta).lastValidBlockHeight),
      expiresAt: new Date(this.now().getTime() + BLOCKHASH_SEC * 1000),
      programIds: tx.programIds,
      recentBlockhash: tx.recentBlockhash,
      fingerprints: tx.fingerprints,
      estShares: this.estimates(order).estShares,
      feeUsdc: this.estimates(order).feeUsdc,
    };
  }

  /** The wallet broadcast it; Jupiter's keepers pick the order up from chain. */
  async notifySubmitted(): Promise<void> {
    return undefined;
  }

  /** Jupiter has no attribution report for Prediction. */
  async notifyConfirmed(): Promise<void> {
    return undefined;
  }

  async orderState(input: SubmittedInput): Promise<ProviderOrderState> {
    if (!input.providerOrderId) return 'unknown';
    let b: Record<string, unknown>;
    try {
      b = obj(
        await this.call('GET', `/orders/status/${encodeURIComponent(input.providerOrderId)}`),
      );
    } catch (e) {
      // "no order history found" right after submission is normal indexer lag.
      if (e instanceof NotFoundError) return 'pending';
      throw e;
    }
    switch (str(b.status)) {
      case 'filled':
        return 'filled';
      case 'failed':
        return 'failed';
      case 'created':
      case 'pending':
      case 'partiallyfilled':
        return 'pending';
      default:
        return 'unknown';
    }
  }

  async positions(wallet: string): Promise<RealPosition[]> {
    const qs = new URLSearchParams({ ownerPubkey: wallet, start: '0', end: '100' });
    const b = obj(await this.call('GET', `/positions?${qs.toString()}`));
    const rows = Array.isArray(b.data) ? b.data : [];
    return rows.map((r) => {
      const p = obj(r);
      const mm = obj(p.marketMetadata);
      const em = obj(p.eventMetadata);
      const title = [str(em.title), str(mm.title)].filter(Boolean).join(' · ');
      return {
        provider: ID,
        marketId: str(p.marketId) ?? '',
        title: title === '' ? null : title,
        side: p.isYes === true ? 'yes' : 'no',
        shares: str(p.contractsDecimal) ?? str(p.contracts) ?? '0',
        status: str(mm.status),
        claimable: p.claimable === true,
        claimed: p.claimed === true,
        outcome: result(mm.result),
        avgPrice: microUsdToDecimal(str(p.avgPriceUsd)),
        costUsdc: microUsdToDecimal(str(p.totalCostUsd)),
        estValueUsdc: microUsdToDecimal(str(p.valueUsd)),
      } satisfies RealPosition;
    });
  }
}
