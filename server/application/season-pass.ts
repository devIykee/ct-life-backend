/**
 * Season pass service (M5 #61; unlock WP-C C1).
 *
 * Endpoints:
 *
 *   POST /v1/payments/intents {kind:'season_pass', sku:'season_pass', currency:'USDC'}
 *                              — the only way to buy the pass (server/application/topup.ts).
 *                                Settlement calls `grantSeasonPass`; no Cash moves.
 *   POST /v1/season-pass/buy   — 410 GONE {reason:'buy_with_intent'}. It used to debit
 *                                $5 of Cash, which mixed the play-money ledger with a
 *                                real-money product (docs/ECONOMY.md).
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
 * The pass lasts until the end of the season it was bought in
 * (`contract/config/season_tracks.json` endsAt). The season_pass.user_id UNIQUE
 * means a later purchase overwrites the row in place.
 */
import type { PoolClient } from 'pg';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { isCapabilityOn } from './capabilities.js';
import { currentSeason, type SeasonDef } from './season-tracks.js';

export type PassTier = 'free' | 'season';

export interface SeasonPassRow {
  readonly passId: string;
  readonly userId: string;
  readonly tier: PassTier;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly pricePaidCents: number;
}

/** The intent sku, and the only sku valid with `kind: 'season_pass'`. */
export const SEASON_PASS_SKU = 'season_pass';
/** Spec: a 5 USDC season pass. USDC base units (6 decimals). */
export const SEASON_PASS_PRICE_USDC_BASE = 5_000_000n;
/** The same price in US cents, kept on the row as `price_paid_cents`. */
export const SEASON_PASS_PRICE_CENTS = 500;

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

/** `GET /config` `seasonPass` block (C1). */
export interface SeasonPassOffer {
  readonly sku: typeof SEASON_PASS_SKU;
  /** USDC base units, as a string. */
  readonly priceUsdc: string;
  readonly currency: 'USDC';
  readonly seasonId: string;
  readonly endsAt: string;
}

/**
 * The pass on sale right now, or null when the purchase capability is off, the
 * deployment is not on devnet, or no season is running. `GET /config` sends it as
 * `seasonPass`; the client shows "unavailable" without it.
 *
 * @param ctx - The app context.
 * @param now - The current time.
 */
export function seasonPassOffer(
  ctx: Pick<AppContext, 'config'>,
  now: Date = new Date(),
): SeasonPassOffer | null {
  if (!isCapabilityOn(ctx, 'seasonPassPurchase')) return null;
  if (ctx.config.solana.cluster !== 'devnet') return null;
  const season = currentSeason(now);
  if (season === null) return null;
  return {
    sku: SEASON_PASS_SKU,
    priceUsdc: SEASON_PASS_PRICE_USDC_BASE.toString(),
    currency: 'USDC',
    seasonId: season.seasonId,
    endsAt: season.endsAt,
  };
}

/**
 * Grant (or extend) the pass for `season`, inside the settlement transaction of a
 * verified payment intent. Never touches Cash. Idempotent per user: a second grant
 * for the same season leaves `expires_at` at the season end and adds the price.
 *
 * @param client - The open transaction.
 * @param userId - The buyer.
 * @param season - The season the intent was created in.
 * @returns The pass row.
 */
export async function grantSeasonPass(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  season: Pick<SeasonDef, 'endsAt'>,
): Promise<SeasonPassRow> {
  const r = await client.query<PassDbRow>(
    `INSERT INTO season_pass (pass_id, user_id, tier, started_at, expires_at, price_paid_cents)
     VALUES ($1, $2, 'season', now(), $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET tier = 'season',
           started_at = CASE WHEN season_pass.tier = 'season' AND season_pass.expires_at > now()
                             THEN season_pass.started_at ELSE now() END,
           expires_at = GREATEST(season_pass.expires_at, EXCLUDED.expires_at),
           price_paid_cents = season_pass.price_paid_cents + EXCLUDED.price_paid_cents
     RETURNING pass_id, user_id, tier, started_at, expires_at, price_paid_cents`,
    [uuidv7(), userId, season.endsAt, SEASON_PASS_PRICE_CENTS],
  );
  return rowToPass(r.rows[0]!);
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
