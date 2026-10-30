/**
 * Cabal invites over HTTP (unlock A3): a targeted invite needs capability
 * `cabalInvites` and revoke needs `cabalRevoke` (503 CAPABILITY_OFF while off;
 * open invites keep working), the host gate (403 NET_WORTH_TOO_LOW), the
 * guest echo the client verifies, 404 for an unknown guest, only the guest can
 * accept, and revoke's 200 / 403 not_host / 409 not_pending. Service rules
 * are covered in server/application/venues-gating.test.ts.
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

interface U {
  id: string;
  token: string;
}

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

async function devUser(cashCents = 0): Promise<U> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `wpa-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  if (cashCents > 0) {
    await pool.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = 0`,
      [b.id, cashCents],
    );
  }
  return { id: b.id, token: b.accessToken };
}

async function call(
  u: U,
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const r = await app!.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.token}`,
      ...(method === 'POST' ? { 'idempotency-key': uuidv7() } : {}),
    },
    ...(payload ? { payload } : {}),
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

const RICH = 10_000_000;

describe('cabal invites', () => {
  it('while off: targeted create and revoke answer 503; an open invite still works', async () => {
    await boot('');
    const host = await devUser(RICH);
    const guest = await devUser();
    const t = await call(host, 'POST', '/v1/cabal/invites', { guestUserId: guest.id });
    expect(t.status).toBe(503);
    expect(t.body.error.details).toEqual({ capability: 'cabalInvites' });
    const open = await call(host, 'POST', '/v1/cabal/invites');
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    expect(open.body.guestUserId).toBeNull();
    const rv = await call(host, 'POST', `/v1/cabal/invites/${open.body.inviteId}/revoke`);
    expect(rv.status).toBe(503);
    expect(rv.body.error.details).toEqual({ capability: 'cabalRevoke' });
  }, 30_000);

  it('targeted invite, guest-only accept, revoke', async () => {
    await boot('cabalInvites,cabalRevoke');
    const poor = await devUser();
    const host = await devUser(RICH);
    const guest = await devUser();
    const stranger = await devUser();

    const low = await call(poor, 'POST', '/v1/cabal/invites', { guestUserId: guest.id });
    expect(low.status).toBe(403);
    expect(low.body.error.code).toBe('NET_WORTH_TOO_LOW');
    expect(low.body.error.details.requiredNetWorthCents).toBe(RICH);

    const missing = await call(host, 'POST', '/v1/cabal/invites', { guestUserId: uuidv7() });
    expect(missing.status).toBe(404);
    const bad = await call(host, 'POST', '/v1/cabal/invites', { guestUserId: 'nope' });
    expect(bad.status).toBe(400);

    const inv = await call(host, 'POST', '/v1/cabal/invites', { guestUserId: guest.id });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body).toMatchObject({
      hostUserId: host.id,
      guestUserId: guest.id,
      status: 'pending',
    });
    expect(typeof inv.body.code).toBe('string');

    // The guest lists it (no code), a stranger cannot accept it.
    const list = await call(guest, 'GET', `/v1/cabal/invites?guestId=${guest.id}`);
    expect(list.body.invites[0]).toMatchObject({ inviteId: inv.body.inviteId, status: 'pending' });
    expect(list.body.invites[0].code).toBeUndefined();
    const steal = await call(stranger, 'POST', `/v1/cabal/invites/${inv.body.inviteId}/accept`);
    expect(steal.status).toBe(403);
    expect(steal.body.error.details.reason).toBe('not_guest');

    // Only the host can revoke; then it is gone for good.
    const notHost = await call(guest, 'POST', `/v1/cabal/invites/${inv.body.inviteId}/revoke`);
    expect(notHost.status).toBe(403);
    expect(notHost.body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'not_host' },
    });
    const rv = await call(host, 'POST', `/v1/cabal/invites/${inv.body.inviteId}/revoke`);
    expect(rv.status).toBe(200);
    expect(rv.body).toMatchObject({ inviteId: inv.body.inviteId, status: 'revoked' });
    const again = await call(host, 'POST', `/v1/cabal/invites/${inv.body.inviteId}/revoke`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'not_pending' },
    });
    const late = await call(guest, 'POST', `/v1/cabal/invites/${inv.body.inviteId}/accept`);
    expect(late.status).toBe(403);
    const unknown = await call(host, 'POST', `/v1/cabal/invites/${uuidv7()}/revoke`);
    expect(unknown.status).toBe(404);
  }, 30_000);
});
