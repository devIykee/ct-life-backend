/**
 * gm streak and daily chest tests, with a controlled clock: every service call takes the
 * `now` the test chooses, and the dates are in 2090 so no real data is touched.
 */
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { FreezeLimitReachedError, InsufficientCashError } from '../shared/domain/errors.js';
import {
  buyFreeze,
  chestCashCents,
  claimDaily,
  FREEZE_PRICE_CENTS,
  getDailyStatus,
} from './daily-streak.js';
import { listLedger } from './bank.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

const day = (n: number, hour = 12): Date => new Date(Date.UTC(2090, 2, n, hour, 0, 0));

let user: string;

async function cash(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? 0);
}

beforeEach(async () => {
  user = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [user, `streak-${user}`]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)`, [user]);
});

afterAll(async () => {
  await pool.end();
});

describe('gm streak', () => {
  it('a new player has no streak, and the day 1 chest on offer', async () => {
    const s = await getDailyStatus(ctx, user, day(1));
    expect(s.streakDay).toBe(0);
    expect(s.claimedToday).toBe(false);
    expect(s.chest.day).toBe(1);
    expect(s.chest.rewards.cashCents).toBe(chestCashCents(1));
    expect(s.freezes).toBe(0);
    expect(s.nextResetAt).toBe('2090-03-02T00:00:00.000Z');
  });

  it('goes from day 1 to day 2 on consecutive UTC days, paying Cash and a daily_streak ledger row', async () => {
    const a = await claimDaily(ctx, user, day(1, 23));
    expect(a.alreadyClaimed).toBe(false);
    expect(a.claimed.day).toBe(1);
    expect(a.streakDay).toBe(1);
    expect(a.claimedToday).toBe(true);
    expect(a.chest.day).toBe(2);
    expect(await cash(user)).toBe(chestCashCents(1));

    // One minute past midnight UTC is a new day, however little real time passed.
    const b = await claimDaily(ctx, user, new Date(Date.UTC(2090, 2, 2, 0, 1)));
    expect(b.claimed.day).toBe(2);
    expect(b.streakDay).toBe(2);
    expect(b.reset).toBe(false);
    expect(await cash(user)).toBe(chestCashCents(1) + chestCashCents(2));

    const rows = await pool.query(
      `SELECT delta_cents, reason FROM ledger_entries WHERE user_id = $1 ORDER BY id`,
      [user],
    );
    expect(rows.rows.map((r) => r.reason)).toEqual(['daily_streak', 'daily_streak']);
    const ledger = await listLedger(ctx, user, null, 10);
    expect(ledger.items[0]!.label).toBe('Daily streak chest');
  });

  it('claiming twice on the same UTC day pays once and replays the first claim', async () => {
    const a = await claimDaily(ctx, user, day(5, 1));
    const b = await claimDaily(ctx, user, day(5, 23));
    expect(b.alreadyClaimed).toBe(true);
    expect(b.claimed).toEqual(a.claimed);
    expect(b.streakDay).toBe(1);
    expect(await cash(user)).toBe(chestCashCents(1));
    const n = await pool.query(`SELECT count(*) AS n FROM ledger_entries WHERE user_id = $1`, [
      user,
    ]);
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it('concurrent claims on the same day pay once', async () => {
    const results = await Promise.all([
      claimDaily(ctx, user, day(6)),
      claimDaily(ctx, user, day(6)),
      claimDaily(ctx, user, day(6)),
    ]);
    expect(results.filter((r) => !r.alreadyClaimed)).toHaveLength(1);
    expect(await cash(user)).toBe(chestCashCents(1));
  });

  it('resets to day 1 after a missed day', async () => {
    await claimDaily(ctx, user, day(10));
    await claimDaily(ctx, user, day(11));
    // Skip the 12th; the status already shows the broken streak.
    const s = await getDailyStatus(ctx, user, day(13));
    expect(s.streakDay).toBe(0);
    expect(s.chest.day).toBe(1);
    const c = await claimDaily(ctx, user, day(13));
    expect(c.reset).toBe(true);
    expect(c.claimed.day).toBe(1);
    expect(c.streakDay).toBe(1);
  });

  it('consumes a streak freeze automatically for one missed day', async () => {
    await pool.query(`INSERT INTO login_streaks (user_id) VALUES ($1)`, [user]);
    await pool.query(`UPDATE balances SET cash_cents = $2 WHERE user_id = $1`, [
      user,
      FREEZE_PRICE_CENTS * 2,
    ]);
    await buyFreeze(ctx, user, day(19));
    await claimDaily(ctx, user, day(20));
    await claimDaily(ctx, user, day(21));
    const before = await getDailyStatus(ctx, user, day(23));
    expect(before.freezes).toBe(1);
    expect(before.streakDay).toBe(2); // the 22nd was missed but is covered
    const c = await claimDaily(ctx, user, day(23));
    expect(c.reset).toBe(false);
    expect(c.freezesUsed).toBe(1);
    expect(c.claimed.day).toBe(3);
    expect(c.freezes).toBe(0);
  });

  it('does not spend a freeze that cannot cover every missed day', async () => {
    await pool.query(`UPDATE balances SET cash_cents = $2 WHERE user_id = $1`, [
      user,
      FREEZE_PRICE_CENTS,
    ]);
    await buyFreeze(ctx, user, day(1));
    await claimDaily(ctx, user, day(2));
    const c = await claimDaily(ctx, user, day(5)); // missed the 3rd and 4th, one freeze
    expect(c.reset).toBe(true);
    expect(c.freezesUsed).toBe(0);
    expect(c.freezes).toBe(1);
    expect(c.claimed.day).toBe(1);
  });

  it('sells freezes for Cash, at most 2, and refuses when short', async () => {
    await expect(buyFreeze(ctx, user, day(1))).rejects.toBeInstanceOf(InsufficientCashError);
    await pool.query(`UPDATE balances SET cash_cents = $2 WHERE user_id = $1`, [
      user,
      FREEZE_PRICE_CENTS * 3,
    ]);
    expect((await buyFreeze(ctx, user, day(1))).freezes).toBe(1);
    expect((await buyFreeze(ctx, user, day(1))).freezes).toBe(2);
    await expect(buyFreeze(ctx, user, day(1))).rejects.toBeInstanceOf(FreezeLimitReachedError);
    expect(await cash(user)).toBe(FREEZE_PRICE_CENTS);
    const r = await pool.query(
      `SELECT reason, delta_cents FROM ledger_entries WHERE user_id = $1 ORDER BY id`,
      [user],
    );
    expect(r.rows.map((x) => [x.reason, Number(x.delta_cents)])).toEqual([
      ['streak_freeze', -FREEZE_PRICE_CENTS],
      ['streak_freeze', -FREEZE_PRICE_CENTS],
    ]);
  });

  it('grants the day 7 cosmetic once through the inventory with source grant', async () => {
    await pool.query(
      `INSERT INTO login_streaks (user_id, streak_day, best_streak, last_claim_date)
       VALUES ($1, 6, 6, '2090-03-27')`,
      [user],
    );
    const preview = await getDailyStatus(ctx, user, day(28));
    expect(preview.chest.day).toBe(7);
    expect(preview.chest.rewards.cosmetic?.itemKey).toBe('head_cap_black');
    const c = await claimDaily(ctx, user, day(28));
    expect(c.claimed.day).toBe(7);
    expect(c.claimed.rewards.cosmetic?.itemKey).toBe('head_cap_black');
    const inv = await pool.query(
      `SELECT i.source, it.item_key FROM cosmetic_inventory i JOIN cosmetic_items it USING (item_id)
        WHERE i.user_id = $1`,
      [user],
    );
    expect(inv.rows).toEqual([{ source: 'grant', item_key: 'head_cap_black' }]);
    // A replay does not grant or pay again.
    const again = await claimDaily(ctx, user, day(28));
    expect(again.alreadyClaimed).toBe(true);
    expect(again.claimed.rewards.cosmetic?.itemKey).toBe('head_cap_black');
    const count = await pool.query(
      `SELECT count(*) AS n FROM cosmetic_inventory WHERE user_id = $1`,
      [user],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });
});
