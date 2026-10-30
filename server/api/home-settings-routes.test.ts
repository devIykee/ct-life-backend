/**
 * Visitor policy over HTTP (unlock D2): GET/PUT /v1/homes/me/settings behind
 * `visitorPolicy`, and the policy enforced in POST /homes/{ownerId}/visit:
 * closed -> 403 HOME_CLOSED, followers -> followers and guests only
 * (403 FORBIDDEN followers_only), open -> as before.
 *
 * The owner leases a basement (no doors in contract/ids/home_units.json), so
 * the door never decides; only the policy does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';

let api: TestApi;
const owners: string[] = [];

async function homeOwner(): Promise<Awaited<ReturnType<TestApi['player']>>> {
  const p = await api.player();
  owners.push(p.sub);
  await createDb().withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 100000`,
      [p.sub],
    ),
  );
  const lease = await api.call(p, 'POST', '/v1/homes', { kind: 'parents_basement' });
  expect(lease.status, JSON.stringify(lease.body)).toBe(200);
  return p;
}

describe('visitor policy', () => {
  beforeAll(async () => {
    api = await bootApi('visitorPolicy', { LIVE_PHASE: '6' });
  }, 30_000);
  afterAll(async () => {
    await createDb().withConnection((c) =>
      c.query(`DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[])`, [owners]),
    );
    await api.stop();
  }, 30_000);

  it('defaults to open, stores the choice, validates it', async () => {
    const p = await api.player();
    expect((await api.call(p, 'GET', '/v1/homes/me/settings')).body).toEqual({ visitors: 'open' });
    const put = await api.call(p, 'PUT', '/v1/homes/me/settings', { visitors: 'followers' });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ visitors: 'followers' });
    expect((await api.call(p, 'GET', '/v1/homes/me/settings')).body).toEqual({
      visitors: 'followers',
    });
    for (const bad of [{ visitors: 'friends' }, {}, { visitors: 'open', extra: 1 }]) {
      const r = await api.call(p, 'PUT', '/v1/homes/me/settings', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(errCode(r)).toBe('VALIDATION_FAILED');
    }
    expect((await api.call(null, 'GET', '/v1/homes/me/settings')).status).toBe(401);
  });

  it('closed refuses every visitor with HOME_CLOSED; the owner still gets in', async () => {
    const owner = await homeOwner();
    const visitor = await api.player();
    expect((await api.call(visitor, 'POST', `/v1/homes/${owner.sub}/visit`)).status).toBe(200);
    await api.call(owner, 'PUT', '/v1/homes/me/settings', { visitors: 'closed' });
    const r = await api.call(visitor, 'POST', `/v1/homes/${owner.sub}/visit`);
    expect(r.status).toBe(403);
    expect(errCode(r)).toBe('HOME_CLOSED');
    expect((await api.call(owner, 'POST', `/v1/homes/${owner.sub}/visit`)).status).toBe(200);
  });

  it('followers lets in mutual followers and guests only; a one-way follower is refused', async () => {
    const owner = await homeOwner();
    const fan = await api.player();
    const oneWay = await api.player();
    const stranger = await api.player();
    const guest = await api.player();
    await api.call(owner, 'PUT', '/v1/homes/me/settings', { visitors: 'followers' });

    const refused = await api.call(stranger, 'POST', `/v1/homes/${owner.sub}/visit`);
    expect(refused.status).toBe(403);
    expect(errCode(refused)).toBe('FORBIDDEN');
    expect(errDetails(refused)).toEqual({ reason: 'followers_only' });

    await createDb().withConnection(async (c) => {
      // fan and owner follow each other; oneWay only follows the owner.
      await c.query(
        `INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2), ($2, $1), ($3, $2)`,
        [fan.sub, owner.sub, oneWay.sub],
      );
      const h = await c.query<{ home_id: string }>(
        `SELECT home_id FROM homes WHERE owner_user_id = $1 AND status = 'active'`,
        [owner.sub],
      );
      await c.query(`INSERT INTO home_guests (home_id, user_id) VALUES ($1, $2)`, [
        h.rows[0]!.home_id,
        guest.sub,
      ]);
    });
    expect((await api.call(fan, 'POST', `/v1/homes/${owner.sub}/visit`)).status).toBe(200);
    const one = await api.call(oneWay, 'POST', `/v1/homes/${owner.sub}/visit`);
    expect(one.status).toBe(403);
    expect(errDetails(one)).toEqual({ reason: 'followers_only' });
    expect((await api.call(guest, 'POST', `/v1/homes/${owner.sub}/visit`)).status).toBe(200);

    // Back to open: the stranger gets in again.
    await api.call(owner, 'PUT', '/v1/homes/me/settings', { visitors: 'open' });
    expect((await api.call(stranger, 'POST', `/v1/homes/${owner.sub}/visit`)).status).toBe(200);
  });

  it('refuses a blocked visitor with BLOCKED under open, either direction, guests included', async () => {
    const owner = await homeOwner();
    const pest = await api.player();
    const blocker = await api.player();
    expect((await api.call(owner, 'GET', '/v1/homes/me/settings')).body).toEqual({
      visitors: 'open',
    });
    await createDb().withConnection(async (c) => {
      // owner blocked pest; blocker blocked owner (one row each, no mirror row).
      await c.query(
        `INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2), ($3, $1)`,
        [owner.sub, pest.sub, blocker.sub],
      );
      const h = await c.query<{ home_id: string }>(
        `SELECT home_id FROM homes WHERE owner_user_id = $1 AND status = 'active'`,
        [owner.sub],
      );
      await c.query(`INSERT INTO home_guests (home_id, user_id) VALUES ($1, $2)`, [
        h.rows[0]!.home_id,
        pest.sub,
      ]);
    });
    for (const who of [pest, blocker]) {
      const r = await api.call(who, 'POST', `/v1/homes/${owner.sub}/visit`);
      expect(r.status).toBe(403);
      expect(errCode(r)).toBe('BLOCKED');
    }
  });
});

describe('visitor policy gate', () => {
  it('answers 503 CAPABILITY_OFF on both settings routes while visitorPolicy is off', async () => {
    const off = await bootApi('', { LIVE_PHASE: '6' });
    try {
      const p = await off.player();
      for (const [m, body] of [
        ['GET', undefined],
        ['PUT', { visitors: 'closed' }],
      ] as const) {
        const r = await off.call(p, m, '/v1/homes/me/settings', body);
        expect(r.status).toBe(503);
        expect(errDetails(r)).toEqual({ capability: 'visitorPolicy' });
      }
    } finally {
      await off.stop();
    }
  });
});
