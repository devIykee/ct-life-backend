/**
 * The Rug Room over HTTP: auth, validation (the client sends no outcome, no
 * multiplier), the age gate, idempotent bets, the disclaimer on every answer,
 * and that rounds and challenges are visible only to their participants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import {
  crashPointX100,
  crashTimeMs,
  drawStream,
  readCasinoConfigFile,
} from '../application/casino-math.js';

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
    headers: { 'idempotency-key': `home-doors-${uuidv7()}` },
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

const errCode = (b: Record<string, unknown>): string => (b.error as { code: string }).code;
const DISCLAIMER = 'Play money. No cash value. 18+';

async function makeAdult(u: AuthedUser, cash = 100_000): Promise<void> {
  await db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'degen', ARRAY[]::text[], 'be_rich', 'studio', now())
       ON CONFLICT (user_id) DO UPDATE SET age_confirmed_at = now()`,
      [uuidv7(), u.sub, `http-${u.sub.slice(-12)}`],
    );
    await c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2`,
      [u.sub, cash],
    );
  });
}

async function casinoLedger(u: AuthedUser): Promise<string[]> {
  return db.withConnection(async (c) => {
    const r = await c.query<{ reason: string }>(
      `SELECT reason FROM ledger_entries WHERE user_id = $1 AND reason LIKE 'casino_%' ORDER BY id`,
      [u.sub],
    );
    return r.rows.map((x) => x.reason);
  });
}

async function openManualCrash(u: AuthedUser) {
  await makeAdult(u);
  const bet = await call(u, 'POST', '/v1/casino/crash/bet', { stakeCents: 200 });
  expect(bet.status).toBe(201);
  return bet;
}

/** The test reads the server's secret crash point from the database; a client never can. */
async function crashLeavesTime(bet: { body: Record<string, unknown> }): Promise<boolean> {
  const roundId = (bet.body.round as { roundId: string }).roundId;
  const r = await db.withConnection((c) =>
    c.query<{ seed: string }>(`SELECT seed FROM casino_rounds WHERE round_id = $1`, [roundId]),
  );
  const cfg = readCasinoConfigFile();
  const crash = crashPointX100(drawStream(r.rows[0]!.seed, `crash:${roundId}`)(), cfg);
  return crashTimeMs(crash, cfg) > 2_000; // seconds of room for the calls below
}

describe('The Rug Room over HTTP', () => {
  it('needs a token', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/casino/state' });
    expect(r.statusCode).toBe(401);
    const w = await app.inject({
      method: 'POST',
      url: '/v1/casino/slots/spin',
      headers: { 'idempotency-key': uuidv7() },
      payload: { stakeCents: 100 },
    });
    expect(w.statusCode).toBe(401);
  });

  it('refuses a player without a confirmed 18+ with AGE_REQUIRED but still shows the gate state', async () => {
    const u = await devAuth();
    const state = await call(u, 'GET', '/v1/casino/state');
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ ageConfirmed: false, disclaimer: DISCLAIMER });
    const r = await call(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 100 });
    expect(r.status).toBe(403);
    expect(errCode(r.body)).toBe('AGE_REQUIRED');
  });

  it('plays all three games and every answer carries the disclaimer and session fields', async () => {
    const u = await devAuth();
    await makeAdult(u);
    const slots = await call(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 100 });
    expect(slots.status, JSON.stringify(slots.body)).toBe(201);
    const flip = await call(u, 'POST', '/v1/casino/coinflip/bet', {
      stakeCents: 100,
      side: 'heads',
    });
    expect(flip.status).toBe(201);
    const crash = await call(u, 'POST', '/v1/casino/crash/bet', {
      stakeCents: 100,
      autoCashout: 2,
    });
    expect(crash.status).toBe(201);
    for (const res of [slots, flip, crash]) {
      expect(res.body.disclaimer).toBe(DISCLAIMER);
      expect(typeof res.body.sessionMinutes).toBe('number');
      expect(typeof res.body.sessionReminder).toBe('boolean');
      expect((res.body.round as { status: string }).status).toBe('settled');
    }
    const rounds = await call(u, 'GET', '/v1/casino/rounds?mine=true');
    expect(rounds.status).toBe(200);
    expect((rounds.body.rounds as unknown[]).length).toBe(3);
    expect(rounds.body.disclaimer).toBe(DISCLAIMER);
  });

  it('a replayed Idempotency-Key returns the same round and charges once', async () => {
    const u = await devAuth();
    await makeAdult(u);
    const key = uuidv7();
    const first = await call(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 500 }, key);
    const replay = await call(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 500 }, key);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect((await casinoLedger(u)).filter((r) => r === 'casino_stake')).toHaveLength(1);
    const rounds = await call(u, 'GET', '/v1/casino/rounds');
    expect((rounds.body.rounds as unknown[]).length).toBe(1);
    // the same key with a different body is refused, not played
    const mismatch = await call(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 900 }, key);
    expect(mismatch.status).toBe(400);
    expect((await casinoLedger(u)).filter((r) => r === 'casino_stake')).toHaveLength(1);
    // a bet needs the header at all
    const bare = await app.inject({
      method: 'POST',
      url: '/v1/casino/slots/spin',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { stakeCents: 100 },
    });
    expect(bare.statusCode).toBe(400);
  });

  it('ignores nothing the client sends: an outcome, multiplier or price field is rejected', async () => {
    const u = await devAuth();
    await makeAdult(u);
    const bad: Array<[string, unknown]> = [
      ['/v1/casino/slots/spin', { stakeCents: 100, multiplier: 50 }],
      ['/v1/casino/slots/spin', { stakeCents: 100, reels: ['wild', 'wild', 'wild'] }],
      ['/v1/casino/slots/spin', { stakeCents: 100, seed: 'aa' }],
      ['/v1/casino/coinflip/bet', { stakeCents: 100, side: 'heads', result: 'heads' }],
      ['/v1/casino/crash/bet', { stakeCents: 100, crashPoint: 100 }],
      ['/v1/casino/slots/spin', { stakeCents: 10.5 }],
      ['/v1/casino/slots/spin', { stakeCents: '100' }],
      ['/v1/casino/slots/spin', {}],
      ['/v1/casino/crash/bet', { stakeCents: 100, autoCashout: 0.5 }],
      ['/v1/casino/coinflip/bet', { stakeCents: 100, side: 'edge' }],
    ];
    for (const [url, payload] of bad) {
      // a fresh player each time: rejected bets still use the per-player burst allowance
      const r = await call(await devAuth(), 'POST', url, payload);
      expect(r.status, `${url} ${JSON.stringify(payload)}`).toBe(400);
      expect(errCode(r.body)).toBe('VALIDATION_FAILED');
    }
    expect(await casinoLedger(u)).toEqual([]);
  });

  it('crash: manual round, cashout by its owner only, and a second cashout is ROUND_SETTLED', async () => {
    const thief = await devAuth();
    await makeAdult(thief);
    // About 6% of rounds are an instant bust (nothing to cash out of, and the next bet is
    // allowed at once): draw players until the server's crash point leaves time to act.
    let u = await devAuth();
    let bet = await openManualCrash(u);
    for (let i = 0; i < 30 && !(await crashLeavesTime(bet)); i++) {
      u = await devAuth();
      bet = await openManualCrash(u);
    }
    expect(await crashLeavesTime(bet)).toBe(true);
    const round = bet.body.round as { roundId: string; status: string; seed: unknown };
    expect(round.status).toBe('open');
    expect(round.seed).toBeNull();
    const stolen = await call(thief, 'POST', '/v1/casino/crash/cashout', {
      roundId: round.roundId,
    });
    expect(stolen.status).toBe(404);
    const seen = await call(thief, 'GET', `/v1/casino/rounds/${round.roundId}`);
    expect(seen.status).toBe(404);
    const second = await call(u, 'POST', '/v1/casino/crash/bet', { stakeCents: 200 });
    expect(second.status).toBe(409);
    expect(errCode(second.body)).toBe('ROUND_IN_PROGRESS');
    const out = await call(u, 'POST', '/v1/casino/crash/cashout', { roundId: round.roundId });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect((out.body.round as { status: string }).status).toBe('settled');
    const again = await call(u, 'POST', '/v1/casino/crash/cashout', { roundId: round.roundId });
    expect(again.status).toBe(409);
    expect(errCode(again.body)).toBe('ROUND_SETTLED');
  });

  it('head-to-head over HTTP: only the two players see it, only the opponent accepts', async () => {
    const a = await devAuth();
    const b = await devAuth();
    const c = await devAuth();
    for (const u of [a, b, c]) await makeAdult(u, 10_000);
    const made = await call(a, 'POST', '/v1/casino/coinflip/challenges', {
      opponentUserId: b.sub,
      side: 'heads',
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // No stake: a client that still sends one is told so (400), and no Cash moves.
    const staked = await call(a, 'POST', '/v1/casino/coinflip/challenges', {
      opponentUserId: b.sub,
      stakeCents: 1_000,
      side: 'heads',
    });
    expect(staked.status).toBe(400);
    expect(errCode(staked.body)).toBe('VALIDATION_FAILED');
    const id = (made.body.challenge as { challengeId: string }).challengeId;
    expect((await call(c, 'GET', '/v1/casino/coinflip/challenges')).body.challenges).toEqual([]);
    expect((await call(b, 'GET', '/v1/casino/coinflip/challenges')).body.challenges).toHaveLength(
      1,
    );
    expect((await call(c, 'POST', `/v1/casino/coinflip/challenges/${id}/accept`)).status).toBe(404);
    expect((await call(a, 'POST', `/v1/casino/coinflip/challenges/${id}/accept`)).status).toBe(403);
    const ok = await call(b, 'POST', `/v1/casino/coinflip/challenges/${id}/accept`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.disclaimer).toBe(DISCLAIMER);
    expect((ok.body.challenge as { status: string }).status).toBe('settled');
    expect(await casinoLedger(a)).toEqual([]);
    expect(await casinoLedger(b)).toEqual([]);
    const dup = await call(b, 'POST', `/v1/casino/coinflip/challenges/${id}/accept`);
    expect(dup.status).toBe(409);
    expect(errCode(dup.body)).toBe('CHALLENGE_NOT_OPEN');
  });

  it('self-exclude over HTTP blocks the next bet with SELF_EXCLUDED', async () => {
    const u = await devAuth();
    await makeAdult(u);
    const ex = await call(u, 'POST', '/v1/casino/self-exclude', { days: 7 });
    expect(ex.status).toBe(200);
    expect(ex.body.disclaimer).toBe(DISCLAIMER);
    const r = await call(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 100 });
    expect(r.status).toBe(403);
    expect(errCode(r.body)).toBe('SELF_EXCLUDED');
    const bad = await call(u, 'POST', '/v1/casino/self-exclude', { days: 0 });
    expect(bad.status).toBe(400);
    const state = await call(u, 'GET', '/v1/casino/state');
    expect(state.body.selfExcludedUntil).toBe(ex.body.selfExcludedUntil);
  });

  it('rate-limits a burst of bets', async () => {
    const u = await devAuth();
    await makeAdult(u, 1_000_000);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await call(u, 'POST', '/v1/casino/slots/spin', { stakeCents: 100 });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(201);
  });
});
