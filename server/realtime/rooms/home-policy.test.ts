/**
 * Home room and the visitor policy (unlock D2): joining a closed home fails
 * with HOME_CLOSED, a followers-only home with FORBIDDEN, and a visitor
 * already inside is shown out (4403) once the owner closes the home.
 * Driven directly (no matchmaker), like home.test.ts.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { LocalPresence } from 'colyseus';
import { Encoder, type Schema } from '@colyseus/schema';
import { buildContext, _resetContextForTests } from '../../application/context.js';
import { _resetConfigForTests } from '../../shared/config/config.js';
import { uuidv7 } from '../../shared/domain/uuid.js';
import { createHome } from '../../application/homes.js';
import { putHomeSettings } from '../../application/home-settings.js';

loadDotenv({ path: process.cwd() + '/.env' });
process.env.ENABLE_DEV_AUTH = 'true';
_resetConfigForTests();
_resetContextForTests();

const { HomeRoom } = await import('./home.js');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const owner = uuidv7();
const visitor = uuidv7();
const fan = uuidv7();

function fakeClient(sessionId: string): {
  sessionId: string;
  left: number | null;
  send: () => void;
  leave: (code: number) => void;
} {
  const c = {
    sessionId,
    left: null as number | null,
    send: () => undefined,
    leave: (code: number) => {
      c.left = code;
    },
  };
  return c;
}

beforeAll(async () => {
  for (const id of [owner, visitor, fan]) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `hp-${id}`]);
  }
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)`, [owner]);
  await pool.query(`INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2)`, [
    fan,
    owner,
  ]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM homes WHERE owner_user_id = $1`, [owner]);
  await pool.end();
});

describe('HomeRoom visitor policy', () => {
  it('refuses joins by policy and shows a visitor out when the home closes', async () => {
    const ctx = buildContext();
    // A basement has no door, so only the policy decides.
    const home = await createHome(ctx, owner, 'parents_basement');
    expect(home.unitId).toBeNull();

    const presence = new LocalPresence();
    const room = new HomeRoom() as unknown as Record<string, any>;
    room.presence = presence;
    await room.onCreate({ homeId: home.homeId, ownerId: owner });
    new Encoder(room.state as Schema);

    const v = fakeClient('s-visitor');
    room.clients.push(v);
    await room.onJoin(v, { userId: visitor }); // open: fine

    await putHomeSettings(ctx, owner, 'closed');
    await room.recheck();
    expect(v.left).toBe(4403);
    await expect(room.onJoin(fakeClient('s2'), { userId: visitor })).rejects.toThrow('HOME_CLOSED');
    await room.onJoin(fakeClient('s-owner'), { userId: owner }); // the owner always

    await putHomeSettings(ctx, owner, 'followers');
    await expect(room.onJoin(fakeClient('s3'), { userId: visitor })).rejects.toThrow('FORBIDDEN');
    await room.onJoin(fakeClient('s-fan'), { userId: fan });

    await room.onDispose();
  });
});
