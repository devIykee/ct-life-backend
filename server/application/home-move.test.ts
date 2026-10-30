/**
 * moveHome (unlock D1): one live lease after any number of moves, even
 * concurrent ones; the first week is debited once per move; a refused move
 * changes nothing.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ConflictError, ForbiddenError, InsufficientCashError } from '../shared/domain/errors.js';
import { HOMES_PHASE, moveHome } from './home-move.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ctx: AppContext;
const users: string[] = [];

async function newUser(cash: number): Promise<string> {
  const id = uuidv7();
  users.push(id);
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `move-${id}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)`, [id, cash]);
  return id;
}

async function liveKinds(userId: string): Promise<string[]> {
  const r = await pool.query<{ kind: string }>(
    `SELECT kind FROM homes WHERE owner_user_id = $1 AND status IN ('active', 'overdue')`,
    [userId],
  );
  return r.rows.map((x) => x.kind);
}

async function cash(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents);
}

beforeAll(() => {
  const base = buildContext();
  // Homes open at phase 4; the .env may run an earlier phase.
  ctx = { ...base, config: { ...base.config, livePhase: 6 } };
});

afterAll(async () => {
  await pool.query(`DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[])`, [users]);
  await pool.end();
});

describe('moveHome', () => {
  it('ends the overdue lease too, and writes one rent ledger row for the move', async () => {
    const u = await newUser(100_000);
    await moveHome(ctx, u, 'parents_basement');
    await pool.query(
      `UPDATE homes SET status = 'overdue', missed_weeks = 1 WHERE owner_user_id = $1`,
      [u],
    );
    const out = await moveHome(ctx, u, 'hacker_house');
    expect(out.home.kind).toBe('hacker_house');
    expect(await liveKinds(u)).toEqual(['hacker_house']);
    const ledger = await pool.query(
      `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = 'rent' AND ref_id = $2`,
      [u, out.home.homeId],
    );
    expect(ledger.rows).toEqual([{ delta_cents: '-6000' }]);
    expect(await cash(u)).toBe(100_000 - 2_000 - 6_000);
  });

  it('serializes two concurrent moves: one live lease, both weeks paid', async () => {
    const u = await newUser(100_000);
    const results = await Promise.allSettled([
      moveHome(ctx, u, 'parents_basement'),
      moveHome(ctx, u, 'hacker_house'),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await liveKinds(u)).toHaveLength(1);
    expect(await cash(u)).toBe(100_000 - 2_000 - 6_000);
  });

  it('refuses same_home, too little Cash and an early phase without changing anything', async () => {
    const u = await newUser(3_000);
    await moveHome(ctx, u, 'parents_basement');
    await expect(moveHome(ctx, u, 'parents_basement')).rejects.toBeInstanceOf(ConflictError);
    await expect(moveHome(ctx, u, 'studio')).rejects.toBeInstanceOf(InsufficientCashError);
    const early = { ...ctx, config: { ...ctx.config, livePhase: HOMES_PHASE - 1 } };
    await expect(moveHome(early, u, 'hacker_house')).rejects.toBeInstanceOf(ForbiddenError);
    expect(await liveKinds(u)).toEqual(['parents_basement']);
    expect(await cash(u)).toBe(1_000);
  });
});
