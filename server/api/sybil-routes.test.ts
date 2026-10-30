/**
 * Sybil jail over HTTP (unlock A5): bail and the Barn answer 503
 * CAPABILITY_OFF while off; with sybilBail on, spamming POST /airdrop/claim
 * (fresh Idempotency-Keys) ends in 403 SYBIL_JAILED by the 20th attempt (the
 * top tier rolls at 100%), GET /me/sybil-status shows the stay, the Barn lists
 * it, bail is 402 without Cash, 200 (jailed false) with it, then 409
 * not_jailed. Rules and pricing are covered in
 * server/application/sybil-jail.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const savedCaps = process.env.CAPABILITIES_ON;
let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;
let stop: (() => Promise<void>) | null = null;

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

async function call(
  token: string,
  method: 'GET' | 'POST',
  url: string,
): Promise<{ status: number; body: any }> {
  const r = await app!.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'idempotency-key': uuidv7() } : {}),
    },
  });
  return { status: r.statusCode, body: r.json() };
}

afterAll(async () => {
  if (stop) await stop();
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
}, 30_000);

describe('sybil routes', () => {
  it('bail and the Barn are 503 while off; status is not jailed', async () => {
    await boot('');
    const u = await devUser();
    const bail = await call(u.token, 'POST', '/v1/me/sybil-status/bail');
    expect(bail.status).toBe(503);
    expect(bail.body.error.details).toEqual({ capability: 'sybilBail' });
    const barn = await call(u.token, 'GET', '/v1/sybil-barn');
    expect(barn.status).toBe(503);
    expect(barn.body.error.details).toEqual({ capability: 'sybilBarn' });
    const s = await call(u.token, 'GET', '/v1/me/sybil-status');
    expect(s.body).toEqual({
      jailed: false,
      jailedAt: null,
      releaseAt: null,
      reasonId: null,
      bailCents: null,
      bailable: false,
      source: null,
    });
  }, 30_000);

  it('claim spam -> SYBIL_JAILED, status, Barn, bail', async () => {
    await boot('sybilBail,sybilBarn');
    const u = await devUser();
    let jailed: { status: number; body: any } | null = null;
    for (let i = 0; i < 20 && !jailed; i++) {
      const r = await call(u.token, 'POST', '/v1/airdrop/claim');
      if (r.status === 403) jailed = r;
      else expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    expect(jailed?.body.error.code).toBe('SYBIL_JAILED');
    expect(typeof jailed?.body.error.details.releaseAt).toBe('string');

    const s = await call(u.token, 'GET', '/v1/me/sybil-status');
    expect(s.body).toMatchObject({ jailed: true, bailable: true, source: 'game' });
    expect(s.body.bailCents).toBeGreaterThan(0);

    const barn = await call(u.token, 'GET', '/v1/sybil-barn');
    expect(barn.status).toBe(200);
    expect(barn.body.count).toBeGreaterThanOrEqual(1);
    expect(barn.body.nextCursor).toBeNull();
    // Dev-auth players have no character, so they are counted, not listed by alias.
    expect(Array.isArray(barn.body.inmates)).toBe(true);

    await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [u.id]);
    const broke = await call(u.token, 'POST', '/v1/me/sybil-status/bail');
    expect(broke.status).toBe(402);
    expect(broke.body.error.code).toBe('INSUFFICIENT_CASH');
    expect(Number(broke.body.error.details.need)).toBe(s.body.bailCents);

    await pool.query(`UPDATE balances SET cash_cents = 1000000 WHERE user_id = $1`, [u.id]);
    const ok = await call(u.token, 'POST', '/v1/me/sybil-status/bail');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ jailed: false, bailable: false });
    const again = await call(u.token, 'POST', '/v1/me/sybil-status/bail');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'CONFLICT', details: { reason: 'not_jailed' } });
  }, 60_000);
});
