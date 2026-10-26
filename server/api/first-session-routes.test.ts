/**
 * The first session over HTTP: GET /me flags.firstSession, POST /me/first-session (beat,
 * skip, replay, validation, idempotency, rate limit), the beats the server sets from the
 * lottery roll and character creation, and the starter quests in GET /quests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { _resetConfigForTests } from '../shared/config/config.js';

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;

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

interface U {
  sub: string;
  accessToken: string;
}
async function devAuth(): Promise<U> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `fs-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, accessToken: b.accessToken };
}
async function call(
  u: U,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  key?: string,
): Promise<{ status: number; body: Record<string, any> }> {
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
const errCode = (b: Record<string, any>): string => b.error.code;
const fs = async (u: U) => (await call(u, 'GET', '/v1/me')).body.flags.firstSession;

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

describe('GET /me flags.firstSession', () => {
  it('a new account is active with no beats', async () => {
    const u = await devAuth();
    const s = await fs(u);
    expect(s).toMatchObject({ state: 'active', completedAt: null, beats: [] });
    expect(typeof s.startedAt).toBe('string');
  });
});

describe('POST /me/first-session', () => {
  it('needs a token and an idempotency key', async () => {
    const a = await app.inject({
      method: 'POST',
      url: '/v1/me/first-session',
      payload: { skip: true },
    });
    expect(a.statusCode).toBe(401);
    const u = await devAuth();
    const b = await app.inject({
      method: 'POST',
      url: '/v1/me/first-session',
      headers: { authorization: `Bearer ${u.accessToken}` },
      payload: { skip: true },
    });
    expect(b.statusCode).toBe(400);
  });

  it('adds a beat and replies with the new object; the same key replays', async () => {
    const u = await devAuth();
    const key = uuidv7();
    const r = await call(u, 'POST', '/v1/me/first-session', { beat: 'home' }, key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ state: 'active', beats: ['home'] });
    const again = await call(u, 'POST', '/v1/me/first-session', { beat: 'home' }, key);
    expect(again.body).toEqual(r.body);
    expect((await fs(u)).beats).toEqual(['home']);
  });

  it('refuses an unknown beat, extra fields, mixed bodies and an empty body with VALIDATION_FAILED', async () => {
    const u = await devAuth();
    for (const body of [
      { beat: 'teleport' },
      { beat: 'home', skip: true },
      { skip: false },
      { replay: 'yes' },
      { skip: true, replay: true },
      {},
      { beat: 5 },
    ]) {
      const r = await call(u, 'POST', '/v1/me/first-session', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(errCode(r.body)).toBe('VALIDATION_FAILED');
    }
    expect((await fs(u)).beats).toEqual([]);
  });

  it('skip then replay', async () => {
    const u = await devAuth();
    await call(u, 'POST', '/v1/me/first-session', { beat: 'moved' });
    const skipped = await call(u, 'POST', '/v1/me/first-session', { skip: true });
    expect(skipped.body).toMatchObject({ state: 'skipped', beats: ['moved'] });
    expect((await fs(u)).state).toBe('skipped');
    const replayed = await call(u, 'POST', '/v1/me/first-session', { replay: true });
    expect(replayed.body).toMatchObject({ state: 'active', beats: [], completedAt: null });
  });

  it('is rate limited to 20 a minute', async () => {
    const u = await devAuth();
    const statuses: number[] = [];
    for (let i = 0; i < 24; i++) {
      statuses.push((await call(u, 'POST', '/v1/me/first-session', { beat: 'home' })).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(20)).toContain(429);
  });
});

describe('beats the server sets, and the starter quests', () => {
  it('the lottery roll sets origin, character creation sets character and seeds the starters', async () => {
    const u = await devAuth();
    expect((await call(u, 'POST', '/v1/lottery/roll', {})).status).toBe(200);
    expect((await fs(u)).beats).toEqual(['origin']);
    const made = await call(u, 'POST', '/v1/characters', character(`fs${u.sub.slice(-10)}`));
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await fs(u)).beats).toEqual(['origin', 'character']);
    const q = await call(u, 'GET', '/v1/quests');
    expect(Object.keys(q.body)[0]).toBe('starter');
    expect(q.body.starter.quests.map((x: { id: string }) => x.id)).toEqual([
      'q_starter_shift',
      'q_starter_chest',
    ]);
    expect(q.body.starter.quests[0]).toMatchObject({ pool: 'starter', progress: 0 });
  });

  it('a GM chest claim over HTTP completes the starter quest, which then claims', async () => {
    const u = await devAuth();
    await call(u, 'GET', '/v1/quests');
    expect((await call(u, 'POST', '/v1/daily/claim', {})).status).toBe(200);
    const q = await call(u, 'GET', '/v1/quests');
    expect(
      q.body.starter.quests.find((x: { id: string }) => x.id === 'q_starter_chest'),
    ).toMatchObject({ progress: 1, completed: true, claimed: false });
    const claim = await call(u, 'POST', '/v1/quests/q_starter_chest/claim', {});
    expect(claim.status).toBe(200);
    expect(claim.body).toMatchObject({
      alreadyClaimed: false,
      reward: { cashCents: 500, seasonXp: 20 },
    });
    expect((await fs(u)).beats).toContain('chest');
  });
});
