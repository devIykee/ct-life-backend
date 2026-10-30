/**
 * Airdrop Farm + Sybil jail (M7 #6).
 *
 * Endpoints:
 *
 *   POST /v1/airdrop/claim                 — claim today's airdrop.
 *                                            Idempotent on (user_id,
 *                                            day_date) — a second
 *                                            claim on the same day
 *                                            is a no-op.
 *   GET  /v1/airdrop/claims                — list the caller's
 *                                            recent claims.
 *   POST /v1/admin/users/{id}/sybil_jail   — admin sets the flag.
 *   DELETE /v1/admin/users/{id}/sybil_jail — admin clears it.
 *
 * Airdrop amount (server-authoritative):
 *
 *   base = 500 cents ($5) per claim
 *   sgt_bonus = 1.5x when the user has a verified SGT
 *     (users.sgt_mint IS NOT NULL)
 *
 * The cash credit runs through a 'airdrop' ledger row inside
 * runInTransaction. A sybil-jailed user (admin flag or a game stay,
 * server/application/sybil-jail.ts) is refused with 403 SYBIL_JAILED
 * {releaseAt, reasonId}. While the capability sybilBail is on, every
 * attempt is counted and may roll a game jail (unlock A5).
 *
 * The daily cap is 4 claims per day per user; the second
 * claim on the same day is a no-op (UNIQUE on user_id+day_date
 * is the floor). The amount is also capped to a hard ceiling
 * of 10_000 cents per day to bound the faucet.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, SybilJailedError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { recordCareerAction } from './ladders.js';
import type { AppContext } from './context.js';
import { isCapabilityOn } from './capabilities.js';
import {
  getSybilStatus,
  readSybilStatus,
  rollSybilJail,
  sybilConfig,
  type Roll,
  type SybilStatusRow,
} from './sybil-jail.js';

export { getSybilStatus, type SybilStatusRow } from './sybil-jail.js';

const BASE_AIRDROP_CENTS = 500; // $5
const SGT_BONUS_BPS = 5000; // 1.5x = 1 + 50%
const DAILY_CAP_CENTS = 10_000;

export interface AirdropClaimRow {
  readonly claimId: string;
  readonly userId: string;
  readonly dayDate: string;
  readonly claimCount: number;
  readonly amountCents: number;
  readonly sgtBonus: boolean;
  readonly claimedAt: string;
}

interface AirdropClaimDbRow {
  claim_id: string;
  user_id: string;
  day_date: Date;
  claim_count: number;
  amount_cents: string;
  sgt_bonus: boolean;
  claimed_at: Date;
}

interface UserRow {
  is_sybil_jailed: boolean;
  sgt_mint: string | null;
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Claim today's airdrop. */
export async function claimAirdrop(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
  roll?: Roll,
): Promise<AirdropClaimRow> {
  const dayDate = todayUtc();
  const before = await getSybilStatus(ctx, userId, now);
  if (before.jailed) throw jailedError(before);
  if (isCapabilityOn(ctx, 'sybilBail')) {
    const jailed = await rollSybilJail(ctx, userId, await claimYieldCents(ctx, userId), now, roll);
    if (jailed) throw jailedError(jailed);
  }
  const cfg = sybilConfig(ctx);
  const claim = await runInTransaction(async (client) => {
    // Lock the user row + re-check the jail inside the transaction.
    const u = await client.query<UserRow>(
      `SELECT is_sybil_jailed, sgt_mint FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const userRow = u.rows[0];
    if (!userRow) throw new NotFoundError({ kind: 'user', id: userId });
    const status = await readSybilStatus(client, cfg, userId, now);
    if (status.jailed) throw jailedError(status);
    // Idempotency: if a claim exists for today, return it.
    const existing = await client.query<AirdropClaimDbRow>(
      `SELECT claim_id, user_id, day_date, claim_count, amount_cents,
              sgt_bonus, claimed_at
       FROM airdrop_claims WHERE user_id = $1 AND day_date = $2`,
      [userId, dayDate],
    );
    if (existing.rows[0]) {
      return rowToClaim(existing.rows[0]);
    }
    const sgtBonus = userRow.sgt_mint !== null;
    const tribeBonusBps = await tribeBonusBpsFor(client, userId);
    const amount = airdropAmountCents(sgtBonus, tribeBonusBps);
    // Ensure balance row exists, lock, credit the amount.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now()
       WHERE user_id = $2`,
      [amount, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries
         (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'airdrop', 'airdrop_claim', $3, $4)`,
      [userId, amount, userId, `airdrop:${userId}:${dayDate}:${uuidv7()}`],
    );
    const r = await client.query<AirdropClaimDbRow>(
      `INSERT INTO airdrop_claims (claim_id, user_id, day_date, claim_count, amount_cents, sgt_bonus, claimed_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6)
       ON CONFLICT (user_id, day_date) DO UPDATE
         SET amount_cents = EXCLUDED.amount_cents,
             sgt_bonus = EXCLUDED.sgt_bonus,
             claimed_at = EXCLUDED.claimed_at
       RETURNING claim_id, user_id, day_date, claim_count, amount_cents,
                 sgt_bonus, claimed_at`,
      [uuidv7(), userId, dayDate, amount, sgtBonus, now.toISOString()],
    );
    return rowToClaim(r.rows[0]!);
  });
  // After the commit: a claim (new or replayed; the ref makes it count once) feeds the ladder.
  await recordCareerAction(ctx, userId, 'airdrop_claim', claim.claimId, now);
  return claim;
}

/** List the caller's recent airdrop claims. */
export async function listAirdropClaims(
  _ctx: AppContext,
  userId: string,
  limit: number = 30,
): Promise<AirdropClaimRow[]> {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 100) {
    throw new ValidationFailedError({ reason: 'limit must be 1..100' });
  }
  const r = await _ctx.db.withConnection(async (c) => {
    return c.query<AirdropClaimDbRow>(
      `SELECT claim_id, user_id, day_date, claim_count, amount_cents,
              sgt_bonus, claimed_at
       FROM airdrop_claims WHERE user_id = $1
       ORDER BY day_date DESC LIMIT $2`,
      [userId, limit],
    );
  });
  return r.rows.map(rowToClaim);
}

/** Admin: set the sybil jail flag on a user. */
export async function setSybilJailed(
  _ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<{ userId: string; isSybilJailed: boolean; sybilJailedAt: string }> {
  return runInTransaction(async (client) => {
    const r = await client.query<{ id: string }>(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
      userId,
    ]);
    if (!r.rows[0]) throw new NotFoundError({ kind: 'user', id: userId });
    await client.query(
      `UPDATE users SET is_sybil_jailed = true, sybil_jailed_at = $1
       WHERE id = $2`,
      [now.toISOString(), userId],
    );
    return {
      userId,
      isSybilJailed: true,
      sybilJailedAt: now.toISOString(),
    };
  });
}

/** Admin: clear the sybil jail flag on a user. */
export async function clearSybilJailed(
  _ctx: AppContext,
  userId: string,
): Promise<{
  userId: string;
  isSybilJailed: boolean;
}> {
  return runInTransaction(async (client) => {
    const r = await client.query<{ id: string }>(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [
      userId,
    ]);
    if (!r.rows[0]) throw new NotFoundError({ kind: 'user', id: userId });
    await client.query(
      `UPDATE users SET is_sybil_jailed = false, sybil_jailed_at = NULL
       WHERE id = $1`,
      [userId],
    );
    return { userId, isSybilJailed: false };
  });
}

function rowToClaim(r: AirdropClaimDbRow): AirdropClaimRow {
  const d = r.day_date;
  const dayStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return {
    claimId: r.claim_id,
    userId: r.user_id,
    dayDate: dayStr,
    claimCount: r.claim_count,
    amountCents: Number(r.amount_cents),
    sgtBonus: r.sgt_bonus,
    claimedAt: r.claimed_at.toISOString(),
  };
}

/** The Airdrop Farmer tribe's perk, in basis points. */
const TRIBE_FARM_BONUS_BPS = 1500; // "Farm yield +15%"

/**
 * Today's payout for a player, capped.
 *
 * Shared by the claim and the status endpoint so the number the client is
 * shown is the number it will actually be paid.
 * @param sgtBonus - Whether the wallet holds a Seeker Genesis Token.
 * @param tribeBonusBps - Tribe perk in basis points, 0 for most tribes.
 * @returns The amount in cents.
 */
export function airdropAmountCents(sgtBonus: boolean, tribeBonusBps: number): number {
  let amount = BASE_AIRDROP_CENTS;
  const bps = (sgtBonus ? SGT_BONUS_BPS : 0) + tribeBonusBps;
  amount = Math.floor((amount * (10_000 + bps)) / 10_000);
  return amount > DAILY_CAP_CENTS ? DAILY_CAP_CENTS : amount;
}

/**
 * The caller's tribe farm bonus.
 * @param client - An open pg client.
 * @param userId - The user to read.
 * @returns Basis points, 0 when the player is not an Airdrop Farmer.
 */
async function tribeBonusBpsFor(
  client: {
    query: <T extends import('pg').QueryResultRow>(
      q: string,
      v: unknown[],
    ) => Promise<import('pg').QueryResult<T>>;
  },
  userId: string,
): Promise<number> {
  const r = await client.query<{ tribe_id: string }>(
    'SELECT tribe_id FROM characters WHERE user_id = $1',
    [userId],
  );
  return r.rows[0]?.tribe_id === 'airdrop_farmer' ? TRIBE_FARM_BONUS_BPS : 0;
}

/** `403 SYBIL_JAILED {releaseAt, reasonId}`. */
function jailedError(status: SybilStatusRow): SybilJailedError {
  return new SybilJailedError({ releaseAt: status.releaseAt, reasonId: status.reasonId });
}

/**
 * What today's claim pays this player (the bail-per-hour snapshot for a jail).
 * @param ctx - The app context.
 * @param userId - The player.
 */
async function claimYieldCents(ctx: AppContext, userId: string): Promise<number> {
  return ctx.db.withConnection(async (c) => {
    const u = await c.query<{ sgt_mint: string | null }>(
      'SELECT sgt_mint FROM users WHERE id = $1',
      [userId],
    );
    return airdropAmountCents(
      (u.rows[0]?.sgt_mint ?? null) !== null,
      await tribeBonusBpsFor(c, userId),
    );
  });
}

export interface FarmStatusRow {
  readonly dayDate: string;
  readonly claimedToday: boolean;
  readonly nextClaimAt: string;
  readonly baseCents: number;
  readonly sgtBonusBps: number;
  readonly tribeBonusBps: number;
  readonly todayAmountCents: number;
  readonly dailyCapCents: number;
  readonly streakDays: number;
  readonly sybil: SybilStatusRow;
}

/**
 * My Airdrop Farm status for today.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @returns What today's claim is worth and whether it is already taken.
 */
export async function getFarmStatus(ctx: AppContext, userId: string): Promise<FarmStatusRow> {
  const dayDate = todayUtc();
  const out = await ctx.db.withConnection(async (c) => {
    const u = await c.query<{ sgt_mint: string | null }>(
      'SELECT sgt_mint FROM users WHERE id = $1',
      [userId],
    );
    if (!u.rows[0]) throw new NotFoundError({ kind: 'user', id: userId });
    const today = await c.query<{ claim_id: string }>(
      'SELECT claim_id FROM airdrop_claims WHERE user_id = $1 AND day_date = $2',
      [userId, dayDate],
    );
    const days = await c.query<{ day_date: string }>(
      'SELECT day_date FROM airdrop_claims WHERE user_id = $1 ORDER BY day_date DESC LIMIT 400',
      [userId],
    );
    const tribeBps = await tribeBonusBpsFor(c, userId);
    return {
      sgt: u.rows[0].sgt_mint !== null,
      claimed: (today.rowCount ?? 0) > 0,
      days: days.rows.map((d) => String(d.day_date).slice(0, 10)),
      tribeBps,
    };
  });
  // Streak: consecutive UTC days ending today or yesterday.
  const seen = new Set(out.days);
  let streak = 0;
  const cursor = new Date(`${dayDate}T00:00:00.000Z`);
  if (!seen.has(dayDate)) cursor.setUTCDate(cursor.getUTCDate() - 1);
  for (;;) {
    const key = cursor.toISOString().slice(0, 10);
    if (!seen.has(key)) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  const nextMidnight = new Date(`${dayDate}T00:00:00.000Z`);
  nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
  return {
    dayDate,
    claimedToday: out.claimed,
    nextClaimAt: nextMidnight.toISOString(),
    baseCents: BASE_AIRDROP_CENTS,
    sgtBonusBps: out.sgt ? SGT_BONUS_BPS : 0,
    tribeBonusBps: out.tribeBps,
    todayAmountCents: airdropAmountCents(out.sgt, out.tribeBps),
    dailyCapCents: DAILY_CAP_CENTS,
    streakDays: streak,
    sybil: await getSybilStatus(ctx, userId),
  };
}
