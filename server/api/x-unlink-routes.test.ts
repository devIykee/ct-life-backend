/**
 * DELETE /v1/x/link (unlock A4): 503 CAPABILITY_OFF while `xUnlink` is off,
 * 401 without a token, 404 when nothing is linked (an in-flight start is still
 * cleared), and on success 204, the row with its handle and token hashes is
 * gone, GET /x/link answers {link: null}, and the user gets
 * `x_link_update {linked: false}`. Works with X_LINK_ENABLED off.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests, buildContext } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { subscribeUserMessages, type UserMessage } from '../application/realtime-bus.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const savedCaps = process.env.CAPABILITIES_ON;
let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;
let stop: (() => Promise<void>) | null = null;
let sub: Redis | null = null;
const received: UserMessage[] = [];
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

async function boot(caps: string): Promise<void> {
  if (stop) await stop();
  process.env.CAPABILITIES_ON = caps;
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

async function devUser(): Promise<{ id: string; token: string }> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `wpa-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { id: b.id, token: b.accessToken };
}

async function link(userId: string, verified: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO x_links (user_id, x_user_id, x_handle, x_avatar_url, code_verifier, state,
                          access_token_hash, refresh_token_hash, verified_at)
     VALUES ($1, $2, 'wpa_handle', 'https://pbs.twimg.com/a.png', $3, $4, 'hashA', 'hashR', $5)`,
    [
      userId,
      `x-${uuidv7()}`,
      'v'.repeat(43),
      `state-${uuidv7()}`.slice(0, 40),
      verified ? new Date().toISOString() : null,
    ],
  );
}

async function unlink(
  token: string | null,
): Promise<{ statusCode: number; body: string; json: () => any }> {
  return app!.inject({
    method: 'DELETE',
    url: '/v1/x/link',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'idempotency-key': uuidv7(),
    },
  });
}

beforeAll(async () => {
  sub = subscribeUserMessages(buildContext().redis.main, (m) => {
    if (m.type === 'x_link_update') received.push(m);
  });
  await settle();
});

afterAll(async () => {
  await sub?.quit();
  if (stop) await stop();
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
}, 30_000);

describe('DELETE /v1/x/link', () => {
  it('answers 503 CAPABILITY_OFF while xUnlink is off and keeps the link', async () => {
    await boot('');
    const u = await devUser();
    await link(u.id, true);
    const r = await unlink(u.token);
    expect(r.statusCode).toBe(503);
    expect(r.json().error.details).toEqual({ capability: 'xUnlink' });
    const left = await pool.query(`SELECT 1 FROM x_links WHERE user_id = $1`, [u.id]);
    expect(left.rowCount).toBe(1);
    await pool.query(`DELETE FROM x_links WHERE user_id = $1`, [u.id]);
  }, 30_000);

  it('deletes the link and its token hashes, then 404s', async () => {
    await boot('xUnlink');
    expect((await unlink(null)).statusCode).toBe(401);
    const u = await devUser();
    await link(u.id, true);
    received.length = 0;
    const r = await unlink(u.token);
    expect(r.statusCode, r.body).toBe(204);
    expect(r.body).toBe('');
    const left = await pool.query(`SELECT 1 FROM x_links WHERE user_id = $1`, [u.id]);
    expect(left.rowCount).toBe(0);
    const status = await app!.inject({
      method: 'GET',
      url: '/v1/x/link',
      headers: { authorization: `Bearer ${u.token}` },
    });
    expect(status.json()).toEqual({ link: null });
    await settle();
    expect(received.filter((m) => m.userId === u.id)).toEqual([
      expect.objectContaining({
        type: 'x_link_update',
        payload: expect.objectContaining({ status: 'unlinked', linked: false }),
      }),
    ]);
    const again = await unlink(u.token);
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe('NOT_FOUND');
  }, 30_000);

  it('404s an unverified start but clears it', async () => {
    await boot('xUnlink');
    const u = await devUser();
    await link(u.id, false);
    expect((await unlink(u.token)).statusCode).toBe(404);
    const left = await pool.query(`SELECT 1 FROM x_links WHERE user_id = $1`, [u.id]);
    expect(left.rowCount).toBe(0);
  }, 30_000);
});
