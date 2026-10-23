/**
 * Home room revocation: a guest who is removed, or an owner who moves out,
 * is shown out of a room they are already in. Driven directly (no
 * matchmaker) with an in-memory presence standing in for Redis.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { LocalPresence } from 'colyseus';
import { Encoder, type Schema } from '@colyseus/schema';
import { buildContext, _resetContextForTests } from '../../application/context.js';
import { _resetConfigForTests } from '../../shared/config/config.js';
import { uuidv7 } from '../../shared/domain/uuid.js';
import { addGuest, createHome, moveOut } from '../../application/homes.js';
import { HOME_ACCESS_CHANNEL } from '../../application/home-units.js';

loadDotenv({ path: process.cwd() + '/.env' });
process.env.ENABLE_DEV_AUTH = 'true';
_resetConfigForTests();
_resetContextForTests();

const { HomeRoom } = await import('./home.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const UNIT = 'test:home_room:0';
const owner = uuidv7();
const guest = uuidv7();

interface FakeClient {
  sessionId: string;
  left: number | null;
  send: (t: string, p: unknown) => void;
  leave: (code: number) => void;
}
function fakeClient(sessionId: string): FakeClient {
  const c: FakeClient = {
    sessionId,
    left: null,
    send: () => undefined,
    leave: (code) => {
      c.left = code;
    },
  };
  return c;
}

async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM homes WHERE unit_id = $1`, [UNIT]);
  await pool.query(`DELETE FROM home_units WHERE unit_id = $1`, [UNIT]);
}

beforeAll(async () => {
  await cleanup();
  for (const id of [owner, guest]) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `hr-${id}`]);
  }
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 1000000)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = 1000000`,
    [owner],
  );
  await pool.query(
    `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
     VALUES ($1, 'residences', 'penthouse', 'test_room', 150000, 3)`,
    [UNIT],
  );
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe('HomeRoom revocation', () => {
  it('shows out a removed guest and a moved-out owner when access changes', async () => {
    const ctx = buildContext();
    const home = await createHome(ctx, owner, 'penthouse');
    expect(home.unitId).toBe(UNIT);
    await addGuest(ctx, home.homeId, owner, guest);

    const presence = new LocalPresence();
    const room = new HomeRoom() as unknown as Record<string, any>;
    room.presence = presence;
    await room.onCreate({ homeId: home.homeId, ownerId: owner });
    new Encoder(room.state as Schema);

    const a = fakeClient('s-owner');
    const b = fakeClient('s-guest');
    for (const [c, userId] of [
      [a, owner],
      [b, guest],
    ] as const) {
      room.clients.push(c);
      await room.onJoin(c, { userId });
    }

    // Nothing changed: nobody is shown out.
    await presence.publish(HOME_ACCESS_CHANNEL, { homeId: home.homeId });
    await new Promise((r) => setTimeout(r, 200));
    expect([a.left, b.left]).toEqual([null, null]);

    // An event for another home is ignored even when access is gone.
    await pool.query(`DELETE FROM home_guests WHERE home_id = $1`, [home.homeId]);
    await presence.publish(HOME_ACCESS_CHANNEL, { homeId: 'home:other' });
    await new Promise((r) => setTimeout(r, 200));
    expect(b.left).toBeNull();

    // The guest was removed: the event shows the guest out, not the owner.
    await presence.publish(HOME_ACCESS_CHANNEL, { homeId: home.homeId });
    await new Promise((r) => setTimeout(r, 200));
    expect(b.left).toBe(4403);
    expect(a.left).toBeNull();

    // The interval backstop does the same without an event.
    await moveOut(ctx, home.homeId, owner);
    await room.recheck();
    expect(a.left).toBe(4403);

    await room.onDispose();
  });
});
