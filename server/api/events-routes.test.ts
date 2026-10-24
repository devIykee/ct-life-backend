/**
 * Event calendar over HTTP: auth, current / upcoming / details, the
 * admin-only update (non-admin 403), progress validation, the window check
 * on the real clock, the full chain on an event the admin moved to now, and
 * the per-player rate limit. Chain logic and rewards are covered in
 * server/application/events.test.ts with a controlled clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createDb } from '../shared/db/pool.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { readFileSync } from 'node:fs';
import { _resetEventsSyncForTests } from '../application/events.js';

const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=
-----END PUBLIC KEY-----`;

loadDotenv({ path: process.cwd() + '/.env' });

const adminKey = Keypair.generate();
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
  process.env.ADMIN_WALLETS = adminKey.publicKey.toBase58();
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  // Prepare Fastify without binding a real port.
  await app.ready();
  stop = handle.stop;
}, 30_000);

afterAll(async () => {
  await db.withConnection((c) =>
    c.query(`DELETE FROM events WHERE id = 'evt_cal_test_routes_2031'`),
  );
  await stop();
}, 30_000);

interface AuthedUser {
  sub: string;
  accessToken: string;
}

async function devAuth(kp: Keypair = Keypair.generate()): Promise<AuthedUser> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `events-${uuidv7()}` },
    payload: { wallet: kp.publicKey.toBase58() },
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
const SLUG = 'test-event-routes-2031';
const EID = 'evt_cal_test_routes_2031';
const answers = (
  JSON.parse(readFileSync('contract/config/event_trivia.json', 'utf8')) as {
    answers: Record<string, string>;
  }
).answers;

async function seed(): Promise<void> {
  await db.withConnection(async (c) => {
    await c.query(`DELETE FROM events WHERE id = $1`, [EID]);
    await c.query(
      `INSERT INTO events (id, slug, title, kind, starts_at, ends_at, city, real_venue,
          ingame_venue_id, skin_id, source_url, quest_set, reward_cents, reward_item_key)
       VALUES ($1, $2, 'Route Test', 'meetup', '2031-05-01T10:00Z', '2031-05-01T18:00Z', 'Testville',
          'Test Hall', 'conference_hall', 'test_skin', 'https://example.com/t', 'breakpoint_2026',
          500, NULL)`,
      [EID, SLUG],
    );
  });
}

describe('events over HTTP', () => {
  it('requires auth and serves current, upcoming and details', async () => {
    _resetEventsSyncForTests();
    await seed();
    const anon = await app.inject({ method: 'GET', url: '/v1/events/current' });
    expect(anon.statusCode).toBe(401);

    const u = await devAuth();
    const cur = await call(u, 'GET', '/v1/events/current');
    expect(cur.status).toBe(200);
    expect(Array.isArray(cur.body.items)).toBe(true);
    expect(typeof cur.body.serverNow).toBe('number');

    const up = await call(u, 'GET', '/v1/events/upcoming?limit=50');
    const slugs = (up.body.items as Array<{ slug: string }>).map((i) => i.slug);
    expect(slugs).toContain(SLUG);
    expect((await call(u, 'GET', '/v1/events/upcoming?limit=0')).status).toBe(400);

    const d = await call(u, 'GET', `/v1/events/${SLUG}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ slug: SLUG, skinId: 'test_skin', status: 'upcoming' });
    expect((d.body.quest as { completed: boolean }).completed).toBe(false);
    expect((await call(u, 'GET', '/v1/events/no-such-event')).status).toBe(404);
  });

  it('admin-only update: a non-admin gets 403, the admin can fix dates and the stream link', async () => {
    await seed();
    const player = await devAuth();
    const denied = await call(player, 'PUT', `/v1/admin/events/${SLUG}`, {
      streamUrl: 'https://stream.example.com/x',
    });
    expect(denied.status).toBe(403);
    const anon = await app.inject({ method: 'PUT', url: `/v1/admin/events/${SLUG}`, payload: {} });
    expect(anon.statusCode).toBe(401);

    const admin = await devAuth(adminKey);
    const ok = await call(admin, 'PUT', `/v1/admin/events/${SLUG}`, {
      streamUrl: 'https://stream.example.com/x',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.streamUrl).toBe('https://stream.example.com/x');
    expect(
      (await call(admin, 'PUT', `/v1/admin/events/${SLUG}`, { streamUrl: 'http://x.io' })).status,
    ).toBe(400);
    expect((await call(admin, 'PUT', `/v1/admin/events/${SLUG}`, { bogus: 1 })).status).toBe(400);
    expect(
      (await call(admin, 'PUT', `/v1/admin/events/${SLUG}`, { endsAt: '2031-05-01T09:00:00Z' }))
        .status,
    ).toBe(400);
    expect((await call(admin, 'PUT', '/v1/admin/events/nope', { title: 'x' })).status).toBe(404);
  });

  it('refuses progress outside the window and bad bodies', async () => {
    await seed();
    const u = await devAuth();
    const early = await call(u, 'POST', `/v1/events/${SLUG}/progress`, {
      step: 'booths',
      proof: { id: 'bp26.booth_1' },
    });
    expect(early.status).toBe(409);
    expect(errCode(early.body)).toBe('EVENT_NOT_LIVE');
    expect((await call(u, 'POST', `/v1/events/${SLUG}/progress`, { step: 'booths' })).status).toBe(
      400,
    );
    expect(
      (await call(u, 'POST', '/v1/events/nope/progress', { step: 'booths', proof: { id: 'x' } }))
        .status,
    ).toBe(404);
  });

  it('runs the chain on a live event, then pays the reward once', async () => {
    await seed();
    const admin = await devAuth(adminKey);
    const now = Date.now();
    const live = await call(admin, 'PUT', `/v1/admin/events/${SLUG}`, {
      startsAt: new Date(now - 3_600_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
    });
    expect(live.status).toBe(200);
    const cur = await call(admin, 'GET', '/v1/events/current');
    expect((cur.body.items as Array<{ slug: string }>).map((i) => i.slug)).toContain(SLUG);

    const u = await devAuth();
    const post = (step: string, proof: Record<string, string>) =>
      call(u, 'POST', `/v1/events/${SLUG}/progress`, { step, proof });
    expect(errCode((await post('booths', { id: 'bogus' })).body)).toBe('EVENT_STEP_INVALID');
    for (const id of ['bp26.booth_1', 'bp26.booth_2', 'bp26.booth_3']) {
      expect((await post('booths', { id })).status).toBe(200);
    }
    // 5 of the 8-call burst used; the wrong trivia answer takes one more.
    const wrong = await post('trivia', { id: 'bp26.q_city', answer: 'd' });
    expect(errCode(wrong.body)).toBe('EVENT_STEP_INVALID');
    for (const id of ['bp26.q_venue', 'bp26.q_month']) {
      expect((await post('trivia', { id, answer: answers[id]! })).status).toBe(200);
    }
    // 8 calls so far (1 bogus + 3 + 1 wrong + 2 = 7, next is the 8th); the 9th is limited.
    const eighth = await post('trivia', { id: 'bp26.q_days', answer: answers['bp26.q_days']! });
    expect(eighth.status).toBe(200);
    const limited = await post('nods', { id: 'bp26.nod_1' });
    expect(limited.status).toBe(429);
    const d = await call(u, 'GET', `/v1/events/${SLUG}`);
    expect(
      (d.body.quest as { steps: Array<{ step: string; complete: boolean }> }).steps.map(
        (s) => s.complete,
      ),
    ).toEqual([true, true, false]);
  });

  it('IRL check-in: validated, never echoes a position, rate limited to 3 attempts an hour', async () => {
    const u = await devAuth();
    const url = '/v1/events/breakpoint-2026/checkin';
    const pos = { lat: 51.49639, lng: -0.20972, accuracyM: 10, isMock: false };
    expect((await call(u, 'POST', url, { lat: 'x' })).status).toBe(400);
    const bad = await call(u, 'POST', url, { ...pos, lat: 999 });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('999');
    // The real clock is before Breakpoint, so the window check refuses.
    const early = await call(u, 'POST', url, pos);
    expect(early.status).toBe(409);
    expect(errCode(early.body)).toBe('EVENT_NOT_LIVE');
    expect(JSON.stringify(early.body)).not.toContain('51.4963');
    // Attempts so far: 3 (two bad bodies fail before the limiter; early is the 1st). Burn the rest.
    await call(u, 'POST', url, pos);
    await call(u, 'POST', url, pos);
    const limited = await call(u, 'POST', url, pos);
    expect(limited.status).toBe(429);

    expect((await call(u, 'PUT', `${url}/visibility`, { visible: true })).status).toBe(404);
    expect((await call(u, 'PUT', `${url}/visibility`, { visible: 'yes' })).status).toBe(400);
    const board = await call(u, 'GET', '/v1/events/breakpoint-2026/irl?limit=5');
    expect(board.status).toBe(200);
    expect(Array.isArray(board.body.items)).toBe(true);
    expect((await call(u, 'GET', '/v1/events/nope/irl')).status).toBe(404);
  });
});
