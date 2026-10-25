/**
 * PATCH /characters/me/look: ownership of cosmetics is checked server-side,
 * slots must match, palettes still apply, an unchanged slot is left alone.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  ItemNotOwnedError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { updateLook } from './character.js';
import { ensureCatalog, grantCosmetic } from './cosmetics.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

const BASE = {
  skinTone: 'skin_tone3',
  headId: 'head_ubc_m',
  hairId: 'hair_ubc_m',
  topId: 'top_ubc_m',
  bottomId: 'bottom_ubc_m',
  shoesId: 'shoes_ubc_m',
  accId: 'acc_none',
};

let n = 0;
async function newPlayer(look: Record<string, string> = BASE): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `look-${id}`]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
     VALUES ($1, $2, $3, $4, 'degens', '{}', 'x', 'h')`,
    [uuidv7(), id, `lk${Date.now().toString(36)}${n++}`, look],
  );
  return id;
}
async function grant(userId: string, key: string): Promise<void> {
  const c = await pool.connect();
  try {
    await grantCosmetic(c, userId, key);
  } finally {
    c.release();
  }
}
const lookOf = async (id: string): Promise<Record<string, string>> =>
  (await pool.query(`SELECT look FROM characters WHERE user_id = $1`, [id])).rows[0].look;

beforeAll(async () => {
  await ensureCatalog(ctx);
});
afterAll(async () => {
  await pool.end();
});

describe('updateLook', () => {
  it('equips an owned grant-only cosmetic (the Breakpoint lanyard) and returns the character', async () => {
    const u = await newPlayer();
    await grant(u, 'lanyard_breakpoint_2026');
    const res = await updateLook(ctx, u, { accId: 'lanyard_breakpoint_2026' });
    expect(res.look).toEqual({ ...BASE, accId: 'lanyard_breakpoint_2026' });
    expect(res).toMatchObject({ tribeId: 'degens', homeId: 'h', likenessJobId: null });
    expect(await lookOf(u)).toEqual({ ...BASE, accId: 'lanyard_breakpoint_2026' });
    const back = await updateLook(ctx, u, { accId: 'acc_none' });
    expect(back.look.accId).toBe('acc_none');
  });

  it('refuses a cosmetic the player does not own, and changes nothing', async () => {
    const u = await newPlayer();
    const other = await newPlayer();
    await grant(other, 'lanyard_breakpoint_2026'); // someone else owning it does not help
    for (const accId of [
      'lanyard_breakpoint_2026',
      'lanyard_breakpoint_2026_gold',
      'acc_pickaxe',
    ]) {
      await expect(updateLook(ctx, u, { accId })).rejects.toBeInstanceOf(ItemNotOwnedError);
    }
    await expect(updateLook(ctx, u, { topId: 'top_hoodie_black' })).rejects.toBeInstanceOf(
      ItemNotOwnedError,
    );
    expect(await lookOf(u)).toEqual(BASE);
  });

  it('checks the slot: a lanyard is not a top', async () => {
    const u = await newPlayer();
    await grant(u, 'lanyard_breakpoint_2026');
    await expect(updateLook(ctx, u, { topId: 'lanyard_breakpoint_2026' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    expect(await lookOf(u)).toEqual(BASE);
  });

  it('equips an owned shop cosmetic in its slot', async () => {
    const u = await newPlayer();
    await grant(u, 'top_hoodie_black');
    const res = await updateLook(ctx, u, { topId: 'top_hoodie_black' });
    expect(res.look.topId).toBe('top_hoodie_black');
  });

  it('still applies the palette rules to base items', async () => {
    const u = await newPlayer();
    await expect(updateLook(ctx, u, { hairId: 'hair_ubc_f' })).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
    const ok = await updateLook(ctx, u, { hairId: 'hair_ubc_m__blue' });
    expect(ok.look.hairId).toBe('hair_ubc_m__blue');
    expect(await lookOf(u)).toMatchObject({ hairId: 'hair_ubc_m__blue' });
  });

  it('leaves a slot that is not changing alone, even if its item is an unowned catalogue id', async () => {
    // A creation look can name a shop item without owning it; changing the
    // accessory must not trip over it.
    const legacy = {
      skinTone: 'tan',
      headId: 'head_legacy',
      hairId: 'hair_legacy',
      topId: 'top_hoodie_black',
      bottomId: 'bottom_legacy',
      shoesId: 'shoes_legacy',
      accId: 'acc_none',
    };
    const u = await newPlayer(legacy);
    await grant(u, 'lanyard_breakpoint_2026');
    const res = await updateLook(ctx, u, { accId: 'lanyard_breakpoint_2026' });
    expect(res.look.topId).toBe('top_hoodie_black');
    expect(res.look.accId).toBe('lanyard_breakpoint_2026');
    await expect(updateLook(ctx, u, { topId: 'top_tshirt_white' })).rejects.toBeInstanceOf(
      ItemNotOwnedError,
    );
  });

  it('is a no-op for an identical look and 404s without a character', async () => {
    const u = await newPlayer();
    expect((await updateLook(ctx, u, { accId: 'acc_none' })).look).toEqual(BASE);
    const none = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [none, `look-${none}`]);
    await expect(updateLook(ctx, none, { accId: 'acc_none' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
