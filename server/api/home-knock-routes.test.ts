/**
 * POST /v1/homes/{ownerId}/knock over HTTP (unlock D5): 204 and a
 * `home_knock` to the owner on the user channel; 404 without a home, 400 on
 * your own door, 403 BLOCKED (owner not told), 403 HOME_CLOSED, 429 cooldown,
 * 503 while `visitorPolicy` is off.
 */
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi, type TestPlayer } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';
import { USER_CHANNEL, type UserMessage } from '../application/realtime-bus.js';

let api: TestApi;
let sub: IORedis;
const got: UserMessage[] = [];
const owners: string[] = [];
const db = (): ReturnType<typeof createDb> => createDb();

async function homeOwner(): Promise<TestPlayer> {
  const p = await api.player();
  owners.push(p.sub);
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 100000`,
      [p.sub],
    ),
  );
  expect((await api.call(p, 'POST', '/v1/homes', { kind: 'parents_basement' })).status).toBe(200);
  return p;
}

const knocksFor = (owner: string): UserMessage[] =>
  got.filter((m) => m.type === 'home_knock' && m.userId === owner);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

describe('knock', () => {
  beforeAll(async () => {
    api = await bootApi('visitorPolicy', { LIVE_PHASE: '6' });
    sub = new IORedis(process.env.REDIS_URL!);
    await sub.subscribe(USER_CHANNEL);
    sub.on('message', (_ch, raw) => got.push(JSON.parse(raw) as UserMessage));
  }, 30_000);
  afterAll(async () => {
    await sub.quit();
    await db().withConnection((c) =>
      c.query(`DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[])`, [owners]),
    );
    await api.stop();
  }, 30_000);

  it('rings the owner once, then cools down', async () => {
    const owner = await homeOwner();
    const guest = await api.player();
    const r = await api.call(guest, 'POST', `/v1/homes/${owner.sub}/knock`);
    expect(r.status).toBe(204);
    await settle();
    const k = knocksFor(owner.sub);
    expect(k).toHaveLength(1);
    expect(k[0]!.payload).toMatchObject({ fromUserId: guest.sub, alias: 'Anon' });
    expect(String(k[0]!.payload.homeId)).toMatch(/^home:/);
    const again = await api.call(guest, 'POST', `/v1/homes/${owner.sub}/knock`);
    expect(again.status).toBe(429);
    expect(errDetails(again).reason).toBe('knock_cooldown');
    await settle();
    expect(knocksFor(owner.sub)).toHaveLength(1);
  });

  it('refuses self, no home, blocked (silently) and closed homes', async () => {
    const owner = await homeOwner();
    const pest = await api.player();
    expect((await api.call(owner, 'POST', `/v1/homes/${owner.sub}/knock`)).status).toBe(400);
    const homeless = await api.player();
    expect((await api.call(pest, 'POST', `/v1/homes/${homeless.sub}/knock`)).status).toBe(404);
    expect((await api.call(pest, 'POST', '/v1/homes/not-a-uuid/knock')).status).toBe(400);
    await db().withConnection((c) =>
      c.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
        owner.sub,
        pest.sub,
      ]),
    );
    const blocked = await api.call(pest, 'POST', `/v1/homes/${owner.sub}/knock`);
    expect(blocked.status).toBe(403);
    expect(errCode(blocked)).toBe('BLOCKED');
    const other = await api.player();
    await api.call(owner, 'PUT', '/v1/homes/me/settings', { visitors: 'closed' });
    const closed = await api.call(other, 'POST', `/v1/homes/${owner.sub}/knock`);
    expect(closed.status).toBe(403);
    expect(errCode(closed)).toBe('HOME_CLOSED');
    await settle();
    expect(knocksFor(owner.sub)).toHaveLength(0);
  });
});

describe('knock gate', () => {
  it('answers 503 CAPABILITY_OFF while visitorPolicy is off', async () => {
    const off = await bootApi('', { LIVE_PHASE: '6' });
    try {
      const p = await off.player();
      const r = await off.call(p, 'POST', `/v1/homes/${p.sub}/knock`);
      expect(r.status).toBe(503);
      expect(errDetails(r)).toEqual({ capability: 'visitorPolicy' });
    } finally {
      await off.stop();
    }
  });
});
