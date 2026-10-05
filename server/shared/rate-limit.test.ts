/**
 * Rate limit test.
 *
 * Hits the real local Redis. The token-bucket algorithm is
 * deterministic enough that we can assert "first N calls are
 * allowed, the (N+1)th is blocked with a positive retryAfterMs".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { _resetConfigForTests } from './config/config.js';
import { createRedis, _resetRedisForTests } from './redis/client.js';
import { GlobalLoginSemaphore, perIpLoginLimiter, perUserTokenBucket } from './infra/rate-limit.js';

loadDotenv({ path: process.cwd() + '/.env' });

beforeAll(() => {
  _resetConfigForTests();
  _resetRedisForTests();
});

afterAll(async () => {
  await createRedis().close();
});

describe('rate limits', () => {
  it('per-user token bucket allows N then blocks the (N+1)th', async () => {
    const r = createRedis();
    const key = `rl:test:${Date.now()}:${Math.random()}`;
    // Capacity 3, refill 0.1/s. We want 3 calls to succeed and the
    // 4th to be blocked.
    for (let i = 0; i < 3; i++) {
      const d = await perUserTokenBucket(r.main, key, 3, 0.1, 1);
      expect(d.allowed).toBe(true);
    }
    const blocked = await perUserTokenBucket(r.main, key, 3, 0.1, 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it('per-IP login limiter counts and blocks above the cap', async () => {
    const r = createRedis();
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    const cap = 3;
    for (let i = 0; i < cap; i++) {
      const d = await perIpLoginLimiter(r.main, ip, cap);
      expect(d.allowed).toBe(true);
    }
    const blocked = await perIpLoginLimiter(r.main, ip, cap);
    expect(blocked.allowed).toBe(false);
  });

  it('global login semaphore acquires and releases', async () => {
    const r = createRedis();
    const sem = new GlobalLoginSemaphore(r.main, 5);
    const a = await sem.tryAcquire();
    expect(a.acquired).toBe(true);
    await sem.release();
    const b = await sem.tryAcquire();
    expect(b.acquired).toBe(true);
    await sem.release();
  });
});
