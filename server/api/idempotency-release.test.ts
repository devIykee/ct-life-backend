/**
 * A key whose request failed must not stay locked: after a 4xx the same key
 * retries at once (no 409 IN_FLIGHT); a 2xx still replays; a crash mid-request
 * releases the lock when its TTL runs out.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { buildContext } from '../application/context.js';

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;
const db = createDb();

beforeAll(async () => {
  process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.LOG_LEVEL = 'warn';
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}, 30_000);
afterAll(async () => {
  await stop();
}, 30_000);

async function devAuth(): Promise<{ sub: string; token: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `idem-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, token: b.accessToken };
}
const post = (token: string, url: string, key: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
    payload: payload as Record<string, unknown>,
  });

describe('idempotency key release', () => {
  it('a 400 releases the key: the same key retries at once and gets the same 400, never 409', async () => {
    const u = await devAuth();
    const key = uuidv7();
    const url = '/v1/events/breakpoint-2026/progress';
    const body = { step: 'trivia', proof: { id: 'bp26.q_city', answer: 'a' } };
    const first = await post(u.token, url, key, body);
    expect(first.statusCode).toBeGreaterThanOrEqual(400); // not live yet, or step locked: a failed request
    const again = await post(u.token, url, key, body);
    expect(again.json().error.code).toBe(first.json().error.code);
    expect(again.json().error.code).not.toBe('IN_FLIGHT');

    const bad = { step: 'trivia', proof: { id: '' } };
    const k2 = uuidv7();
    const r1 = await post(u.token, url, k2, bad);
    expect(r1.statusCode).toBe(400);
    for (let i = 0; i < 3; i++) {
      const r = await post(u.token, url, k2, bad);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('a 2xx is still replayed from the cache', async () => {
    const u = await devAuth();
    const key = uuidv7();
    const url = '/v1/auth/dev';
    const body = { wallet: Keypair.generate().publicKey.toBase58() };
    const a = await app.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': key },
      payload: body,
    });
    const b = await app.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': key },
      payload: body,
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    void u;
  });

  it('a crash mid-request leaves the lock only until its TTL', async () => {
    const ctx = buildContext();
    const user = uuidv7();
    const key = uuidv7();
    const first = await ctx.idempotency.reserve(user, key, 'h1');
    expect(first.acquired).toBe(true); // ...and the process dies: no complete, no abort
    const during = await ctx.idempotency.reserve(user, key, 'h1');
    expect(during).toMatchObject({ acquired: false, waitMs: 200 });
    // The real lock lives 30 s; shorten it to simulate that time passing.
    await ctx.redis.main.pexpire(`idem:${user}:${key}:lock`, 50);
    await new Promise((r) => setTimeout(r, 120));
    const after = await ctx.idempotency.reserve(user, key, 'h1');
    expect(after.acquired).toBe(true);
    expect(await ctx.idempotency.peek(user, key)).toBeNull();
    await ctx.idempotency.abort(user, key, 'h1');
    void db;
  });

  it('abort only releases the lock it holds', async () => {
    const ctx = buildContext();
    const user = uuidv7();
    const key = uuidv7();
    await ctx.idempotency.reserve(user, key, 'mine');
    await ctx.idempotency.abort(user, key, 'someone-else');
    expect(await ctx.idempotency.reserve(user, key, 'mine')).toMatchObject({ acquired: false });
    await ctx.idempotency.abort(user, key, 'mine');
    expect((await ctx.idempotency.reserve(user, key, 'mine')).acquired).toBe(true);
    await ctx.idempotency.abort(user, key, 'mine');
  });
});
