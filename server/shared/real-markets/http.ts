/**
 * The one HTTP path Real Markets adapters use to reach a venue: JSON in and out, a hard
 * timeout, bounded retries with jittered backoff for idempotent reads, and secret-free
 * failures. Credentials are passed in as headers and never appear in errors or logs.
 */
import { RateLimitedError, RealMarketsProviderUnavailableError } from '../domain/errors.js';
import type { RealMarketProviderId } from '../domain/real-markets.js';

export type FetchLike = typeof fetch;

export interface VenueResponse {
  readonly status: number;
  /** Parsed JSON, or null when the body was empty or not JSON. */
  readonly body: unknown;
  readonly headers: Headers;
}

export interface VenueRequest {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: unknown;
  /** Retry network failures, timeouts and 5xx (reads only). */
  readonly retry: boolean;
}

const TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;

/**
 * @param attempt - 1-based attempt that just failed.
 * @returns Milliseconds to wait: 200 ms doubling, with full jitter.
 */
function backoffMs(attempt: number): number {
  return Math.floor(Math.random() * 200 * 2 ** (attempt - 1));
}

/**
 * Send one venue request. Returns any HTTP answer (the adapter maps 4xx codes); throws
 * REAL_MARKETS_PROVIDER_UNAVAILABLE for timeouts, network errors and 5xx after retries,
 * and RATE_LIMITED for 429 (honouring Retry-After).
 *
 * @param provider - Which venue (for error details).
 * @param req - The request.
 * @param fetchImpl - Injected fetch (tests).
 * @returns The status, parsed body and headers.
 */
export async function venueFetch(
  provider: RealMarketProviderId,
  req: VenueRequest,
  fetchImpl: FetchLike,
): Promise<VenueResponse> {
  const attempts = req.retry ? MAX_ATTEMPTS : 1;
  let lastReason = 'network';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(req.url, {
        method: req.method,
        headers: {
          accept: 'application/json',
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...req.headers,
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      if (res.status === 429) {
        const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
        throw new RateLimitedError(Number.isFinite(ra) ? ra * 1000 : 5_000, {
          reason: 'provider_rate_limited',
          provider,
        });
      }
      if (res.status >= 500) {
        lastReason = `upstream_${res.status}`;
      } else {
        return { status: res.status, body, headers: res.headers };
      }
    } catch (e) {
      if (e instanceof RateLimitedError) throw e;
      lastReason = (e as { name?: string }).name === 'AbortError' ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, backoffMs(attempt)));
  }
  throw new RealMarketsProviderUnavailableError({ provider, reason: lastReason });
}

/** @returns `v` when it is a non-null object, else an empty one. */
export function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** @returns `v` when it is a string, else null. */
export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** @returns `v` when it is a finite number, else null. */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
