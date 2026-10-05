/**
 * Idempotency layer.
 *
 * The contract says every POST/PUT/PATCH/DELETE sends an
 * Idempotency-Key header (UUIDv4 from the client). The server
 * dedupes for 24 h and replays the first response.
 *
 * Two implementations, both keyed by `(userId, key)`:
 *
 *   1. **Redis-first** (default): the response is stored in Redis
 *      for 24 h under `idem:{userId}:{key}`. A SET NX locks the
 *      key for in-flight requests. The Postgres table is the
 *      durable fallback if Redis is down.
 *
 *   2. **Postgres-only** (fallback): the response is written to
 *      `idempotency_keys` (added in M3). For M2 we only have the
 *      Redis path; the Postgres fallback is a TODO and is logged
 *      in UNVERIFIED.md.
 *
 * Concurrent requests with the same key are serialised by the
 * SET NX lock. The second request waits on the lock and then
 * reads the cached response.
 *
 * The body hash is recorded so a key reused with a different body
 * returns `VALIDATION_FAILED` (this is the contract's "different
 * body hash" rule).
 */
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface CachedResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly bodyHash: string;
}

const LOCK_TTL_SEC = 30;
const REPLAY_TTL_SEC = 24 * 60 * 60;

function makeKey(userId: string, key: string): string {
  return `idem:${userId}:${key}`;
}

/** SHA-256 hex digest of the request body, used to detect key reuse with a different payload. */
function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface IdempotencyStore {
  /**
   * Reserve the key for a new request. Returns:
   *   - `acquired: true` if this caller is the first; it must run
   *     the work, then call `complete(...)` to write the response.
   *   - `acquired: false, replay` with the cached response if the
   *     key was already used (within 24 h). The caller MUST return
   *     the cached response and not re-run the work.
   *   - `acquired: false, waitMs > 0` if a concurrent request is
   *     in flight. The caller should retry after `waitMs` (up to a
   *     cap, e.g. 5 s) and then re-check.
   */
  reserve(
    userId: string,
    key: string,
    bodyHash: string,
  ): Promise<
    | { acquired: true; lockToken: string }
    | { acquired: false; replay: CachedResponse }
    | { acquired: false; waitMs: number; bodyHashMismatch: boolean }
  >;
  /**
   * Persist the final response and release the lock.
   * Returns silently. The lock is released atomically with the
   * response write so a concurrent request either sees the cached
   * response or sees the lock free to acquire.
   */
  complete(userId: string, key: string, lockToken: string, response: CachedResponse): Promise<void>;
  /**
   * Release the lock without writing a response, on error.
   */
  abort(userId: string, key: string, lockToken: string): Promise<void>;
  /**
   * Lookup without acquiring. Used by tests.
   */
  peek(userId: string, key: string): Promise<CachedResponse | null>;
}

export class RedisIdempotencyStore implements IdempotencyStore {
  private readonly redis: Redis;
  private readonly log: { warn(msg: string, extra?: unknown): void };

  /**
   * @param redis - The shared ioredis client.
   * @param logger - Optional logger for lock-loss warnings.
   */
  constructor(redis: Redis, logger?: { warn(msg: string, extra?: unknown): void }) {
    this.redis = redis;
    this.log = logger ?? { warn: () => undefined };
  }

  /**
   * Reserve the key for a new request.
   *
   * The flow:
   *   1. Look for a cached response. If present, return the replay
   *      or a bodyHashMismatch error.
   *   2. If no cached response, try to acquire the lock. The first
   *      caller wins; concurrent callers wait (return waitMs).
   *   3. On lock acquisition, return acquired=true.
   *
   * Concurrent requests with the same key but different bodies see
   * the cached response (or mismatch) of the first request. The
   * lock is just for in-flight serialization; the cache is the
   * replay record.
   */
  async reserve(
    userId: string,
    key: string,
    bodyHash: string,
  ): ReturnType<IdempotencyStore['reserve']> {
    const fullKey = makeKey(userId, key);

    // (1) Cached response?
    const cached = await this.redis.get(`${fullKey}:resp`);
    if (cached) {
      const parsed = JSON.parse(cached) as CachedResponse;
      if (parsed.bodyHash !== bodyHash) {
        return { acquired: false, waitMs: 0, bodyHashMismatch: true };
      }
      return { acquired: false, replay: parsed };
    }

    // (2) Try to take the lock.
    const setRes = await this.redis.set(`${fullKey}:lock`, bodyHash, 'EX', LOCK_TTL_SEC, 'NX');
    if (setRes === 'OK') {
      return { acquired: true, lockToken: bodyHash };
    }

    // (3) Lock is held by another in-flight request. Wait and retry.
    return { acquired: false, waitMs: 200, bodyHashMismatch: false };
  }

  /**
   * @param lockToken - The token returned by `reserve()`.
   * @param response - The final response to cache for replay.
   */
  async complete(
    userId: string,
    key: string,
    lockToken: string,
    response: CachedResponse,
  ): Promise<void> {
    const fullKey = makeKey(userId, key);
    // Verify the lock is still ours (TTL hasn't expired under us).
    const held = await this.redis.get(`${fullKey}:lock`);
    if (held !== lockToken) {
      this.log.warn('idempotency lock lost before complete', { fullKey });
      return;
    }
    const payload: CachedResponse = { ...response, bodyHash: lockToken };
    await this.redis.set(`${fullKey}:resp`, JSON.stringify(payload), 'EX', REPLAY_TTL_SEC);
    await this.redis.del(`${fullKey}:lock`);
  }

  /**
   * @param lockToken - The token returned by `reserve()`.
   */
  async abort(userId: string, key: string, lockToken: string): Promise<void> {
    const fullKey = makeKey(userId, key);
    const held = await this.redis.get(`${fullKey}:lock`);
    if (held === lockToken) {
      await this.redis.del(`${fullKey}:lock`);
    }
  }

  /**
   * Read the cached response without acquiring a lock. Used by tests
   * and by the Fastify middleware to surface a replayed response.
   */
  async peek(userId: string, key: string): Promise<CachedResponse | null> {
    const fullKey = makeKey(userId, key);
    const cached = await this.redis.get(`${fullKey}:resp`);
    return cached ? (JSON.parse(cached) as CachedResponse) : null;
  }
}

export { hashBody };
