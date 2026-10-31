/**
 * Panta partner REST API adapter (https://docs.panta.market, re-read 2026-10-31).
 *
 *   GET  /markets/?category&status&cursor&limit   catalog (no prices on list rows)
 *   GET  /markets/{marketId}/                     detail with spot prices
 *   POST /primaryorderquote/                      {wallet, marketId, side, amountUsdc} -> quoteId (~90 s)
 *   POST /primaryorderbuild/                      {quoteId, wallet, maxSlippageBps} -> instructions + recentBlockhash
 *   POST /primaryordersubmit/                     {orderId, signature, wallet}   (idempotent per orderId+signature)
 *   POST /primaryorderverify/                     {orderId, signature, wallet} -> built|submitted|confirmed|failed|expired
 *   POST /trades/                                 {signature, wallet, marketId, quoteId} attribution (idempotent per signature)
 *   GET  /positions/?wallet=                      shares per side, claimable
 *
 * Auth is `X-Api-Key` (PANTA_API_KEY), server-side only: Panta forbids keys in a mobile
 * binary. Trailing slashes are required. Amounts on primary buys are decimal USDC strings.
 * We send no `userId`, so attribution defaults to our partner account and no CT Life
 * user id leaves the server.
 *
 * Scope of this adapter: primary buys only. Secondary-book trades, claims and disputes
 * are later phases; a graduated market (`secondary`) is listed but not `tradable`.
 */
import {
  NotFoundError,
  RealMarketsOrderRejectedError,
  RealMarketsProviderError,
  RealMarketsProviderUnavailableError,
  RealMarketsQuoteExpiredError,
} from '../domain/errors.js';
import {
  PANTA_CATEGORIES,
  baseToUsdc,
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
import { compileUnsignedV0, type WireInstruction } from './tx.js';

const ID = 'panta' as const;
/** Panta's blockhash hint when the build omits `blockhashExpiryHintSec`. */
const DEFAULT_BLOCKHASH_SEC = 60;

export interface PantaOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
}

/** Venue codes that mean "this order cannot be built as asked" (422 to the client). */
const REJECT_CODES = new Set([
  'AMOUNT_TOO_SMALL',
  'MARKET_NOT_IN_PRIMARY',
  'INVALID_MARKET_PARAMS',
  'TX_NOT_FOUND',
  'TX_FAILED',
  'TX_MISMATCH',
  'TX_FEE_MISMATCH',
  'FORBIDDEN',
]);

/**
 * Map a non-2xx Panta answer to a Real Markets domain error. 429 and 5xx were already
 * handled by `venueFetch`.
 *
 * @param r - The venue response.
 * @returns The error to throw.
 */
export function pantaError(r: VenueResponse): Error {
  const b = obj(r.body);
  const code = str(b.code);
  const message = str(b.message);
  if (r.status === 401 || code === 'UNAUTHORIZED') {
    // Our partner key is missing or wrong. Never echo it.
    return new RealMarketsProviderUnavailableError({ provider: ID, reason: 'provider_auth' });
  }
  if (code === 'MARKET_NOT_FOUND' || r.status === 404) {
    return new NotFoundError({ kind: 'real_market', provider: ID });
  }
  if (code === 'QUOTE_EXPIRED' || code === 'QUOTE_STALE') {
    return new RealMarketsQuoteExpiredError({
      provider: ID,
      reason: code === 'QUOTE_STALE' ? 'stale' : 'expired',
    });
  }
  if (code !== null && REJECT_CODES.has(code)) {
    return new RealMarketsOrderRejectedError({
      provider: ID,
      providerCode: code,
      providerMessage: message,
      field: str(b.field),
    });
  }
  return new RealMarketsProviderError({
    provider: ID,
    providerStatus: r.status,
    providerCode: code,
  });
}

function phaseToStatus(phase: string | null, resolved: boolean): RealMarketStatus {
  if (phase === 'resolved' || resolved) return 'resolved';
  if (phase === 'cancelled') return 'cancelled';
  return 'open';
}

function side(v: unknown): RealSide | null {
  const s = str(v)?.toLowerCase();
  return s === 'yes' || s === 'no' ? s : null;
}

/**
 * @param row - One Panta catalog or detail row.
 * @returns The normalised market.
 */
export function mapPantaMarket(row: Record<string, unknown>): RealMarket {
  const phase = str(row.phase);
  const images = Array.isArray(row.images) ? row.images : [];
  const resolved = row.resolved === true;
  return {
    provider: ID,
    marketId: str(row.marketId) ?? '',
    eventId: null,
    eventTitle: null,
    title: str(row.title) ?? '',
    description: str(row.description),
    category: str(row.category),
    imageUrl: str(images[0]),
    status: phaseToStatus(phase, resolved),
    providerPhase: phase,
    // Primary buys only in this phase; a graduated (secondary) market is read-only here.
    tradable: phase === 'primary' && !resolved,
    yesPrice: str(row.yesPrice),
    noPrice: str(row.noPrice),
    sellYesPrice: null,
    sellNoPrice: null,
    volumeUsdc: str(row.volumeUsdc),
    closeTime: num(row.endTime),
    resolveTime: num(row.resolutionTime),
    // Panta catalog rows carry no outcome; positions report it after resolution.
    result: null,
    rules: null,
  };
}

/** The Panta partner API behind the provider interface. */
export class PantaProvider implements MarketProvider {
  readonly id = ID;
  readonly categories: readonly string[] = PANTA_CATEGORIES;
  /** Panta's minimum fill is not published (AMOUNT_TOO_SMALL comes back from quote). */
  readonly minOrderBase = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly opts: PantaOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = opts.now ?? (() => new Date());
  }

  isConfigured(): boolean {
    return this.opts.apiKey !== '';
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
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
        // Reads and Panta's documented-idempotent writes retry; quote/build do not.
        retry: method === 'GET' || path === '/primaryordersubmit/' || path === '/trades/',
      },
      this.fetchImpl,
    );
    if (r.status < 200 || r.status >= 300) throw pantaError(r);
    return obj(r.body);
  }

  async listMarkets(q: {
    category: string | null;
    cursor: string | null;
    limit: number;
  }): Promise<RealMarketPage> {
    const qs = new URLSearchParams({ limit: String(Math.min(q.limit, 50)) });
    if (q.category) qs.set('category', q.category);
    if (q.cursor) qs.set('cursor', q.cursor);
    const b = await this.call('GET', `/markets/?${qs.toString()}`);
    const items = Array.isArray(b.items) ? b.items : [];
    return {
      items: items.map((r) => mapPantaMarket(obj(r))).filter((m) => m.marketId !== ''),
      nextCursor: str(b.nextCursor),
    };
  }

  async getMarket(marketId: string): Promise<RealMarket | null> {
    try {
      const b = await this.call('GET', `/markets/${encodeURIComponent(marketId)}/`);
      return mapPantaMarket(b);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  async quote(input: QuoteInput): Promise<RealQuote> {
    const b = await this.call('POST', '/primaryorderquote/', {
      wallet: input.wallet,
      marketId: input.marketId,
      side: input.side,
      amountUsdc: baseToUsdc(input.amountBase),
    });
    const quoteId = str(b.quoteId);
    if (!quoteId) throw new RealMarketsProviderError({ provider: ID, reason: 'missing_quote_id' });
    return {
      provider: ID,
      marketId: input.marketId,
      side: input.side,
      amountUsdc: baseToUsdc(input.amountBase),
      quoteId,
      estShares: str(b.shares),
      avgPrice: str(b.avgPrice),
      feeUsdc: str(b.feeUsdc),
      expiresAt: str(b.expiresAt),
    };
  }

  async buildOrder(input: BuildInput): Promise<BuiltOrder> {
    // Panta's build needs a live quote; take a fresh one when the client has none.
    const quoteId = input.quoteId ?? (await this.quote(input)).quoteId;
    const b = await this.call('POST', '/primaryorderbuild/', {
      quoteId,
      wallet: input.wallet,
      maxSlippageBps: input.maxSlippageBps,
    });
    if (str(b.wallet) !== null && str(b.wallet) !== input.wallet) {
      throw new RealMarketsProviderError({ provider: ID, reason: 'wallet_mismatch' });
    }
    if (str(b.marketId) !== null && str(b.marketId) !== input.marketId) {
      throw new RealMarketsProviderError({ provider: ID, reason: 'market_mismatch' });
    }
    const blockhash = str(b.recentBlockhash);
    const raw = Array.isArray(b.instructions) ? b.instructions : [];
    if (!blockhash)
      throw new RealMarketsProviderError({ provider: ID, reason: 'missing_blockhash' });
    const instructions: WireInstruction[] = raw.map((ix) => {
      const o = obj(ix);
      return {
        programId: str(o.programId) ?? '',
        data: str(o.data) ?? '',
        accounts: (Array.isArray(o.accounts) ? o.accounts : []).map((a) => {
          const ao = obj(a);
          return {
            pubkey: str(ao.pubkey) ?? '',
            isSigner: ao.isSigner === true,
            isWritable: ao.isWritable === true,
          };
        }),
      };
    });
    const tx = compileUnsignedV0(ID, input.wallet, instructions, blockhash);
    const hintSec = num(b.blockhashExpiryHintSec) ?? DEFAULT_BLOCKHASH_SEC;
    const blockhashExpiry = this.now().getTime() + hintSec * 1000;
    const sessionExpiry = Date.parse(str(b.expiresAt) ?? '');
    const expiresAt = new Date(
      Number.isFinite(sessionExpiry) ? Math.min(blockhashExpiry, sessionExpiry) : blockhashExpiry,
    );
    return {
      txBase64: tx.txBase64,
      providerOrderId: str(b.orderId),
      providerQuoteId: quoteId,
      lastValidBlockHeight: num(b.lastValidBlockHeight),
      expiresAt,
      programIds: tx.programIds,
      recentBlockhash: tx.recentBlockhash,
      fingerprints: tx.fingerprints,
      estShares: str(b.expectedShares),
      feeUsdc: str(b.feeUsdc),
    };
  }

  async notifySubmitted(input: SubmittedInput): Promise<void> {
    if (!input.providerOrderId) return;
    await this.call('POST', '/primaryordersubmit/', {
      orderId: input.providerOrderId,
      signature: input.signature,
      wallet: input.wallet,
    });
  }

  async notifyConfirmed(input: SubmittedInput): Promise<void> {
    await this.call('POST', '/trades/', {
      signature: input.signature,
      wallet: input.wallet,
      marketId: input.marketId,
      ...(input.providerQuoteId ? { quoteId: input.providerQuoteId } : {}),
    });
  }

  async orderState(input: SubmittedInput): Promise<ProviderOrderState> {
    if (!input.providerOrderId) return 'unknown';
    const b = await this.call('POST', '/primaryorderverify/', {
      orderId: input.providerOrderId,
      signature: input.signature,
      wallet: input.wallet,
    });
    switch (str(b.status)) {
      case 'confirmed':
        return 'filled';
      case 'failed':
      case 'expired':
        return 'failed';
      case 'built':
      case 'submitted':
        return 'pending';
      default:
        return 'unknown';
    }
  }

  async positions(wallet: string): Promise<RealPosition[]> {
    const b = await this.call('GET', `/positions/?wallet=${encodeURIComponent(wallet)}`);
    const rows = Array.isArray(b.positions) ? b.positions : [];
    const out: RealPosition[] = [];
    for (const r of rows) {
      const o = obj(r);
      const s = side(o.side);
      const marketId = str(o.marketId);
      if (!s || !marketId) continue;
      out.push({
        provider: ID,
        marketId,
        title: null,
        side: s,
        shares: str(o.shares) ?? '0',
        status: str(o.phase),
        claimable: o.claimable === true,
        claimed: o.claimed === true,
        outcome: side(o.outcome),
        avgPrice: null,
        costUsdc: null,
        // Filled by the service from cached market detail (Panta returns shares only).
        estValueUsdc: null,
      });
    }
    return out;
  }
}
