/**
 * gm streak and daily chest.
 *
 *   GET  /v1/daily/status   today's state: the streak, whether today's chest is taken,
 *                           when the day resets, the freezes held, and the chest on offer
 *   POST /v1/daily/claim    claim today's chest (idempotent per UTC day)
 *   POST /v1/daily/freeze   buy a streak freeze with Cash (at most 2 held)
 *
 * Time. Days are UTC dates and the server is the only source of time: the routes pass
 * nothing from the client, and every function takes `now` so tests control the clock.
 *
 * Streak. Claiming on the day after the last claim extends the streak. Missing days
 * resets it to day 1, unless the player holds a freeze for every missed day: the freezes
 * are then consumed automatically and the streak carries on. A partial cover does not
 * help, so nothing is consumed in that case.
 *
 * Money. The chest pays Cash with ledger reason `daily_streak`, and on day 7, 14 and 30
 * a cosmetic through the cosmetics inventory with `source: 'grant'`. Rewards come from
 * the tables below, never from the request. The (user_id, day_date) key of `daily_claims`
 * and the ledger's `idempotency_ref` both stop a second payout for the same day.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { recordEvent } from './analytics.js';
import { FreezeLimitReachedError, InsufficientCashError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ensureCatalog } from './cosmetics.js';
import { recordOnboardingEvent } from './onboarding.js';
import type { AppContext } from './context.js';

/** Price of one streak freeze, in Cash cents. */
export const FREEZE_PRICE_CENTS = 5000;
/** Most freezes a player can hold at once. */
export const MAX_FREEZES = 2;

/** The cosmetic granted on a milestone day. The keys are existing catalogue items. */
export const STREAK_COSMETICS: Readonly<Record<number, { itemKey: string; name: string }>> = {
  7: { itemKey: 'head_cap_black', name: 'Black Cap' },
  14: { itemKey: 'acc_aviator_sunglasses', name: 'Aviator Sunglasses' },
  30: { itemKey: 'acc_chain_gold', name: 'Gold Chain' },
};

export interface ChestRewards {
  readonly cashCents: number;
  readonly cosmetic: { readonly itemKey: string; readonly name: string } | null;
}

export interface DailyStatus {
  /** Consecutive days claimed up to now; 0 when the streak is broken or never started. */
  readonly streakDay: number;
  readonly claimedToday: boolean;
  /** The next UTC midnight. */
  readonly nextResetAt: string;
  readonly freezes: number;
  readonly maxFreezes: number;
  readonly freezePriceCents: number;
  /** Today's chest if it is not taken yet, otherwise tomorrow's. */
  readonly chest: { readonly day: number; readonly rewards: ChestRewards };
}

export interface DailyClaimResult extends DailyStatus {
  /** True when today's chest had already been taken: nothing was paid this time. */
  readonly alreadyClaimed: boolean;
  /** What today's claim paid (the same on a replay). */
  readonly claimed: { readonly day: number; readonly rewards: ChestRewards };
  readonly freezesUsed: number;
  /** The streak was broken and restarted at day 1 by this claim. */
  readonly reset: boolean;
}

/**
 * The UTC date of an instant.
 * @param d - The instant.
 * @returns `YYYY-MM-DD`.
 */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The first instant of the next UTC day.
 * @param d - The instant.
 * @returns The next UTC midnight.
 */
export function nextUtcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

function daysBetween(fromDate: string, toDate: string): number {
  return Math.round(
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * Cash a chest pays on a given streak day: $10 on day 1, +$2.50 a day to $25 on day 7,
 * flat after that.
 * @param day - The streak day, 1 or more.
 * @returns Cash in cents.
 */
export function chestCashCents(day: number): number {
  return 1000 + 250 * Math.min(Math.max(day, 1) - 1, 6);
}

interface StreakRow {
  readonly streak_day: number;
  readonly best_streak: number;
  readonly last: string | null;
  readonly freezes: number;
}

interface Plan {
  /** The streak day today's claim would be. */
  readonly day: number;
  readonly freezesUsed: number;
  readonly reset: boolean;
}

/**
 * What a claim made on `today` would do to this streak.
 * @param row - The player's streak row.
 * @param today - The UTC date.
 * @returns The day the claim would land on, the freezes it would use, and whether it resets.
 */
function planClaim(row: StreakRow, today: string): Plan {
  if (row.last === null || row.streak_day === 0) return { day: 1, freezesUsed: 0, reset: false };
  const gap = daysBetween(row.last, today);
  if (gap <= 1) return { day: row.streak_day + 1, freezesUsed: 0, reset: false };
  const missed = gap - 1;
  if (row.freezes >= missed) return { day: row.streak_day + 1, freezesUsed: missed, reset: false };
  return { day: 1, freezesUsed: 0, reset: true };
}

async function chestFor(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
  day: number,
): Promise<ChestRewards> {
  const c = STREAK_COSMETICS[day];
  let cosmetic: ChestRewards['cosmetic'] = null;
  if (c) {
    const owned = await client.query(
      `SELECT 1 FROM cosmetic_inventory ci JOIN cosmetic_items it ON it.item_id = ci.item_id
        WHERE ci.user_id = $1 AND it.item_key = $2`,
      [userId, c.itemKey],
    );
    cosmetic = owned.rows.length === 0 ? c : null;
  }
  return { cashCents: chestCashCents(day), cosmetic };
}

async function readStreak(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
  lock: boolean,
): Promise<StreakRow> {
  if (lock) {
    await client.query(`INSERT INTO login_streaks (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      userId,
    ]);
  }
  const r = await client.query(
    `SELECT streak_day, best_streak, freezes, to_char(last_claim_date, 'YYYY-MM-DD') AS last
       FROM login_streaks WHERE user_id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return (
    (r.rows[0] as StreakRow | undefined) ?? {
      streak_day: 0,
      best_streak: 0,
      last: null,
      freezes: 0,
    }
  );
}

/**
 * Today's streak state for a player. Read only.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param now - The current time (injectable for tests).
 * @returns The status.
 */
export async function getDailyStatus(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<DailyStatus> {
  const today = utcDate(now);
  return ctx.db.withConnection(async (c) => {
    const row = await readStreak(c, userId, false);
    const claimed = await c.query(
      `SELECT 1 FROM daily_claims WHERE user_id = $1 AND day_date = $2`,
      [userId, today],
    );
    return statusFrom(c, userId, row, claimed.rows.length > 0, today, now);
  });
}

async function statusFrom(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  userId: string,
  row: StreakRow,
  claimedToday: boolean,
  today: string,
  now: Date,
): Promise<DailyStatus> {
  let streakDay: number;
  let chestDay: number;
  if (claimedToday) {
    streakDay = row.streak_day;
    chestDay = row.streak_day + 1;
  } else {
    const plan = planClaim(row, today);
    streakDay = plan.reset || row.last === null ? 0 : row.streak_day;
    chestDay = plan.day;
  }
  return {
    streakDay,
    claimedToday,
    nextResetAt: nextUtcMidnight(now).toISOString(),
    freezes: row.freezes,
    maxFreezes: MAX_FREEZES,
    freezePriceCents: FREEZE_PRICE_CENTS,
    chest: { day: chestDay, rewards: await chestFor(client, userId, chestDay) },
  };
}

/**
 * Claim today's chest. A second call on the same UTC day pays nothing and returns the
 * first claim with `alreadyClaimed: true`.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param now - The current time (injectable for tests).
 * @returns What was paid and the new status.
 */
export async function claimDaily(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<DailyClaimResult> {
  const today = utcDate(now);
  // Seed the cosmetic catalogue outside the transaction, only when a milestone could pay.
  const before = await ctx.db.withConnection((c) => readStreak(c, userId, false));
  if (STREAK_COSMETICS[planClaim(before, today).day]) await ensureCatalog(ctx);
  const result = await runInTransaction(async (client) => {
    const row = await readStreak(client, userId, true);
    const prior = await client.query<{
      streak_day: number;
      cash_cents: string;
      item_key: string | null;
      freezes_used: number;
      was_reset: boolean;
    }>(
      `SELECT streak_day, cash_cents, item_key, freezes_used, was_reset
         FROM daily_claims WHERE user_id = $1 AND day_date = $2`,
      [userId, today],
    );
    if (prior.rows[0]) {
      const p = prior.rows[0];
      const cosmetic = p.item_key !== null ? (STREAK_COSMETICS[p.streak_day] ?? null) : null;
      return {
        ...(await statusFrom(client, userId, row, true, today, now)),
        alreadyClaimed: true,
        claimed: {
          day: p.streak_day,
          rewards: { cashCents: Number(p.cash_cents), cosmetic },
        },
        freezesUsed: p.freezes_used,
        reset: p.was_reset,
      };
    }
    const plan = planClaim(row, today);
    const cashCents = chestCashCents(plan.day);
    let cosmetic: ChestRewards['cosmetic'] = null;
    const milestone = STREAK_COSMETICS[plan.day];
    if (milestone) {
      const item = await client.query<{ item_id: string }>(
        `SELECT item_id FROM cosmetic_items WHERE item_key = $1`,
        [milestone.itemKey],
      );
      if (item.rows[0]) {
        const g = await client.query(
          `INSERT INTO cosmetic_inventory (inventory_id, user_id, item_id, source, acquired_at)
           VALUES ($1, $2, $3, 'grant', $4)
           ON CONFLICT (user_id, item_id) DO NOTHING RETURNING inventory_id`,
          [uuidv7(), userId, item.rows[0].item_id, now],
        );
        if (g.rows.length > 0) cosmetic = milestone;
      }
    }
    await client.query(
      `INSERT INTO daily_claims (user_id, day_date, streak_day, cash_cents, item_key, freezes_used, was_reset, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        today,
        plan.day,
        cashCents,
        cosmetic?.itemKey ?? null,
        plan.freezesUsed,
        plan.reset,
        now,
      ],
    );
    await client.query(
      `UPDATE login_streaks
          SET streak_day = $2, best_streak = GREATEST(best_streak, $2), last_claim_date = $3,
              freezes = freezes - $4, updated_at = $5
        WHERE user_id = $1`,
      [userId, plan.day, today, plan.freezesUsed, now],
    );
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
      [userId, cashCents],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref, created_at)
       VALUES ($1, $2, 'cash', 'daily_streak', 'daily', $3, $4, $5)`,
      [userId, cashCents, today, `daily:${userId}:${today}`, now],
    );
    await recordEvent(
      client,
      userId,
      {
        name: 'daily_claimed',
        props: { streakDay: plan.day, reset: plan.reset },
        amountCents: cashCents,
      },
      now,
    );
    const after: StreakRow = {
      streak_day: plan.day,
      best_streak: Math.max(row.best_streak, plan.day),
      last: today,
      freezes: row.freezes - plan.freezesUsed,
    };
    return {
      ...(await statusFrom(client, userId, after, true, today, now)),
      alreadyClaimed: false,
      claimed: { day: plan.day, rewards: { cashCents, cosmetic } },
      freezesUsed: plan.freezesUsed,
      reset: plan.reset,
    };
  });
  // The first chest is an onboarding moment (a starter quest and a first-session beat).
  if (!result.alreadyClaimed)
    await recordOnboardingEvent(ctx, userId, 'chest_open', `chest:${today}`, now);
  return result;
}

/**
 * Buy a streak freeze with Cash.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param now - The current time (injectable for tests).
 * @returns The new status.
 * @throws FreezeLimitReachedError when two are already held.
 * @throws InsufficientCashError when Cash is short.
 */
export async function buyFreeze(
  _ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<DailyStatus> {
  const today = utcDate(now);
  return runInTransaction(async (client) => {
    const row = await readStreak(client, userId, true);
    if (row.freezes >= MAX_FREEZES) throw new FreezeLimitReachedError({ max: MAX_FREEZES });
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(FREEZE_PRICE_CENTS)) {
      throw new InsufficientCashError({
        have: cash.toString(),
        need: FREEZE_PRICE_CENTS.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [FREEZE_PRICE_CENTS, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref, created_at)
       VALUES ($1, $2, 'cash', 'streak_freeze', 'daily', $3, $4, $5)`,
      [userId, -FREEZE_PRICE_CENTS, today, `freeze:${userId}:${uuidv7()}`, now],
    );
    await client.query(
      `UPDATE login_streaks SET freezes = freezes + 1, updated_at = $2 WHERE user_id = $1`,
      [userId, now],
    );
    const after = { ...row, freezes: row.freezes + 1 };
    const claimed = await client.query(
      `SELECT 1 FROM daily_claims WHERE user_id = $1 AND day_date = $2`,
      [userId, today],
    );
    return statusFrom(client, userId, after, claimed.rows.length > 0, today, now);
  });
}
