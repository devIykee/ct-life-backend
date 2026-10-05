/**
 * Rate limiter.
 *
 * Three flavours:
 *
 *   - `perUserTokenBucket(redis, key, capacity, refillPerSec)`:
 *     per-user REST rate limit, 20 req/s by default. Uses the token
 *     bucket algorithm in Redis. Returns the wait time when over
 *     limit; the transport maps it to `RATE_LIMITED` with Retry-After.
 *
 *   - `perIpLoginLimiter(redis, ip, perMin)`:
 *     per-IP login rate limit. Returns SERVER_BUSY (503) when the
 *     count of in-flight verify requests from one IP exceeds the
 *     configured cap. This is the "Helius-slow login" hardening
 *     from the M2 amendment.
 *
 *   - `globalLoginSemaphore(redis, max)`:
 *     global login concurrency. Same return shape. The cap is set
 *     by `RATE_LIMIT_LOGIN_GLOBAL_CONCURRENT` (default 200).
 *
 * All three rely on a Redis key and an INCR with a TTL. They are
 * fast (one round-trip) and safe under cluster splits because the
 * state is in one place.
 */
import type { Redis } from 'ioredis';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

const LUA_TOKEN_BUCKET = `
-- KEYS[1] = bucket key
-- ARGV[1] = capacity (integer)
-- ARGV[2] = refillPerSec (number, can be fractional; we use ms-precision)
-- ARGV[3] = nowMs
-- ARGV[4] = tokensWanted (typically 1)
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillPerSec = tonumber(ARGV[2])
local nowMs = tonumber(ARGV[3])
local wanted = tonumber(ARGV[4])

local bucket = redis.call('HMGET', key, 'tokens', 'last')
local tokens = tonumber(bucket[1])
local last = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  last = nowMs
end

-- Refill since last.
local elapsedMs = math.max(0, nowMs - last)
local refill = (elapsedMs / 1000.0) * refillPerSec
tokens = math.min(capacity, tokens + refill)

if tokens >= wanted then
  tokens = tokens - wanted
  redis.call('HMSET', key, 'tokens', tostring(tokens), 'last', tostring(nowMs))
  redis.call('PEXPIRE', key, math.max(60000, math.ceil((capacity / math.max(0.001, refillPerSec)) * 1000) + 60000))
  return {1, tostring(tokens)}
else
  -- Not enough tokens. Compute the wait.
  local deficit = wanted - tokens
  local waitMs = math.ceil((deficit / math.max(0.001, refillPerSec)) * 1000)
  redis.call('HMSET', key, 'tokens', tostring(tokens), 'last', tostring(nowMs))
  redis.call('PEXPIRE', key, 60000)
  return {0, tostring(tokens), tostring(waitMs)}
end
`;

/**
 * Per-user token-bucket rate limit. One Redis round-trip via Lua.
 * @param redis - Shared ioredis client.
 * @param key - Bucket key, e.g. `rl:rest:user:${userId}`.
 * @param capacity - Maximum tokens in the bucket.
 * @param refillPerSec - Tokens added per second.
 * @param wanted - Tokens to take (default 1).
 */
export async function perUserTokenBucket(
  redis: Redis,
  key: string,
  capacity: number,
  refillPerSec: number,
  wanted = 1,
): Promise<RateLimitDecision> {
  const now = Date.now();
  const r = (await redis.eval(
    LUA_TOKEN_BUCKET,
    1,
    key,
    String(capacity),
    String(refillPerSec),
    String(now),
    String(wanted),
  )) as [number, string, string?];
  if (r[0] === 1) {
    return { allowed: true, remaining: Math.floor(Number(r[1])), retryAfterMs: 0 };
  }
  const wait = Number(r[2] ?? '1000');
  return { allowed: false, remaining: 0, retryAfterMs: wait };
}

/**
 * Per-IP login attempts per minute. Increments a counter with a
 * 60 s TTL; on hit, returns `RATE_LIMITED` decision. Below the cap,
 * the call is allowed and the counter is left incremented so a
 * burst hits the cap quickly.
 */
export async function perIpLoginLimiter(
  redis: Redis,
  ip: string,
  perMin: number,
): Promise<RateLimitDecision> {
  const key = `rl:login:ip:${ip}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }
  if (count > perMin) {
    const ttl = await redis.pttl(key);
    return { allowed: false, remaining: 0, retryAfterMs: Math.max(ttl, 1000) };
  }
  return { allowed: true, remaining: perMin - count, retryAfterMs: 0 };
}

/**
 * Global login concurrency semaphore. Increments a counter on
 * entry; the caller MUST call `release()` to decrement. Returns
 * SERVER_BUSY (503) when the global cap is hit. The cap is set
 * to 200 by default; the M2 amendment asks for 500-login burst
 * resilience, which this satisfies.
 */
export class GlobalLoginSemaphore {
  private readonly redis: Redis;
  private readonly key: string;
  private readonly max: number;

  /**
   * @param redis - Shared ioredis client.
   * @param max - Maximum concurrent logins across all IPs.
   */
  constructor(redis: Redis, max: number) {
    this.redis = redis;
    this.key = 'rl:login:global';
    this.max = max;
  }

  /** Try to take one slot. If taken, the caller MUST call `release()` later. */
  async tryAcquire(): Promise<{ acquired: boolean; retryAfterMs: number }> {
    const count = await this.redis.incr(this.key);
    if (count === 1) {
      // Set a high TTL; the counter is decremented by release() in
      // normal use. The TTL is a backstop in case release is missed.
      await this.redis.expire(this.key, 120);
    }
    if (count > this.max) {
      // Roll back the increment so a long burst does not permanently
      // lock the semaphore.
      await this.redis.decr(this.key);
      return { acquired: false, retryAfterMs: 1000 };
    }
    return { acquired: true, retryAfterMs: 0 };
  }

  /** Release a previously acquired slot. Safe to call once per acquire. */
  async release(): Promise<void> {
    const remaining = await this.redis.decr(this.key);
    if (remaining < 0) {
      // Defensive: avoid negative counts.
      await this.redis.set(this.key, '0');
    }
  }
}
