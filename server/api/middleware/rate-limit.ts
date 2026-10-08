/**
 * F12: Rate limit middleware for all write operations.
 *
 * Applied to POST/PUT/PATCH/DELETE routes. Uses token bucket
 * rate limiter with per-user tracking in Redis.
 *
 * Default: 20 req/s per user (configurable via config.rateLimits.restPerUserPerSec).
 * Returns 429 RATE_LIMITED with Retry-After header when exceeded.
 */
import type { preHandlerHookHandler } from 'fastify';
import { RateLimitedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';

const CAPACITY = 100; // Bucket capacity (burst allowance)

/**
 * Rate limit preHandler for write operations.
 * Applies per-user token bucket rate limiting.
 */
export function rateLimitPreHandler(): preHandlerHookHandler {
  return async (req, reply) => {
    const method = req.method.toUpperCase();
    // Only rate limit write operations
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      return;
    }

    const userId = req.user?.sub ?? 'anon';
    const refillPerSec = req.ctx.config.rateLimits.restPerUserPerSec;
    const key = `rl:writes:${userId}`;

    const decision = await perUserTokenBucket(
      req.ctx.redis.main,
      key,
      CAPACITY,
      refillPerSec,
      1, // Take 1 token per request
    );

    if (!decision.allowed) {
      const retryAfterSec = Math.ceil(decision.retryAfterMs / 1000);
      reply.header('Retry-After', String(retryAfterSec));
      throw new RateLimitedError(decision.retryAfterMs, {
        limit: refillPerSec,
      });
    }
  };
}

/**
 * Convenience: return the preHandler directly for use in route arrays.
 */
export function withRateLimit(): preHandlerHookHandler {
  return rateLimitPreHandler();
}
