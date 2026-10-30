/**
 * knock (unlock D5): the hourly limit per player, and the owner's alias in
 * the message comes from the knocker's character.
 */
import { Pool } from 'pg';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { RateLimitedError } from '../shared/domain/errors.js';
import { createHome } from './homes.js';
import { knock } from './home-knock.js';
import { USER_CHANNEL, type UserMessage } from './realtime-bus.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ctx: AppContext;
let sub: IORedis;
const got: UserMessage[] = [];
const owners: string[] = [];
const knocker = uuidv7();

beforeAll(async () => {
  ctx = buildContext();
  sub = new IORedis(process.env.REDIS_URL!);
  await sub.subscribe(USER_CHANNEL);
  sub.on('message', (_c, raw) => got.push(JSON.parse(raw) as UserMessage));
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [knocker, `kn-${knocker}`]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
     VALUES ($1, $2, $3, '{}'::jsonb, 'degen', '{}', 'dream', 'parents_basement')`,
    [uuidv7(), knocker, `knocky_${knocker.slice(-8)}`],
  );
  for (let i = 0; i < 11; i++) {
    const o = uuidv7();
    owners.push(o);
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [o, `ko-${o}`]);
    await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)`, [o]);
    await createHome(ctx, o, 'parents_basement');
  }
});

afterAll(async () => {
  await sub.quit();
  await pool.query(`DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[])`, [owners]);
  await pool.end();
});

describe('knock', () => {
  it('allows 10 knocks an hour, carries the alias, then refuses with knock_limit', async () => {
    for (const o of owners.slice(0, 10)) await knock(ctx, knocker, o);
    await expect(knock(ctx, knocker, owners[10]!)).rejects.toBeInstanceOf(RateLimitedError);
    await expect(knock(ctx, knocker, owners[10]!)).rejects.toMatchObject({
      details: { reason: expect.stringMatching(/knock_(limit|cooldown)/) },
    });
    await new Promise((r) => setTimeout(r, 150));
    const mine = got.filter((m) => m.type === 'home_knock' && m.payload.fromUserId === knocker);
    expect(mine).toHaveLength(10);
    expect(mine[0]!.payload.alias).toBe(`knocky_${knocker.slice(-8)}`);
  });
});
