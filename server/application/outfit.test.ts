/**
 * The server-set `outfit` on PlayerState: crew outfit while a Rekt Burger shift is open (or the
 * uniform is equipped), published to the rooms on every change, never client-settable.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { computeOutfit, OUTFIT_REKT_BURGER_CREW } from '../shared/domain/outfit.js';
import { encodePos, OUTFIT_CHANNEL, POS_HASH } from '../realtime/movement.js';
import { loadPlayerState } from '../realtime/player.js';
import { refreshOutfit } from './realtime-bus.js';
import { endShift, leaveJob, rektConfig, startShift, sweepRektShifts } from './rekt-burger.js';
import { updateLook } from './character.js';
import { ensureCatalog, grantCosmetic } from './cosmetics.js';
import { ensureRewardCatalog } from './rewards.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const cfg = rektConfig(ctx);
const T0 = new Date('2025-06-10T10:00:00Z');
const at = (sec: number): Date => new Date(T0.getTime() + sec * 1000);

// Record what the api publishes (a plain wrapper: ioredis commands do not survive vi.spyOn).
const publishCalls: unknown[][] = [];
const redisMain = ctx.redis.main as unknown as { publish: (...a: unknown[]) => unknown };
const realPublish = redisMain.publish.bind(redisMain);
redisMain.publish = (...a: unknown[]) => {
  publishCalls.push(a);
  return realPublish(...a);
};
const published = (userId: string): Array<string | null> =>
  publishCalls
    .filter((c) => c[0] === OUTFIT_CHANNEL)
    .map((c) => JSON.parse(String(c[1])) as { userId: string; outfit: string | null })
    .filter((m) => m.userId === userId)
    .map((m) => m.outfit);

beforeEach(() => {
  publishCalls.length = 0;
});
afterAll(async () => {
  await pool.end();
});

const BASE = {
  skinTone: 'tan',
  headId: 'head_a',
  hairId: 'hair_a',
  topId: 'top_a',
  bottomId: 'bottom_a',
  shoesId: 'shoes_a',
  accId: 'acc_none',
};

async function newPlayer(look: Record<string, string> = BASE): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `of-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 72000)`, [
    id,
  ]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
     VALUES ($1, $2, $3, $4, 'trencher', '{}', 'x', 'h')`,
    [uuidv7(), id, `of${id.slice(-12)}`, look],
  );
  return id;
}
const stand = (u: string, base: Date) =>
  ctx.redis.main.hset(
    POS_HASH,
    u,
    encodePos({ x: cfg.counter.x, z: cfg.counter.z, at: base.getTime() }),
  );

describe('computeOutfit', () => {
  it('is the crew outfit on shift or with the uniform owned and equipped, else none', () => {
    expect(computeOutfit(true, false)).toBe(OUTFIT_REKT_BURGER_CREW);
    expect(computeOutfit(false, true)).toBe(OUTFIT_REKT_BURGER_CREW);
    expect(computeOutfit(false, false)).toBeNull();
  });
});

describe('loadPlayerState', () => {
  it('has no outfit by default and the crew outfit while a shift is open', async () => {
    const u = await newPlayer();
    expect((await loadPlayerState(u)).outfit).toBeUndefined();
    await stand(u, T0);
    await startShift(ctx, u, T0);
    expect((await loadPlayerState(u)).outfit).toBe('rekt_burger_crew');
    await endShift(ctx, u, at(600));
    expect((await loadPlayerState(u)).outfit).toBeUndefined();
  });

  async function own(u: string): Promise<void> {
    await ensureCatalog(ctx);
    await ensureRewardCatalog(ctx.db);
    const c = await pool.connect();
    try {
      await grantCosmetic(c, u, 'reward_rekt_burger_uniform');
    } finally {
      c.release();
    }
  }

  it('shows the crew outfit when the uniform is owned and in its slot (topId)', async () => {
    const u = await newPlayer({ ...BASE, topId: 'reward_rekt_burger_uniform' });
    await own(u);
    expect((await loadPlayerState(u)).outfit).toBe('rekt_burger_crew');
  });

  it('REGRESSION: the key in any other look field, or in topId without owning it, shows nothing', async () => {
    const key = 'reward_rekt_burger_uniform';
    // Owned, but crafted into fields that are not the uniform's slot.
    const owner = await newPlayer({
      ...BASE,
      skinTone: key,
      hairId: key,
      accId: key,
      shoesId: key,
    });
    await own(owner);
    expect((await loadPlayerState(owner)).outfit).toBeUndefined();
    // In the right slot, but never owned (creation accepts unknown ids as a base look).
    const thief = await newPlayer({ ...BASE, topId: key });
    expect((await loadPlayerState(thief)).outfit).toBeUndefined();
    // And the live path (refreshOutfit) decides the same way.
    publishCalls.length = 0;
    await refreshOutfit(ctx, thief);
    await refreshOutfit(ctx, owner);
    expect(published(thief)).toEqual([null]);
    expect(published(owner)).toEqual([null]);
    // A legacy array look is read at its top index only.
    const legacy = await newPlayer(BASE);
    await pool.query(`UPDATE characters SET look = $2::jsonb WHERE user_id = $1`, [
      legacy,
      JSON.stringify(['tan', key, 'h', 't', 'b', 's', 'a']),
    ]);
    await own(legacy);
    expect((await loadPlayerState(legacy)).outfit).toBeUndefined();
    await pool.query(`UPDATE characters SET look = $2::jsonb WHERE user_id = $1`, [
      legacy,
      JSON.stringify(['tan', 'h', 'h', key, 'b', 's', 'a']),
    ]);
    expect((await loadPlayerState(legacy)).outfit).toBe('rekt_burger_crew');
  });
});

describe('PATCH look refuses item keys in non-item fields', () => {
  it('rejects a catalogue or cosmetic key as skinTone, and a uniform in the wrong slot', async () => {
    const u = await newPlayer();
    await ensureCatalog(ctx);
    await ensureRewardCatalog(ctx.db);
    const c = await pool.connect();
    try {
      await grantCosmetic(c, u, 'reward_rekt_burger_uniform');
    } finally {
      c.release();
    }
    for (const skinTone of [
      'reward_rekt_burger_uniform',
      'top_hoodie_black',
      'lanyard_breakpoint_2026',
    ]) {
      await expect(updateLook(ctx, u, { skinTone })).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'look_item_in_non_item_field', field: 'skinTone' },
      });
    }
    // Owned, but in a slot it does not occupy.
    for (const field of ['hairId', 'accId', 'shoesId', 'headId', 'bottomId'] as const) {
      await expect(
        updateLook(ctx, u, { [field]: 'reward_rekt_burger_uniform' }),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    // A normal tone still works.
    expect((await updateLook(ctx, u, { skinTone: 'brown' })).look.skinTone).toBe('brown');
  });
});

describe('the api publishes every change to the rooms', () => {
  it('clock in publishes the crew outfit; clock out clears it', async () => {
    const u = await newPlayer();
    await stand(u, T0);
    await startShift(ctx, u, T0);
    expect(published(u)).toEqual(['rekt_burger_crew']);
    // Resuming the open shift (a second start) changes nothing and publishes nothing.
    await startShift(ctx, u, at(30));
    expect(published(u)).toEqual(['rekt_burger_crew']);
    await endShift(ctx, u, at(600));
    expect(published(u)).toEqual(['rekt_burger_crew', null]);
  });

  it('auto-close (the sweep) and leaving the job clear it too', async () => {
    const a = await newPlayer();
    await stand(a, T0);
    await startShift(ctx, a, T0);
    await sweepRektShifts(ctx, at(5 * 3600));
    expect(published(a)).toEqual(['rekt_burger_crew', null]);

    const b = await newPlayer();
    await stand(b, T0);
    await startShift(ctx, b, T0);
    await leaveJob(ctx, b, at(600));
    expect(published(b)).toEqual(['rekt_burger_crew', null]);
  });

  it('equipping the uniform publishes the crew outfit; taking it off clears it', async () => {
    await ensureCatalog(ctx);
    await ensureRewardCatalog(ctx.db);
    const u = await newPlayer();
    const c = await pool.connect();
    try {
      await grantCosmetic(c, u, 'reward_rekt_burger_uniform');
    } finally {
      c.release();
    }
    const slot = (
      await pool.query(
        `SELECT slot FROM cosmetic_items WHERE item_key = 'reward_rekt_burger_uniform'`,
      )
    ).rows[0]?.slot as string | undefined;
    expect(slot).toBeDefined();
    const field = `${slot as string}Id` as 'topId';
    await updateLook(ctx, u, { [field]: 'reward_rekt_burger_uniform' });
    expect(published(u).at(-1)).toBe('rekt_burger_crew');
    await updateLook(ctx, u, { [field]: BASE[field] });
    expect(published(u).at(-1)).toBeNull();
  });
});
