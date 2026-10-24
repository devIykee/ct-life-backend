import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { buildContext } from '../application/context.js';

const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=
-----END PUBLIC KEY-----`;

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;
const db = createDb();

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-05T12:00:00Z') });
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
  vi.useRealTimers();
  await stop();
}, 30_000);

interface AuthedUser {
  sub: string;
  accessToken: string;
}

async function devAuth(): Promise<AuthedUser> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `season-nods-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { id: string; accessToken: string };
  return { sub: body.id, accessToken: body.accessToken };
}

async function call(
  u: AuthedUser,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.accessToken}`,
      ...(method === 'GET' ? {} : { 'idempotency-key': key ?? uuidv7() }),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() };
}

import { encodePos, POS_HASH } from '../realtime/movement.js';
import { nodsFile } from '../application/nods.js';

/** A fixed moment inside season s1_airdrop_season (2026-10-19 .. 2026-12-14). */
const NOW = new Date('2026-11-05T12:00:00Z');
const IN_SEASON = '2026-11-01T00:00:00Z';

const errCode = (b: Record<string, unknown>): string => (b.error as { code: string }).code;

async function giveXp(u: AuthedUser, amount: number, source = 'quest'): Promise<void> {
  await db.withConnection((c) =>
    c.query(
      `INSERT INTO season_xp (user_id, amount, source, ref, season_iso, created_at)
       VALUES ($1, $2, $3, $4, '2026-W44', $5)`,
      [u.sub, amount, source, `test:${uuidv7()}`, IN_SEASON],
    ),
  );
}

async function givePass(u: AuthedUser, expiresAt: string): Promise<void> {
  await db.withConnection((c) =>
    c.query(
      `INSERT INTO season_pass (pass_id, user_id, tier, started_at, expires_at, price_paid_cents)
       VALUES ($1, $2, 'season', '2026-10-20T00:00:00Z', $3, 500)`,
      [uuidv7(), u.sub, expiresAt],
    ),
  );
}

async function cash(u: AuthedUser): Promise<number> {
  const r = await db.withConnection((c) =>
    c.query<{ cash_cents: string }>(`SELECT cash_cents FROM balances WHERE user_id = $1`, [u.sub]),
  );
  return Number(r.rows[0]?.cash_cents ?? 0);
}

async function ledgerCount(u: AuthedUser, reason: string): Promise<number> {
  const r = await db.withConnection((c) =>
    c.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id = $1 AND reason = $2`,
      [u.sub, reason],
    ),
  );
  return Number(r.rows[0]!.n);
}

/** The server's own last position for a player, as the street room writes it. */
async function standAt(u: AuthedUser, x: number, z: number, at = NOW.getTime()): Promise<void> {
  await buildContext().redis.main.hset(POS_HASH, u.sub, encodePos({ x, z, at }));
}

const nods = nodsFile().nods;
const nod = nods[0]!;
const proofAt = (n: { nodId: string; x: number; z: number }, dx = 0) => ({
  proof: { nodId: n.nodId, x: n.x + dx, z: n.z },
});
const collect = (u: AuthedUser, n: { nodId: string; x: number; z: number }, dx = 0) =>
  call(u, 'POST', `/v1/nods/${n.nodId}/collect`, proofAt(n, dx));

describe('Season tracks', () => {
  it('needs auth, and shows the season with every tier locked at 0 XP', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/season' });
    expect(anon.statusCode).toBe(401);
    const u = await devAuth();
    const r = await call(u, 'GET', '/v1/season');
    expect(r.status).toBe(200);
    const b = r.body as {
      season: { seasonId: string; xpPerTier: number };
      xp: number;
      tier: number;
      xpToNext: number;
      hasPass: boolean;
      tracks: Record<'free' | 'paid', { tier: number; status: string; xpRequired: number }[]>;
    };
    expect(b.season.seasonId).toBe('s1_airdrop_season');
    expect(b.xp).toBe(0);
    expect(b.tier).toBe(0);
    expect(b.xpToNext).toBe(250);
    expect(b.hasPass).toBe(false);
    expect(b.tracks.free.length).toBeGreaterThanOrEqual(10);
    expect(b.tracks.paid.length).toBeGreaterThanOrEqual(10);
    expect(b.tracks.free.every((t) => t.status === 'locked')).toBe(true);
    expect(b.tracks.free[2]!.xpRequired).toBe(750);
  });

  it('XP thresholds: one XP short is locked, the threshold unlocks the tier', async () => {
    const u = await devAuth();
    await giveXp(u, 249);
    const locked = await call(u, 'POST', '/v1/season/tiers/1/claim?track=free');
    expect(locked.status).toBe(409);
    expect(errCode(locked.body)).toBe('TIER_LOCKED');
    await giveXp(u, 1, 'nod');
    const s = (await call(u, 'GET', '/v1/season')).body as {
      xp: number;
      tier: number;
      tracks: { free: { tier: number; status: string }[] };
    };
    expect(s.xp).toBe(250);
    expect(s.tier).toBe(1);
    expect(s.tracks.free[0]!.status).toBe('claimable');
    expect(s.tracks.free[1]!.status).toBe('locked');
  });

  it('XP outside the season window does not count', async () => {
    const u = await devAuth();
    await db.withConnection((c) =>
      c.query(
        `INSERT INTO season_xp (user_id, amount, source, ref, season_iso, created_at)
         VALUES ($1, 5000, 'quest', 'old', '2026-W01', '2026-01-05T00:00:00Z')`,
        [u.sub],
      ),
    );
    const s = (await call(u, 'GET', '/v1/season')).body as { xp: number };
    expect(s.xp).toBe(0);
  });

  it('free claim pays Cash once, and a replay with another key is idempotent', async () => {
    const u = await devAuth();
    await giveXp(u, 250);
    const first = await call(u, 'POST', '/v1/season/tiers/1/claim?track=free');
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ tier: 1, track: 'free', alreadyClaimed: false });
    expect(first.body.reward).toEqual({ cashCents: 500 });
    expect(await cash(u)).toBe(500);
    const again = await call(u, 'POST', '/v1/season/tiers/1/claim?track=free');
    expect(again.status).toBe(200);
    expect(again.body.alreadyClaimed).toBe(true);
    expect(await cash(u)).toBe(500);
    expect(await ledgerCount(u, 'season_reward')).toBe(1);
    const s = (await call(u, 'GET', '/v1/season')).body as {
      tracks: { free: { status: string }[] };
    };
    expect(s.tracks.free[0]!.status).toBe('claimed');
  });

  it('two claims at once pay once', async () => {
    const u = await devAuth();
    await giveXp(u, 250);
    const rs = await Promise.all([
      call(u, 'POST', '/v1/season/tiers/1/claim?track=free'),
      call(u, 'POST', '/v1/season/tiers/1/claim?track=free'),
      call(u, 'POST', '/v1/season/tiers/1/claim?track=free'),
    ]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.alreadyClaimed === false).length).toBe(1);
    expect(await cash(u)).toBe(500);
  });

  it('paid track: 403 PASS_REQUIRED without a pass (even with the XP), pays with one', async () => {
    const u = await devAuth();
    await giveXp(u, 250);
    const no = await call(u, 'POST', '/v1/season/tiers/1/claim?track=paid');
    expect(no.status).toBe(403);
    expect(errCode(no.body)).toBe('PASS_REQUIRED');
    const view = (await call(u, 'GET', '/v1/season')).body as {
      tracks: { paid: { status: string }[] };
    };
    expect(view.tracks.paid[0]!.status).toBe('pass_required');
    expect(await cash(u)).toBe(0);

    await givePass(u, '2026-12-30T00:00:00Z');
    const ok = await call(u, 'POST', '/v1/season/tiers/1/claim?track=paid');
    expect(ok.status).toBe(200);
    expect(ok.body.reward).toEqual({ cashCents: 1000 });
    expect(await cash(u)).toBe(1000);
  });

  it('an expired pass does not open the paid track', async () => {
    const u = await devAuth();
    await giveXp(u, 250);
    await givePass(u, '2026-10-30T00:00:00Z');
    const r = await call(u, 'POST', '/v1/season/tiers/1/claim?track=paid');
    expect(r.status).toBe(403);
    expect(errCode(r.body)).toBe('PASS_REQUIRED');
  });

  it('cosmetic and furniture rewards land in the inventory and the items', async () => {
    const u = await devAuth();
    await giveXp(u, 1250);
    const cos = await call(u, 'POST', '/v1/season/tiers/3/claim?track=free');
    expect(cos.body.reward).toEqual({ cosmeticId: 'reward_s1_gm_cap' });
    const inv = (await call(u, 'GET', '/v1/inventory')).body as {
      items: { itemKey: string; source: string }[];
    };
    expect(inv.items.map((i) => [i.itemKey, i.source])).toContainEqual([
      'reward_s1_gm_cap',
      'grant',
    ]);
    const fur = await call(u, 'POST', '/v1/season/tiers/5/claim?track=free');
    expect(fur.body.reward).toEqual({ furnitureItemId: 'plant_pothos' });
    const items = (await call(u, 'GET', '/v1/me/items')).body as { items: { itemId: string }[] };
    expect(items.items.map((i) => i.itemId)).toEqual(['plant_pothos']);
    // Reward cosmetics are not for sale.
    const shop = (await call(u, 'GET', '/v1/shop')).body as { items: { itemKey: string }[] };
    expect(shop.items.some((i) => i.itemKey.startsWith('reward_'))).toBe(false);
  });

  it('validates the request and cannot be claimed on someone else’s XP', async () => {
    const a = await devAuth();
    const b = await devAuth();
    await giveXp(a, 3000);
    expect((await call(b, 'POST', '/v1/season/tiers/1/claim')).status).toBe(400);
    expect((await call(b, 'POST', '/v1/season/tiers/1/claim?track=vip')).status).toBe(400);
    expect((await call(b, 'POST', '/v1/season/tiers/0/claim?track=free')).status).toBe(400);
    expect((await call(b, 'POST', '/v1/season/tiers/99/claim?track=free')).status).toBe(404);
    const steal = await call(b, 'POST', '/v1/season/tiers/1/claim?track=free');
    expect(errCode(steal.body)).toBe('TIER_LOCKED');
    expect(await cash(b)).toBe(0);
    await call(a, 'POST', '/v1/season/tiers/1/claim?track=free');
    const bView = (await call(b, 'GET', '/v1/season')).body as {
      tracks: { free: { status: string }[] };
    };
    expect(bView.tracks.free[0]!.status).toBe('locked');
  });
});

describe('Nods collection', () => {
  it('collects a nod inside the radius and awards Season XP once', async () => {
    const u = await devAuth();
    await standAt(u, nod.x + 5, nod.z);
    const r = await collect(u, nod, 5);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ nodId: nod.nodId, alreadyCollected: false, xp: 50 });
    const s = (await call(u, 'GET', '/v1/season')).body as { xp: number };
    expect(s.xp).toBe(50);
  });

  it('refuses a nod outside the radius, by the SERVER position, not the client claim', async () => {
    const u = await devAuth();
    await standAt(u, nod.x + 40, nod.z);
    // The client claims to stand on the nod; the server saw 40 m away.
    const r = await collect(u, nod, 0);
    expect(r.status).toBe(409);
    expect(errCode(r.body)).toBe('NOD_TOO_FAR');
    const book = (await call(u, 'GET', '/v1/nods')).body as { collected: number };
    expect(book.collected).toBe(0);
    // Just inside 15 m works; just outside does not.
    await standAt(u, nod.x + 14.9, nod.z);
    expect((await collect(u, nod, 14.9)).status).toBe(200);
    const other = nods[1]!;
    await standAt(u, other.x + 15.5, other.z);
    expect(errCode((await collect(u, other, 15.5)).body)).toBe('NOD_TOO_FAR');
  });

  it('refuses with POSITION_UNKNOWN when the server has no fresh position', async () => {
    const u = await devAuth();
    const none = await collect(u, nod);
    expect(none.status).toBe(409);
    expect(errCode(none.body)).toBe('POSITION_UNKNOWN');
    await standAt(u, nod.x, nod.z, NOW.getTime() - 31_000);
    expect(errCode((await collect(u, nod)).body)).toBe('POSITION_UNKNOWN');
  });

  it('refuses a client position far from the server one, a wrong proof id, and unknown nods', async () => {
    const u = await devAuth();
    await standAt(u, nod.x, nod.z);
    const mismatch = await collect(u, nod, 100);
    expect(mismatch.status).toBe(400);
    const wrong = await call(u, 'POST', `/v1/nods/${nod.nodId}/collect`, {
      proof: { nodId: nods[1]!.nodId, x: nod.x, z: nod.z },
    });
    expect(wrong.status).toBe(400);
    const unknown = await call(u, 'POST', '/v1/nods/not_a_nod/collect', {
      proof: { nodId: 'not_a_nod', x: 0, z: 0 },
    });
    expect(unknown.status).toBe(404);
    const noBody = await call(u, 'POST', `/v1/nods/${nod.nodId}/collect`, {});
    expect(noBody.status).toBe(400);
  });

  it('a double collect is idempotent: no second XP, no position needed', async () => {
    const u = await devAuth();
    await standAt(u, nod.x, nod.z);
    const first = await collect(u, nod);
    expect(first.body.alreadyCollected).toBe(false);
    await buildContext().redis.main.hdel(POS_HASH, u.sub);
    const again = await collect(u, nod);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ alreadyCollected: true, xp: 0 });
    const s = (await call(u, 'GET', '/v1/season')).body as { xp: number };
    expect(s.xp).toBe(50);
    const book = (await call(u, 'GET', '/v1/nods')).body as { collected: number };
    expect(book.collected).toBe(1);
  });

  it('a filled set grants its cosmetic once, and nothing earlier', async () => {
    const u = await devAuth();
    const setId = 'event_hall';
    const members = nods.filter((n) => n.setId === setId);
    expect(members.length).toBeGreaterThanOrEqual(3);
    const reward = nodsFile().sets.find((s) => s.setId === setId)!.reward.cosmeticId;
    for (const [i, n] of members.entries()) {
      await standAt(u, n.x, n.z);
      const r = await collect(u, n);
      expect(r.status).toBe(200);
      const last = i === members.length - 1;
      expect((r.body.setReward as unknown) === null).toBe(!last);
      if (last) expect(r.body.setReward).toEqual({ setId, cosmeticId: reward });
    }
    const inv = (await call(u, 'GET', '/v1/inventory')).body as { items: { itemKey: string }[] };
    expect(inv.items.filter((i) => i.itemKey === reward).length).toBe(1);
    // Collecting again (or a replay) never grants a second time.
    const last = members[members.length - 1]!;
    const replay = await collect(u, last);
    expect(replay.body).toMatchObject({ alreadyCollected: true, setReward: null });
    const grants = await db.withConnection((c) =>
      c.query(`SELECT 1 FROM nod_set_grants WHERE user_id = $1`, [u.sub]),
    );
    expect(grants.rowCount).toBe(1);
    const book = (await call(u, 'GET', '/v1/nods')).body as {
      sets: { setId: string; completed: boolean; rewardGranted: boolean; nods: object[] }[];
    };
    const mine = book.sets.find((s) => s.setId === setId)!;
    expect(mine).toMatchObject({ completed: true, rewardGranted: true });
    // The book never leaks world positions.
    expect(JSON.stringify(book)).not.toContain('"x"');
  });

  it('rate limits attempts per player, hit or miss', async () => {
    const u = await devAuth();
    await standAt(u, nod.x + 500, nod.z);
    const codes: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await collect(u, nod, 500);
      codes.push(errCode(r.body));
    }
    expect(codes.slice(0, 10).every((c) => c === 'NOD_TOO_FAR')).toBe(true);
    expect(codes.slice(10)).toContain('RATE_LIMITED');
  });

  it('the Hunter board ranks by nods found and shows me', async () => {
    const a = await devAuth();
    const b = await devAuth();
    const c = await devAuth();
    for (const n of [nods[0]!, nods[1]!, nods[2]!]) {
      await standAt(a, n.x, n.z);
      await collect(a, n);
    }
    for (const n of [nods[0]!]) {
      await standAt(b, n.x, n.z);
      await collect(b, n);
    }
    const lb = async (u: AuthedUser) =>
      (await call(u, 'GET', '/v1/nods/leaderboard')).body as {
        total: number;
        top: { rank: number; count: number }[];
        me: { rank: number; count: number; userId: string } | null;
      };
    const la = await lb(a);
    const lbb = await lb(b);
    const lc = await lb(c);
    expect(la.me).toMatchObject({ count: 3, userId: a.sub });
    expect(lbb.me).toMatchObject({ count: 1, userId: b.sub });
    expect(la.me!.rank).toBeLessThan(lbb.me!.rank);
    expect(lc.me).toBeNull();
    expect(la.total).toBe(nods.length);
    const counts = la.top.map((r) => r.count);
    expect(counts).toEqual([...counts].sort((x, y) => y - x));
  });

  it('needs auth', async () => {
    for (const [m, u] of [
      ['GET', '/v1/nods'],
      ['GET', '/v1/nods/leaderboard'],
    ] as const) {
      expect((await app.inject({ method: m, url: u })).statusCode).toBe(401);
    }
  });
});
