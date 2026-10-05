/**
 * Redis client.
 *
 * Thin wrapper around ioredis. Two clients are exposed: `main` for
 * everything, and `subscriber` for Pub/Sub (a connection in subscribe
 * mode cannot issue regular commands). `close()` shuts them both down.
 *
 * Redis is the only place we keep ephemeral state (rate-limit tokens,
 * idempotency cache, board cache). Money never touches Redis.
 */
import { Redis } from 'ioredis';
import { loadConfig } from '../config/config.js';

export interface RedisLayer {
  readonly main: Redis;
  readonly subscriber: Redis;
  /** Quit both clients. Idempotent. */
  close(): Promise<void>;
}

let cached: RedisLayer | null = null;

/**
 * Build the process-wide Redis layer. Two clients: `main` for
 * commands, `subscriber` for pub/sub. Memoised; the second call
 * returns the same instance.
 */
export function createRedis(overrides: { url?: string } = {}): RedisLayer {
  if (cached !== null) return cached;
  const cfg = loadConfig();
  const url = overrides.url ?? cfg.redisUrl;
  const main = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  const subscriber = new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
  cached = {
    main,
    subscriber,
    async close() {
      await Promise.allSettled([main.quit(), subscriber.quit()]);
      cached = null;
    },
  };
  return cached;
}

/** Test-only: drop the cached layer so a test can re-init with overrides. */
export function _resetRedisForTests(): void {
  cached = null;
}
