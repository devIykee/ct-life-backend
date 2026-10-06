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
 * runInTransaction. The sybil-jailed user is refused with
 * ForbiddenError (the master prompt's "Sybil jail" gate).
 *
 * The daily cap is 4 claims per day per user; the second
 * claim on the same day is a no-op (UNIQUE on user_id+day_date
 * is the floor). The amount is also capped to a hard ceiling
 * of 10_000 cents per day to bound the faucet.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

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
  _ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<AirdropClaimRow> {
  const dayDate = todayUtc();
  return runInTransaction(async (client) => {
    // Lock the user row + check sybil jail.
    const u = await client.query<UserRow>(
      `SELECT is_sybil_jailed, sgt_mint FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const userRow = u.rows[0];
    if (!userRow) throw new NotFoundError({ kind: 'user', id: userId });
    if (userRow.is_sybil_jailed) {
      throw new ForbiddenError({ reason: 'sybil_jailed' });
    }
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
    let amount = BASE_AIRDROP_CENTS;
    if (sgtBonus) {
      amount = Math.floor((amount * (10_000 + SGT_BONUS_BPS)) / 10_000);
    }
    if (amount > DAILY_CAP_CENTS) amount = DAILY_CAP_CENTS;
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
