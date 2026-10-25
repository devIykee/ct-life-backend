/**
 * Career progression and origin home, end to end through the routes.
 *
 * Pins the GitHub #4 journeys: shift XP is stored and read back by
 * GET /v1/careers and apply, a replayed Idempotency-Key never awards
 * twice, promotion raises the next shift's pay, and the home a lottery
 * outcome promises is the home the character gets and /v1/me reports.
 *
 * Run: `pnpm test:unit` (uses the dev Postgres and Redis).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _shifts } from '../application/shifts.js';

const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=
-----END PUBLIC KEY-----`;

loadDotenv({ path: process.cwd() + '/.env' });

const lottery = JSON.parse(
  readFileSync(join(process.cwd(), 'contract', 'config', 'lottery.json'), 'utf8'),
) as { outcomes: Record<string, { homeId: string }> };
const homeIds = new Set(
  (
    JSON.parse(readFileSync(join(process.cwd(), 'contract', 'ids', 'homes.json'), 'utf8')) as {
      homes: Array<{ id: string }>;
    }
  ).homes.map((h) => h.id),
);

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;
const db = createDb();

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
  accessToken: string;
}

async function devAuth(): Promise<AuthedUser> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `progression-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const body = r.json() as { id: string; accessToken: string };
  return { sub: body.id, accessToken: body.accessToken };
}

async function call(
  u: AuthedUser,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  idem: string = uuidv7(),
): Promise<{ status: number; body: Record<string, unknown> & unknown[] }> {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.accessToken}`,
      ...(method === 'POST' ? { 'idempotency-key': idem } : {}),
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() };
}

async function sql<T extends Record<string, unknown>>(q: string, args: unknown[]): Promise<T[]> {
  const r = await db.withConnection((c) => c.query<T>(q, args));
  return r.rows;
}

/** Start a discord_mod shift and fast-forward it past endsAt. */
async function startFinishedShift(u: AuthedUser): Promise<string> {
  const r = await call(u, 'POST', '/v1/shifts', { careerId: 'discord_mod' });
  expect(r.status).toBe(200);
  const shiftId = r.body.shiftId as string;
  _shifts.set(shiftId, { ..._shifts.get(shiftId)!, endsAt: 0 });
  return shiftId;
}

async function discordMod(u: AuthedUser): Promise<{ level: number; xp: number; payCents: number }> {
  const r = await call(u, 'GET', '/v1/careers');
  return (
    r.body as unknown as Array<{ id: string; level: number; xp: number; payCents: number }>
  ).find((c) => c.id === 'discord_mod')!;
}

describe('career progression', () => {
  it('stores shift XP, reads it back, and never awards a replayed key twice', async () => {
    const u = await devAuth();
    const applied = await call(u, 'POST', '/v1/careers/discord_mod/apply', {});
    expect(applied.body).toMatchObject({ careerId: 'discord_mod', level: 1, xp: 0 });

    const shiftId = await startFinishedShift(u);
    const key = uuidv7();
    const done = { results: [{ miniGameId: 'discord_mod_ban', score: 3 }] };
    const first = await call(u, 'POST', `/v1/shifts/${shiftId}/complete`, done, key);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ payCents: 1200, xp: 30, promoted: false });

    const replay = await call(u, 'POST', `/v1/shifts/${shiftId}/complete`, done, key);
    expect(replay.body).toEqual(first.body);
    const again = await call(u, 'POST', `/v1/shifts/${shiftId}/complete`, done);
    expect(again.status).toBe(409);

    expect(await discordMod(u)).toMatchObject({ level: 1, xp: 30 });
    const reapplied = await call(u, 'POST', '/v1/careers/discord_mod/apply', {});
    expect(reapplied.body).toMatchObject({ level: 1, xp: 30 });
    const ledger = await sql<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ledger_entries WHERE user_id = $1 AND reason = 'shift_pay'`,
      [u.sub],
    );
    expect(ledger[0]!.n).toBe('1');
  });

  it('promotes at the level threshold and pays the new level next shift', async () => {
    const u = await devAuth();
    await call(u, 'POST', '/v1/careers/discord_mod/apply', {});
    await sql(
      `UPDATE career_progress SET xp = 90 WHERE user_id = $1 AND career_id = 'discord_mod'`,
      [u.sub],
    );
    const perfect = { results: [{ miniGameId: 'discord_mod_ban', score: 10 }] };

    const s1 = await startFinishedShift(u);
    const r1 = await call(u, 'POST', `/v1/shifts/${s1}/complete`, perfect);
    // Level 1 pay; 90 + 100 XP crosses the 100 threshold with 90 left.
    expect(r1.body).toMatchObject({ payCents: 4000, xp: 100, promoted: true });
    expect(await discordMod(u)).toMatchObject({ level: 2, xp: 90, payCents: 5500 });

    const s2 = await startFinishedShift(u);
    const r2 = await call(u, 'POST', `/v1/shifts/${s2}/complete`, perfect);
    // Level 2 pay; 90 + 100 XP crosses the 120 threshold with 70 left.
    expect(r2.body).toMatchObject({ payCents: 5500, xp: 100, promoted: true });
    expect(await discordMod(u)).toMatchObject({ level: 3, xp: 70 });
  });
});

describe('origin home', () => {
  const character = (alias: string) => ({
    alias,
    look: {
      skinTone: 'tan',
      headId: 'head_a',
      hairId: 'hair_a',
      topId: 'top_a',
      bottomId: 'bottom_a',
      shoesId: 'shoes_a',
      accId: 'acc_none',
    },
    traitIds: ['fast_talker', 'deep_pockets'],
    dreamId: 'make_10k',
    tribeId: 'trencher',
    ageConfirmed: true,
  });

  async function createAndReadHome(u: AuthedUser): Promise<{ created: unknown; me: unknown }> {
    const created = await call(u, 'POST', '/v1/characters', character(`h${u.sub.slice(-10)}`));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const me = await call(u, 'GET', '/v1/me');
    return { created: created.body.homeId, me: me.body.homeId };
  }

  it('gives the character the home its real roll promised', async () => {
    const u = await devAuth();
    const roll = await call(u, 'POST', '/v1/lottery/roll', {});
    expect(roll.status).toBe(200);
    const promised = roll.body.homeId as string;
    expect(promised).toBe(lottery.outcomes[roll.body.outcome as string]!.homeId);
    expect(await createAndReadHome(u)).toEqual({ created: promised, me: promised });
  });

  it.each(Object.keys(lottery.outcomes))(
    'maps the %s outcome to its configured home',
    async (o) => {
      const u = await devAuth();
      // Seed the roll directly: the seeker weight is 0, so a real roll
      // can never reach that outcome.
      await sql(`UPDATE users SET lottery_rolled_at = now() WHERE id = $1`, [u.sub]);
      await sql(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, 0, 'cash', 'lottery_payout', 'lottery', $2, $3)`,
        [u.sub, o, `lottery:${u.sub}`],
      );
      const home = lottery.outcomes[o]!.homeId;
      expect(homeIds.has(home)).toBe(true);
      expect(await createAndReadHome(u)).toEqual({ created: home, me: home });
    },
  );
});
