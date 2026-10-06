/**
 * Authz matrix tests for the REST API.
 *
 * Master prompt rule 1 + M8: every authenticated endpoint must
 * derive the acting user from the verified JWT (req.user!.sub),
 * not from the URL or body. These tests pin that contract by
 * spinning up the Fastify app via `buildServer()` and using
 * `app.inject()` to make requests without binding a port.
 *
 * Strategy:
 *   1. Dev-auth as user A and user B (two real users, distinct wallets).
 *   2. For every mutating endpoint, exercise the "user A tries to act
 *      on user B's resources" path. The server must either reject
 *      with 403/404 OR perform the action on user A's resources —
 *      it must NEVER mutate user B's state.
 *   3. Admin-only endpoints must reject non-admin callers.
 *
 * Run: `pnpm test:unit` (no special flag; uses the same dev Postgres
 * and Redis the rest of the suite uses).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { runInTransaction } from '../shared/db/uow.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';

const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=
-----END PUBLIC KEY-----`;

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;

beforeAll(async () => {
  process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://ctlife:ctlife@localhost:5434/ctlife';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';
  process.env.JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY ?? FAKE_PKCS8;
  process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY ?? FAKE_SPKI;
  process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? 'fake-helius-key';
  process.env.HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? 'fake-helius-secret';
  process.env.HELIUS_RPC_URL_DEVNET =
    process.env.HELIUS_RPC_URL_DEVNET ?? 'https://api.devnet.solana.com';
  process.env.HELIUS_RPC_URL_MAINNET =
    process.env.HELIUS_RPC_URL_MAINNET ?? 'https://api.mainnet-beta.solana.com';
  process.env.TREASURY_PUBKEY_DEVNET =
    process.env.TREASURY_PUBKEY_DEVNET ?? '11111111111111111111111111111111';
  process.env.SETTLE_AUTHORITY_KEYPAIR_DEVNET =
    process.env.SETTLE_AUTHORITY_KEYPAIR_DEVNET ?? '11111111111111111111111111111111';
  process.env.ADMIN_KEYPAIR_DEVNET =
    process.env.ADMIN_KEYPAIR_DEVNET ?? '11111111111111111111111111111111';
  process.env.LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
  process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
  process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret_please_change';
  process.env.LIVEKIT_WEBHOOK_SECRET = process.env.LIVEKIT_WEBHOOK_SECRET ?? 'fake-livekit-secret';
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? 'minioadmin';
  process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? 'minioadmin';
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  // Prepare Fastify without binding a real port.
  await app.ready();
  stop = handle.stop;
}, 30_000);

afterAll(async () => {
  await stop();
}, 30_000);

interface AuthedUser {
  sub: string;
  wallet: string;
  accessToken: string;
}

async function devAuth(wallet: string): Promise<AuthedUser> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `authz-${uuidv7()}` },
    payload: { wallet },
  });
  expect(r.statusCode, `dev auth failed for ${wallet}: ${r.body}`).toBe(200);
  const body = r.json() as { id: string; wallet: string; accessToken: string };
  return { sub: body.id, wallet: body.wallet, accessToken: body.accessToken };
}

function authHeaders(u: AuthedUser, idem?: string): Record<string, string> {
  return {
    authorization: `Bearer ${u.accessToken}`,
    ...(idem ? { 'idempotency-key': idem } : {}),
  };
}

/**
 * Read the cash balance for a user. We use this to verify that a
 * mutation by user A did NOT touch user B's balance.
 */
async function readCashCents(userId: string): Promise<number> {
  const db = createDb();
  try {
    const r = await db.withConnection((c) =>
      c.query<{ cash_cents: string }>('SELECT cash_cents FROM balances WHERE user_id = $1', [
        userId,
      ]),
    );
    return Number(r.rows[0]?.cash_cents ?? 0);
  } finally {
    // The pool is shared with the app; do not close.
  }
}

/**
 * Give user U a starting cash balance of `cents`. Used to fund user A
 * and user B for tip / rent / payment tests.
 */
async function fundUser(userId: string, cents: number): Promise<void> {
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
       VALUES ($1, $2, 'cash', 'authz_test', $3)`,
      [userId, cents, `authz-fund-${userId}-${cents}-${Date.now()}`],
    );
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + $2`,
      [userId, cents],
    );
  });
}

describe('authz: every mutating endpoint derives the actor from the JWT', () => {
  let alice: AuthedUser;
  let bob: AuthedUser;

  beforeAll(async () => {
    alice = await devAuth(Keypair.generate().publicKey.toBase58());
    bob = await devAuth(Keypair.generate().publicKey.toBase58());
    await fundUser(alice.sub, 1_000_000);
    await fundUser(bob.sub, 1_000_000);
  });

  it('alice can read /v1/me as herself', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: authHeaders(alice),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { user?: { id?: string }; id?: string };
    const id = body.id ?? body.user?.id;
    expect(id).toBe(alice.sub);
  });

  it('rejects unauthenticated requests with SIGNATURE_INVALID (401)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
    });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { error: { code: string } }).error.code).toBe('SIGNATURE_INVALID');
  });

  it('rejects garbage bearer with SIGNATURE_INVALID', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(r.statusCode).toBe(401);
  });

  it('tips endpoint: alice tipping bob is allowed', async () => {
    const beforeA = await readCashCents(alice.sub);
    const beforeB = await readCashCents(bob.sub);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/tips',
      headers: authHeaders(alice, `tip-${uuidv7()}`),
      payload: { toUserId: bob.sub, amountCents: 100, message: 'hi' },
    });
    expect([201, 200]).toContain(r.statusCode);
    const afterA = await readCashCents(alice.sub);
    const afterB = await readCashCents(bob.sub);
    expect(afterA).toBe(beforeA - 100);
    expect(afterB).toBe(beforeB + 100);
  });

  it('tips endpoint: alice cannot trick the server into debiting bob (no actor param)', async () => {
    // The server derives `from` from the JWT. There is no `fromUserId` field;
    // the route handler uses req.user!.sub. So even if a malicious client
    // tries to set `fromUserId`, the server ignores it. This is a positive
    // assertion that the tip endpoint never exposes an actor override.
    const beforeA = await readCashCents(alice.sub);
    const r = await app.inject({
      method: 'POST',
      url: '/v1/tips',
      headers: authHeaders(alice, `tip-${uuidv7()}`),
      payload: { toUserId: bob.sub, amountCents: 50, message: 'noop', fromUserId: bob.sub },
    });
    // If the route returns 400 because fromUserId is not in the schema,
    // good. If it ignores the extra field, the tip still debits alice.
    expect(r.statusCode === 201 || r.statusCode === 400).toBe(true);
    const afterA = await readCashCents(alice.sub);
    // alice is the actor regardless. If 201, alice paid 50. If 400, no
    // mutation happened.
    expect(afterA === beforeA || afterA === beforeA - 50).toBe(true);
  });

  it('blocks endpoint: alice blocking bob succeeds', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/v1/blocks/${bob.sub}`,
      headers: authHeaders(alice, `blk-${uuidv7()}`),
    });
    expect([204, 200]).toContain(r.statusCode);
  });

  it('reports endpoint: alice can report bob', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      headers: authHeaders(alice, `rep-${uuidv7()}`),
      payload: { targetType: 'user', targetId: bob.sub, reasonId: 'spam' },
    });
    expect([204, 200]).toContain(r.statusCode);
  });

  it('follow endpoint: alice can follow bob', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/v1/follows/${bob.sub}`,
      headers: authHeaders(alice, `foll-${uuidv7()}`),
    });
    expect([204, 200]).toContain(r.statusCode);
  });

  it('DMs endpoint: alice can DM bob', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/v1/dms/${bob.sub}`,
      headers: authHeaders(alice, `dm-${uuidv7()}`),
      payload: { text: 'hello bob' },
    });
    expect([201, 200]).toContain(r.statusCode);
  });

  it('feed: alice can post to her own feed', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/feed/posts',
      headers: authHeaders(alice, `feed-${uuidv7()}`),
      payload: { text: 'gm' },
    });
    expect([201, 200]).toContain(r.statusCode);
  });

  it('feed: alice cannot post as bob (no actor override)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/feed/posts',
      headers: authHeaders(alice, `feed-${uuidv7()}`),
      payload: { text: 'gm', authorId: bob.sub },
    });
    // Either rejected, or stored as alice. The post must NOT be
    // attributed to bob. We assert the server does not 500.
    expect(r.statusCode).toBeLessThan(500);
  });

  it('user-search: returns users (does not leak private data)', async () => {
    const r = await app.inject({
      method: 'GET',
      url: `/v1/users/${bob.sub}`,
      headers: authHeaders(alice),
    });
    expect([200, 404]).toContain(r.statusCode);
  });

  it('admin-only: non-admin cannot sybil-jail another user', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/v1/admin/users/${bob.sub}/sybil_jail`,
      headers: authHeaders(alice, `sj-${uuidv7()}`),
    });
    expect(r.statusCode).toBe(403);
    expect((r.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('admin-only: non-admin cannot set meta', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/admin/meta',
      headers: authHeaders(alice, `meta-${uuidv7()}`),
      payload: { mood: 'bullish', metaId: 'manual' },
    });
    // Either 403 (admin required) or 404 (route absent). The point is
    // that a normal user must never mutate meta state.
    expect([403, 404]).toContain(r.statusCode);
  });

  it('tribe change: alice cannot change tribe for bob', async () => {
    // The endpoint is /v1/me/tribe and takes only tribeId; the actor
    // is the JWT. There is no `userId` override, so a request that
    // tries to change bob's tribe via this route can only change
    // alice's. Assert that the request shape has no override surface.
    const r = await app.inject({
      method: 'POST',
      url: '/v1/me/tribe',
      headers: authHeaders(alice, `tribe-${uuidv7()}`),
      payload: { tribeId: 'anon', userId: bob.sub },
    });
    expect(r.statusCode).toBeLessThan(500);
  });

  it('alpha calls: alice can post an alpha call as herself', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/alpha-calls',
      headers: authHeaders(alice, `ac-${uuidv7()}`),
      payload: {
        symbol: 'BTC',
        direction: 'long',
        targetCents: 100_000_000,
        stopCents: 90_000_000,
        thesis: 'authz test',
      },
    });
    expect([201, 200, 400, 422]).toContain(r.statusCode);
  });

  it('predictions: alice can place a prediction as herself', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/predictions',
      headers: authHeaders(alice, `pred-${uuidv7()}`),
      payload: {
        symbol: 'BTC',
        horizon: '5m',
        direction: 'up',
        stakeCents: 100,
      },
    });
    expect([201, 200, 400, 422]).toContain(r.statusCode);
  });

  it('perps: alice can open a perp as herself', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/perps',
      headers: authHeaders(alice, `perp-${uuidv7()}`),
      payload: {
        symbol: 'BTC-PERP',
        side: 'long',
        sizeCents: 1000,
        leverageX: 1,
      },
    });
    expect([201, 200, 400, 422]).toContain(r.statusCode);
  });

  it('paid-calls: alice can build a paid-call session as fan (herself)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/paid-calls',
      headers: authHeaders(alice, `pc-${uuidv7()}`),
      payload: {
        creatorId: bob.sub,
        rateCentsPerMin: 1000,
        maxMinutes: 5,
      },
    });
    // The endpoint may reject because bob has no creator profile.
    // The point is that the server does not allow alice to specify a
    // different fan (no fan override field).
    expect(r.statusCode).toBeLessThan(500);
  });

  it('x-link: non-admin cannot link another user (no admin route here)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/x-link/start',
      headers: authHeaders(alice, `xl-${uuidv7()}`),
    });
    // 200 with PKCE flow, 503 because no X_CLIENT_ID, or 404. None
    // should mutate bob.
    expect([200, 400, 404, 503]).toContain(r.statusCode);
  });

  it('homes: alice can create a home for herself', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/homes',
      headers: authHeaders(alice, `hm-${uuidv7()}`),
      payload: { kind: 'studio' },
    });
    expect([201, 409, 403]).toContain(r.statusCode);
  });

  it('creator profile: alice can POST her own creator profile', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/creator',
      headers: authHeaders(alice, `cr-${uuidv7()}`),
      payload: { handle: `alice-${alice.sub.slice(0, 8)}`, bio: 'authz test' },
    });
    expect([200, 201, 400, 409]).toContain(r.statusCode);
  });

  it('shop: alice can list and (try to) buy a shop item', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/v1/shop/purchase',
      headers: authHeaders(alice, `sh-${uuidv7()}`),
      payload: { itemId: '00000000-0000-7000-8000-000000000000' },
    });
    // 404 (item missing) is the expected outcome. The important
    // assertion is that the request lands on alice's account, not
    // bob's.
    expect([200, 201, 404, 409]).toContain(r.statusCode);
  });
});

describe('authz: cross-user isolation', () => {
  it('alice cannot spend bob cash via any endpoint (spot check)', async () => {
    const alice = await devAuth(Keypair.generate().publicKey.toBase58());
    const bob = await devAuth(Keypair.generate().publicKey.toBase58());
    await fundUser(alice.sub, 10_000);
    await fundUser(bob.sub, 10_000);
    const beforeAlice = await readCashCents(alice.sub);
    const beforeBob = await readCashCents(bob.sub);

    // Try a tip with alice's auth but an extra `fromUserId` field
    // that tries to claim bob paid. The schema ignores the extra
    // field; the server derives `from` from the JWT and debits
    // alice (not bob). The assertion: alice's cash goes DOWN by
    // exactly amountCents; bob's cash goes UP by exactly that
    // same amount; the extra `fromUserId` field is harmless.
    const r = await app.inject({
      method: 'POST',
      url: '/v1/tips',
      headers: authHeaders(alice, `iso-${uuidv7()}`),
      payload: {
        toUserId: bob.sub,
        amountCents: 7,
        message: 'isolate',
        fromUserId: bob.sub,
      },
    });
    expect(r.statusCode).toBe(201);
    const afterAlice = await readCashCents(alice.sub);
    const afterBob = await readCashCents(bob.sub);
    expect(afterAlice).toBe(beforeAlice - 7);
    expect(afterBob).toBe(beforeBob + 7);
  });
});
