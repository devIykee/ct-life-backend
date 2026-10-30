/**
 * POST /v1/units/{unitId}/knock over HTTP: a flat door knocks without the
 * knocker ever learning who lives there. 204 and a `home_knock` to the
 * occupant; 404 for an unknown or vacant door, 400 self_knock on your own
 * door, 403 HOME_CLOSED, 429 knock_cooldown per door. A block is silent (the
 * same empty 204, no message) and the door cooldown is keyed by the unit, so
 * neither can tie a door to a name. 503 while `visitorPolicy` is off.
 */
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi, type TestPlayer } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { USER_CHANNEL, type UserMessage } from '../application/realtime-bus.js';

let api: TestApi;
let sub: IORedis;
const got: UserMessage[] = [];
const owners: string[] = [];
const units: string[] = [];
const db = (): ReturnType<typeof createDb> => createDb();

async function newUnit(): Promise<string> {
  const unitId = `test:unit_knock:${uuidv7()}`;
  units.push(unitId);
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
       VALUES ($1, 'residences', 'flat', 'test_room', 50000, 2)`,
      [unitId],
    ),
  );
  return unitId;
}

/** A player whose live home sits behind a fresh flat door. */
async function flatOwner(): Promise<{ owner: TestPlayer; unitId: string; homeId: string }> {
  const owner = await api.player();
  owners.push(owner.sub);
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 100000`,
      [owner.sub],
    ),
  );
  const made = await api.call(owner, 'POST', '/v1/homes', { kind: 'parents_basement' });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  const unitId = await newUnit();
  const r = await db().withConnection((c) =>
    c.query<{ home_id: string }>(
      `UPDATE homes SET unit_id = $1
        WHERE owner_user_id = $2 AND status IN ('active', 'overdue') RETURNING home_id`,
      [unitId, owner.sub],
    ),
  );
  return { owner, unitId, homeId: r.rows[0]!.home_id };
}

const url = (unitId: string): string => `/v1/units/${encodeURIComponent(unitId)}/knock`;
const knocksFor = (owner: string): UserMessage[] =>
  got.filter((m) => m.type === 'home_knock' && m.userId === owner);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 150));

describe('flat door knock', () => {
  beforeAll(async () => {
    api = await bootApi('visitorPolicy', { LIVE_PHASE: '6' });
    sub = new IORedis(process.env.REDIS_URL!);
    await sub.subscribe(USER_CHANNEL);
    sub.on('message', (_ch, raw) => got.push(JSON.parse(raw) as UserMessage));
  }, 30_000);
  afterAll(async () => {
    await sub.quit();
    await db().withConnection(async (c) => {
      await c.query(`DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[])`, [owners]);
      await c.query(`DELETE FROM home_units WHERE unit_id = ANY($1::text[])`, [units]);
    });
    await api.stop();
  }, 30_000);

  it('rings the occupant without naming them, then cools down per door', async () => {
    const { owner, unitId, homeId } = await flatOwner();
    const stranger = await api.player();
    const access = await api.call(
      stranger,
      'GET',
      `/v1/units/${encodeURIComponent(unitId)}/access`,
    );
    expect(access.body).toEqual({ canEnter: false, reason: 'locked' });

    const r = await api.call(stranger, 'POST', url(unitId));
    expect(r.status).toBe(204);
    expect(r.raw.length).toBe(0); // nothing about the occupant comes back
    await settle();
    const k = knocksFor(owner.sub);
    expect(k).toHaveLength(1);
    expect(k[0]!.payload).toMatchObject({ fromUserId: stranger.sub, alias: 'Anon', homeId });

    const again = await api.call(stranger, 'POST', url(unitId));
    expect(again.status).toBe(429);
    expect(errDetails(again).reason).toBe('knock_cooldown');
    // The door cooldown is the unit's: a profile knock on the same owner is its own door,
    // so a leftover cooldown can never tie this door to that name.
    expect((await api.call(stranger, 'POST', `/v1/homes/${owner.sub}/knock`)).status).toBe(204);
    await settle();
    expect(knocksFor(owner.sub)).toHaveLength(2);
  });

  it('answers a blocked knocker exactly like a stranger and tells nobody', async () => {
    const { owner, unitId } = await flatOwner();
    const pest = await api.player();
    const stranger = await api.player();
    await db().withConnection((c) =>
      c.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
        owner.sub,
        pest.sub,
      ]),
    );
    const blocked = await api.call(pest, 'POST', url(unitId));
    const normal = await api.call(stranger, 'POST', url(unitId));
    expect(blocked.status).toBe(204);
    expect(blocked.raw.length).toBe(normal.raw.length);
    expect(normal.status).toBe(204);
    // The blocked knocker still spends the door cooldown, like anyone else.
    expect((await api.call(pest, 'POST', url(unitId))).status).toBe(429);
    await settle();
    const k = knocksFor(owner.sub);
    expect(k).toHaveLength(1);
    expect(k[0]!.payload.fromUserId).toBe(stranger.sub);
  });

  it('refuses unknown and vacant doors, your own door and a closed home', async () => {
    const { owner, unitId } = await flatOwner();
    const p = await api.player();
    const unknown = await api.call(p, 'POST', url('flat:nowhere:99'));
    expect(unknown.status).toBe(404);
    expect(errCode(unknown)).toBe('NOT_FOUND');
    const vacant = await newUnit();
    expect((await api.call(p, 'POST', url(vacant))).status).toBe(404);
    const self = await api.call(owner, 'POST', url(unitId));
    expect(self.status).toBe(400);
    expect(errDetails(self).reason).toBe('self_knock');
    expect(
      (await api.call(owner, 'PUT', '/v1/homes/me/settings', { visitors: 'closed' })).status,
    ).toBe(200);
    const closed = await api.call(p, 'POST', url(unitId));
    expect(closed.status).toBe(403);
    expect(errCode(closed)).toBe('HOME_CLOSED');
    await settle();
    expect(knocksFor(owner.sub)).toHaveLength(0);
  });

  it('needs a token', async () => {
    expect((await api.call(null, 'POST', url('flat:x:0'))).status).toBe(401);
  });
});

describe('flat door knock gate', () => {
  it('answers 503 CAPABILITY_OFF while visitorPolicy is off', async () => {
    const off = await bootApi('', { LIVE_PHASE: '6' });
    try {
      const p = await off.player();
      const r = await off.call(p, 'POST', url('flat:x:0'));
      expect(r.status).toBe(503);
      expect(errDetails(r)).toEqual({ capability: 'visitorPolicy' });
    } finally {
      await off.stop();
    }
  });
});
