/**
 * Reference price sources for `crypto` prediction markets (unlock D3).
 *
 * Pluggable: the market worker asks a `ReferencePriceSource` for one closed
 * 1-minute candle. Today the only implementation reads Binance's keyless
 * public spot market data, `GET /api/v3/klines` (weight 2), documented at
 * https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints.
 * Each row is `[openTime, open, high, low, close, volume, closeTime, ...]`.
 *
 * Which host is chosen by PREDICTIONS_CRYPTO_SOURCE:
 *   - `off` (default): no source; the worker opens only `sim` and `event`
 *     markets (the fallback the plan asks for).
 *   - `binance`: https://api.binance.com. [Unverified] forum reports say it
 *     answers 451 to US IPs; Railway lets the service pick a region.
 *   - `binance_vision`: https://data-api.binance.vision, which Binance
 *     documents as the host that "only" serves public market data. Its
 *     dataset terms are CC BY-NC-SA 4.0 and exclude commercial use
 *     (https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf, §3-4), so
 *     do not turn it on for a monetized build without clearing that.
 *
 * Rate limits: a 429 or 418 answer stores a back-off in Redis for the
 * `Retry-After` seconds (at least 60), and every call is skipped until it
 * expires: Binance bans IPs that keep calling after a 429. Every call has an
 * 8 s timeout. There is no retry loop here; the worker runs once a minute and
 * the resolver gives up (void and refund) after `resolveGraceSec`.
 */
import type { AppContext } from './context.js';

export interface MinuteCandle {
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly openMicros: bigint;
  readonly closeMicros: bigint;
}

export interface ReferencePriceSource {
  /** Contract `source.type` of the markets it backs. */
  readonly type: 'binance';
  /** Contract `source.ref` (the host), for the client and for audits. */
  readonly ref: string;
  /**
   * The 1-minute candle that opens at `openTimeMs` (a whole minute).
   * @returns The candle, or null when the source has none (yet) or is backing off.
   */
  minuteCandle(symbol: string, openTimeMs: number): Promise<MinuteCandle | null>;
}

const HOSTS = {
  binance: 'https://api.binance.com',
  binance_vision: 'https://data-api.binance.vision',
} as const;

const TIMEOUT_MS = 8_000;
const MIN_BACKOFF_SEC = 60;

/**
 * A decimal string ("77516.62000000") as integer micros (77516620000n).
 * @param s - A non-negative decimal from the API.
 * @returns The value in micros, truncated past 6 decimals.
 */
export function decimalToMicros(s: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new RangeError(`not a decimal: ${s}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

/** Binance spot klines, keyless. */
export class BinanceKlineSource implements ReferencePriceSource {
  readonly type = 'binance' as const;
  /**
   * @param ctx - The app context (Redis holds the shared back-off).
   * @param baseUrl - The API host, without a trailing slash.
   */
  constructor(
    private readonly ctx: Pick<AppContext, 'redis'>,
    private readonly baseUrl: string,
  ) {}

  /** The host, as `source.ref`. */
  get ref(): string {
    return new URL(this.baseUrl).host;
  }

  private get backoffKey(): string {
    return `predictions:source:backoff:${this.ref}`;
  }

  /** @inheritdoc */
  async minuteCandle(symbol: string, openTimeMs: number): Promise<MinuteCandle | null> {
    if (await this.ctx.redis.main.get(this.backoffKey)) return null;
    const url = `${this.baseUrl}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${openTimeMs}&limit=1`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return null; // timeout or network: the next run tries again
    }
    if (res.status === 429 || res.status === 418) {
      const retry = Number(res.headers.get('retry-after') ?? '0');
      const sec = Math.max(MIN_BACKOFF_SEC, Number.isFinite(retry) ? retry : 0);
      await this.ctx.redis.main.set(this.backoffKey, String(res.status), 'EX', sec);
      return null;
    }
    if (!res.ok) return null; // 451 (restricted location), 5xx: unavailable
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) return null;
    const row = rows[0] as unknown[];
    if (Number(row[0]) !== openTimeMs) return null; // no candle for that minute
    return {
      openTimeMs: Number(row[0]),
      closeTimeMs: Number(row[6]),
      openMicros: decimalToMicros(String(row[1])),
      closeMicros: decimalToMicros(String(row[4])),
    };
  }
}

/**
 * The configured source, or null when crypto markets are off.
 * @param ctx - The app context.
 * @param baseUrlOverride - Test-only host (a local HTTP server).
 * @returns The source, or null.
 */
export function referencePriceSource(
  ctx: Pick<AppContext, 'redis' | 'config'>,
  baseUrlOverride?: string,
): ReferencePriceSource | null {
  const which = ctx.config.features.predictionCryptoSource;
  if (which === 'off') return null;
  return new BinanceKlineSource(ctx, baseUrlOverride ?? HOSTS[which]);
}
