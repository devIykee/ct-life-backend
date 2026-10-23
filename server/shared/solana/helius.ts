/**
 * Helius RPC client.
 *
 * Uses plain fetch against the Helius RPC URL. The official helius-sdk
 * has an incompatible peer dep (it requires @solana/kit ^6.9 but we
 * pin 8.4) and we don't need its webhook helpers at M2. The SGT check
 * uses getTokenAccountsByOwnerV2 only.
 *
 * The client is built once at composition time and shared by all
 * callers. Each call sets a timeout from `requestTimeoutMs`. Failures
 * surface as `HeliusError` so callers can map them to RATE_LIMITED or
 * 503 at the transport boundary.
 */

export class HeliusError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  /**
   * @param message - Human-readable description of the failure.
   * @param code - Short machine code (UNAUTHORIZED, RATE_LIMITED, ...).
   * @param httpStatus - Suggested HTTP status for the API response.
   */
  constructor(message: string, code: string, httpStatus: number) {
    super(message);
    this.name = 'HeliusError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface HeliusClient {
  /** Health check; returns the `result` string from getHealth. */
  health(): Promise<string>;
  /**
   * Returns the JSON `result` of an arbitrary RPC call. Used by
   * getTokenAccountsByOwnerV2 for the SGT check and by the market
   * (M3) for price feeds.
   */
  rpc<T>(method: string, params: unknown[]): Promise<T>;
  /**
   * Look up the token accounts owned by `owner` and return the ones
   * that match the SGT group (Seeker Genesis Token). Returns the
   * matching token mints.
   */
  sgtMintsFor(owner: string, sgtGroup: string): Promise<string[]>;
  /**
   * DAS searchAssets: the ids of the assets `owner` holds in the
   * Metaplex collection `collection` (Core or Token Metadata). Used by
   * the entitlement wallet sync.
   */
  collectionAssetsOwnedBy(owner: string, collection: string): Promise<string[]>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export interface HeliusClientOptions {
  readonly url: string;
  readonly apiKey: string;
  /** Per-RPC-call timeout in ms. */
  readonly requestTimeoutMs?: number;
  /** Inject a fetch implementation for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build a Helius client. The URL is the full Helius RPC URL (with
 * `?api-key=…` if required). Failures surface as HeliusError so the
 * transport layer can map them to 502/503/504.
 */
export function createHeliusClient(opts: HeliusClientOptions): HeliusClient {
  const f = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(opts.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ct-life', method, params }),
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new HeliusError(`Helius auth failed: ${res.status}`, 'UNAUTHORIZED', 502);
      }
      if (res.status === 429) {
        throw new HeliusError('Helius rate limit', 'RATE_LIMITED', 503);
      }
      if (!res.ok) {
        throw new HeliusError(`Helius HTTP ${res.status}`, 'UPSTREAM', 502);
      }
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) {
        throw new HeliusError(`Helius RPC ${method}: ${body.error.message}`, 'RPC_ERROR', 502);
      }
      if (body.result === undefined) {
        throw new HeliusError(`Helius RPC ${method}: no result`, 'RPC_ERROR', 502);
      }
      return body.result;
    } catch (e) {
      if (e instanceof HeliusError) throw e;
      if ((e as { name?: string }).name === 'AbortError') {
        throw new HeliusError(`Helius RPC ${method} timed out`, 'TIMEOUT', 504);
      }
      throw new HeliusError(
        `Helius RPC ${method}: ${(e as Error).message ?? 'unknown'}`,
        'NETWORK',
        502,
      );
    } finally {
      clearTimeout(t);
    }
  }

  return {
    health() {
      return call<string>('getHealth', []);
    },
    rpc<T>(method: string, params: unknown[]) {
      return call<T>(method, params);
    },
    async sgtMintsFor(owner: string, sgtGroup: string) {
      // Helius DAS: getTokenAccountsByOwnerV2 with `groupKey` for the
      // SGT collection. Returns { total, limit, token_accounts: [...] }.
      // We extract the mint of every token account that belongs to the
      // group. The `page` param is unused because SGT collections are
      // small (one token per phone).
      const result = await call<{
        token_accounts?: Array<{ mint: string }>;
      }>('getTokenAccountsByOwnerV2', [owner, { groupKey: sgtGroup }, { page: 1, limit: 10 }]);
      const accounts = result.token_accounts ?? [];
      return accounts.map((a) => a.mint);
    },
    async collectionAssetsOwnedBy(owner: string, collection: string) {
      // DAS searchAssets with a collection grouping. A pass collection
      // allows one or two per wallet, so the first page is enough.
      const result = await call<{ items?: Array<{ id: string; burnt?: boolean }> }>(
        'searchAssets',
        { ownerAddress: owner, grouping: ['collection', collection], page: 1, limit: 50 },
      );
      return (result.items ?? []).filter((a) => !a.burnt).map((a) => a.id);
    },
  };
}
