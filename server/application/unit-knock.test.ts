/**
 * knockUnit: the hourly budget is one per player across both knock routes,
 * a silent (blocked) door knock spends it like any other, and the message
 * names the occupant's home only to the occupant.
 */
import { Pool } from 'pg';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { NotFoundError, RateLimitedError } from '../shared/domain/errors.js';
import { createHome } from './homes.js';
import { knock, knockUnit } from './home-knock.js';
import { USER_CHANNEL, type UserMessage } from './realtime-bus.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ctx: AppContext;
let sub: IORedis;
const got: UserMessage[] = [];
const owners: string[] = [];
const units: string[] = [];
const knocker = uuidv7();

async function user(id: string): Promise<void> {
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `uk-${id}`]);
}

beforeAll(async () => {
  ctx = buildContext();
  sub = new IORedis(process.env.REDIS_URL!);
  await sub.subscribe(USER_CHANNEL);
  sub.on('message', (_c, raw) => got.push(JSON.parse(raw) as UserMessage));
  await user(knocker);
  for (let i = 0; i < 11; i++) {
    const o = uuidv7();
    owners.push(o);
    await user(o);
    await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)`, [o]);
    await createHome(ctx, o, 'parents_basement');
    const unitId = `test:unit_knock_svc:${uuidv7()}`;
    units.push(unitId);
    await pool.query(
      `INSERT INTO home_units (unit_id, district, tier, room_type, weekly_rent_cents, capacity)
       VALUES ($1, 'residences', 'flat', 'test_room', 50000, 2)`,
      [unitId],
    );
    await pool.query(
      `UPDATE homes SET unit_id = $1 WHERE owner_user_id = $2 AND status IN ('active', 'overdue')`,
      [unitId, o],
    );
  }
  // The last occupant blocked the knocker.
  await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
    owners[9],
    knocker,
  ]);
});

afterAll(async () => {
  await sub.quit();
  await pool.query(`DELETE FROM blocks WHERE blocked_user_id = $1`, [knocker]);
  await pool.query(`DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[])`, [owners]);
  await pool.query(`DELETE FROM home_units WHERE unit_id = ANY($1::text[])`, [units]);
  await pool.end();
});

describe('knockUnit', () => {
  it('shares the hourly budget with profile knocks, and a silent knock spends it', async () => {
    for (const o of owners.slice(0, 5)) await knock(ctx, knocker, o);
    for (const u of units.slice(5, 10)) await knockUnit(ctx, knocker, u); // the 10th is blocked: silent
    await expect(knockUnit(ctx, knocker, units[10]!)).rejects.toMatchObject({
      details: { reason: 'knock_limit' },
    });
    await expect(knockUnit(ctx, knocker, units[10]!)).rejects.toBeInstanceOf(RateLimitedError);
    await new Promise((r) => setTimeout(r, 150));
    const mine = got.filter((m) => m.type === 'home_knock' && m.payload.fromUserId === knocker);
    expect(mine).toHaveLength(9); // 5 profile + 4 doors; the blocked occupant heard nothing
    expect(mine.map((m) => m.userId)).not.toContain(owners[9]);
    expect(mine.every((m) => owners.includes(m.userId))).toBe(true);
  });

  it('is 404 for a door that is not in the units table', async () => {
    await expect(knockUnit(ctx, uuidv7(), 'flat:nowhere:0')).rejects.toBeInstanceOf(NotFoundError);
  });
});
