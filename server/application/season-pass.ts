/**
 * Season pass service (M5 #61).
 *
 * Endpoints:
 *
 *   POST /v1/season-pass/buy   — buy the season pass. The M5 dev
 *                                path credits Cash from a recorded
 *                                webhook (production wires the
 *                                payment intent flow from M3);
 *                                M5 ships the buy endpoint that
 *                                debits the user's cash for
 *                                price_paid_cents and writes the
 *                                season_pass row.
 *   GET  /v1/season-pass/me    — return the user's pass (or 404)
 *   POST /v1/season-pass/claim — claim the weekly perk. The
 *                                server/workers/sunday-unlock.ts
 *                                worker is the source of truth
 *                                for whether the perk has been
 *                                credited for the current week;
 *                                the claim endpoint returns the
 *                                meta payload (or 404 if no
 *                                WeeklyMeta yet).
 *
 * Idempotency:
 *   - The season_pass.user_id UNIQUE means re-buying flips
 *     tier='free' to tier='season' in-place; the application
 *     extends expires_at by SEASON_DURATION_MS from now.
 *   - The weekly perk credit is owned by the Sunday Unlock
 *     worker; the claim endpoint just returns the meta shape.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type PassTier = 'free' | 'season';

export interface SeasonPassRow {
  readonly passId: string;
  readonly userId: string;
  readonly tier: PassTier;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly pricePaidCents: number;
}

const SEASON_PRICE_CENTS = 500; // $5
const SEASON_DURATION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

interface PassDbRow {
  pass_id: string;
  user_id: string;
  tier: PassTier;
  started_at: Date;
  expires_at: Date;
  price_paid_cents: string;
}

function rowToPass(r: PassDbRow): SeasonPassRow {
  return {
    passId: r.pass_id,
    userId: r.user_id,
    tier: r.tier,
    startedAt: r.started_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    pricePaidCents: Number(r.price_paid_cents),
  };
}

/** Buy the season pass. Idempotent on user_id (UNIQUE). */
export async function buy(_ctx: AppContext, userId: string): Promise<SeasonPassRow> {
  const passId = uuidv7();
  const result = await runInTransaction(async (client) => {
    // Ensure balance row + lock.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(SEASON_PRICE_CENTS)) {
      throw new ValidationFailedError({
        reason: 'insufficient cash',
        have: cash.toString(),
        need: SEASON_PRICE_CENTS.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [SEASON_PRICE_CENTS, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'season_pass_buy', 'season_pass', $3, $4)`,
      [userId, -SEASON_PRICE_CENTS, userId, `season-pass-buy:${userId}:${uuidv7()}`],
    );
    // Upsert the pass row.
    const newExpires = new Date(Date.now() + SEASON_DURATION_MS);
    const r = await client.query<PassDbRow>(
      `INSERT INTO season_pass (pass_id, user_id, tier, started_at, expires_at, price_paid_cents)
       VALUES ($1, $2, 'season', now(), $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET tier = EXCLUDED.tier,
             expires_at = EXCLUDED.expires_at,
             price_paid_cents = season_pass.price_paid_cents + EXCLUDED.price_paid_cents
       RETURNING pass_id, user_id, tier, started_at, expires_at, price_paid_cents`,
      [passId, userId, newExpires, SEASON_PRICE_CENTS],
    );
    return r.rows[0]!;
  });
  return rowToPass(result);
}

/** Look up the user's pass row. Returns null when there is none. */
export async function getByUser(ctx: AppContext, userId: string): Promise<SeasonPassRow | null> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<PassDbRow>(
      `SELECT pass_id, user_id, tier, started_at, expires_at, price_paid_cents
       FROM season_pass WHERE user_id = $1`,
      [userId],
    );
    const row = r.rows[0];
    return row ? rowToPass(row) : null;
  });
}

export interface WeeklyPerkClaim {
  readonly weekIso: string;
  readonly perkCents: number;
  readonly credited: boolean;
  readonly message: string;
}

/**
 * Claim the weekly perk. The Sunday Unlock worker is the
 * source of truth; this endpoint reads the meta_jobs row
 * for the current week and returns the credit status.
 *
 * If the user holds an active season pass AND the worker
 * has credited their row this week, credited=true.
 *
 * The worker writes a 'weekly_perk' ledger row for each
 * eligible user; the claim endpoint only surfaces the
 * status, never creates money movement.
 */
export async function claim(ctx: AppContext, userId: string): Promise<WeeklyPerkClaim> {
  const pass = await getByUser(ctx, userId);
  if (!pass || pass.tier !== 'season') {
    throw new ValidationFailedError({ reason: 'no active season pass' });
  }
  if (new Date(pass.expiresAt).getTime() < Date.now()) {
    throw new ValidationFailedError({ reason: 'season pass expired' });
  }
  const { weekIso } = await import('../workers/sunday-unlock.js');
  const wk = weekIso(new Date());
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ delta_cents: string }>(
      `SELECT delta_cents FROM ledger_entries
       WHERE user_id = $1
         AND reason = 'weekly_perk'
         AND idempotency_ref LIKE $2
       ORDER BY created_at DESC LIMIT 1`,
      [userId, `weekly-perk:${wk}:${userId}:%`],
    );
  });
  const credited = r.rows.length > 0;
  const perkCents = credited ? Number(r.rows[0]!.delta_cents) : 0;
  return {
    weekIso: wk,
    perkCents,
    credited,
    message: credited
      ? `Weekly perk credited for ${wk}.`
      : `No weekly perk available yet for ${wk}; check back after Sunday 20:00 UTC.`,
  };
}
