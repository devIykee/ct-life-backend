/**
 * POST /v1/homes/move over HTTP (unlock D1): gated by `homeMove`, atomic
 * (one live lease after, the old one moved out, first week debited once),
 * and every contract error: same_home, no_unit_free, INSUFFICIENT_CASH,
 * VALIDATION_FAILED, phase_locked.
 *
 * Uses its own penthouse unit (`test:home_move:0`) so it never competes with
 * the flat doors in contract/ids/home_units.json.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';

const UNIT = 'test:home_move:0';
let api: TestApi;
const db = (): ReturnType<typeof createDb> => createDb();

async function setCash(userId: string, cents: number): Promise<void> {
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2`,
      [userId, cents],
    ),
  );
}

async function cashOf(userId: string): Promise<number> {
  const r = await db().withConnection((c) =>
    c.query<{ cash_cents: string }>(`SELECT cash_cents FROM balances WHERE user_id = $1`, [userId]),
  );
  return Number(r.rows[0]?.cash_cents ?? 0);
}

async function cleanup(): Promise<void> {
  await db().withConnection(async (c) => {
    await c.query(`DELETE FROM homes WHERE unit_id = $1`, [UNIT]);
    await c.query(`DELETE FROM home_units WHERE unit_id = $1`, [UNIT]);
  });
}

const setup = async (): Promise<void> => {
  api = await bootApi('homeMove', { LIVE_PHASE: '6' });
  await cleanup();
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
       VALUES ($1, 'residences', 'penthouse', 'test_room', 150000, 3)`,
      [UNIT],
    ),
  );
};

const teardown = async (): Promise<void> => {
  await cleanup();
  await api.stop();
};

describe('POST /v1/homes/move', () => {
  // One server per describe: two live servers would share (and close) one pool.
  beforeAll(setup, 30_000);
  afterAll(teardown, 30_000);

  it('moves from the street, then up, then down, one live lease at a time', async () => {
    const p = await api.player();
    await setCash(p.sub, 1_000_000);

    // From the street: nothing to move out of. Basement has no doors in the file.
    const first = await api.call(p, 'POST', '/v1/homes/move', { kind: 'parents_basement' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.movedOutHomeId).toBeNull();
    const basement = first.body.home as Record<string, unknown>;
    expect(basement).toMatchObject({
      kind: 'parents_basement',
      rentCentsPerWeek: 2_000,
      unitId: null,
      status: 'active',
    });
    expect(await cashOf(p.sub)).toBe(1_000_000 - 2_000);

    // Up to the penthouse: takes the test door, the basement lease ends.
    const up = await api.call(p, 'POST', '/v1/homes/move', { kind: 'penthouse' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.movedOutHomeId).toBe(basement.homeId);
    expect(up.body.home).toMatchObject({
      kind: 'penthouse',
      unitId: UNIT,
      rentCentsPerWeek: 150_000,
    });
    expect(await cashOf(p.sub)).toBe(1_000_000 - 2_000 - 150_000);

    const me = await api.call(p, 'GET', '/v1/me');
    expect((me.body.home as { kind: string }).kind).toBe('penthouse');

    const leases = await db().withConnection((c) =>
      c.query<{ kind: string; status: string }>(
        `SELECT kind, status FROM homes WHERE owner_user_id = $1 ORDER BY created_at`,
        [p.sub],
      ),
    );
    expect(leases.rows).toEqual([
      { kind: 'parents_basement', status: 'moved_out' },
      { kind: 'penthouse', status: 'active' },
    ]);

    // Same kind again: 409 same_home, nothing charged.
    const same = await api.call(p, 'POST', '/v1/homes/move', { kind: 'penthouse' });
    expect(same.status).toBe(409);
    expect(errCode(same)).toBe('CONFLICT');
    expect(errDetails(same).reason).toBe('same_home');
    expect(await cashOf(p.sub)).toBe(1_000_000 - 152_000);

    // Downsize back: the door frees for the next tenant.
    const down = await api.call(p, 'POST', '/v1/homes/move', { kind: 'parents_basement' });
    expect(down.status).toBe(200);
    expect(down.body.movedOutHomeId).toBe((up.body.home as { homeId: string }).homeId);
    const door = await api.call(p, 'GET', `/v1/units/${UNIT}/access`);
    expect(door.body).toEqual({ canEnter: false, reason: 'vacant' });
  });

  it('refuses with INSUFFICIENT_CASH and leaves the old lease alone', async () => {
    const p = await api.player();
    await setCash(p.sub, 10_000);
    const first = await api.call(p, 'POST', '/v1/homes/move', { kind: 'parents_basement' });
    expect(first.status).toBe(200);
    const broke = await api.call(p, 'POST', '/v1/homes/move', { kind: 'marina_villa' });
    expect(broke.status).toBe(402);
    expect(errCode(broke)).toBe('INSUFFICIENT_CASH');
    expect(errDetails(broke)).toMatchObject({ need: '500000', have: '8000' });
    const live = await db().withConnection((c) =>
      c.query(`SELECT kind FROM homes WHERE owner_user_id = $1 AND status = 'active'`, [p.sub]),
    );
    expect(live.rows).toEqual([{ kind: 'parents_basement' }]);
    expect(await cashOf(p.sub)).toBe(8_000);
  });

  it('refuses no_unit_free when every door of the tier is taken, and rolls back', async () => {
    const holder = await api.player();
    const mover = await api.call(holder, 'GET', '/v1/me'); // warm the user row
    expect(mover.status).toBe(200);
    await setCash(holder.sub, 1_000_000);
    expect(
      (await api.call(holder, 'POST', '/v1/homes/move', { kind: 'marina_villa' })).status,
    ).toBe(200);
    const p = await api.player();
    await setCash(p.sub, 1_000_000);
    expect((await api.call(p, 'POST', '/v1/homes/move', { kind: 'parents_basement' })).status).toBe(
      200,
    );
    const full = await api.call(p, 'POST', '/v1/homes/move', { kind: 'penthouse' });
    expect(full.status).toBe(409);
    expect(errDetails(full)).toMatchObject({ reason: 'no_unit_free', tier: 'penthouse' });
    // Rolled back: still in the basement, charged only the first week.
    const live = await db().withConnection((c) =>
      c.query(`SELECT kind FROM homes WHERE owner_user_id = $1 AND status = 'active'`, [p.sub]),
    );
    expect(live.rows).toEqual([{ kind: 'parents_basement' }]);
    expect(await cashOf(p.sub)).toBe(1_000_000 - 2_000);
    await db().withConnection((c) =>
      c.query(`DELETE FROM homes WHERE owner_user_id = $1`, [holder.sub]),
    );
  });

  it('validates the kind and replays the same Idempotency-Key once', async () => {
    const p = await api.player();
    await setCash(p.sub, 100_000);
    expect((await api.call(p, 'POST', '/v1/homes/move', { kind: 'castle' })).status).toBe(400);
    expect((await api.call(p, 'POST', '/v1/homes/move', {})).status).toBe(400);
    expect((await api.call(null, 'POST', '/v1/homes/move', { kind: 'studio' })).status).toBe(401);

    const headers = {
      authorization: `Bearer ${p.accessToken}`,
      'idempotency-key': crypto.randomUUID(),
    };
    const a = await api.app.inject({
      method: 'POST',
      url: '/v1/homes/move',
      headers,
      payload: { kind: 'parents_basement' },
    });
    const b = await api.app.inject({
      method: 'POST',
      url: '/v1/homes/move',
      headers,
      payload: { kind: 'parents_basement' },
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    expect(await cashOf(p.sub)).toBe(100_000 - 2_000);
  });
});

describe('POST /v1/homes/move gates', () => {
  it('answers 503 CAPABILITY_OFF while homeMove is off', async () => {
    const off = await bootApi('', { LIVE_PHASE: '6' });
    try {
      const p = await off.player();
      const r = await off.call(p, 'POST', '/v1/homes/move', { kind: 'studio' });
      expect(r.status).toBe(503);
      expect(errCode(r)).toBe('CAPABILITY_OFF');
      expect(errDetails(r)).toEqual({ capability: 'homeMove' });
    } finally {
      await off.stop();
    }
  });

  it('answers 403 phase_locked before homes open (LIVE_PHASE < 4)', async () => {
    const early = await bootApi('homeMove', { LIVE_PHASE: '3' });
    try {
      const p = await early.player();
      const r = await early.call(p, 'POST', '/v1/homes/move', { kind: 'studio' });
      expect(r.status).toBe(403);
      expect(errDetails(r)).toMatchObject({ reason: 'phase_locked' });
    } finally {
      await early.stop();
    }
  });
});
