/**
 * Bank: debt repayment and the player's cash history.
 *
 *   POST /v1/bank/repay  - move cash onto debt
 *   GET  /v1/ledger      - the cash side of ledger_entries, newest first
 *
 * Debt comes from the birth lottery (Exit Liquidity starts $720 in the
 * hole). economy.json schedules it at `weeklyDueCents` per week, due at
 * Sunday Unlock; `debtSchedule` derives the next deadline from that.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { InsufficientCashError, NothingToRepayError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export interface RepayResult {
  readonly repaidCents: number;
  readonly cashCents: number;
  readonly debtCents: number;
}

/**
 * Repay debt from cash. An amount above the outstanding debt is capped
 * to it, so "pay it all off" never over-collects.
 *
 * The idempotency key is folded into the ledger's unique
 * `idempotency_ref`, so a replay that outlives the 24 h response cache
 * still cannot pay twice: it finds its own ledger row and returns the
 * current balances.
 * @param _ctx - The application context.
 * @param userId - The payer.
 * @param amountCents - Requested repayment, > 0.
 * @param idempotencyKey - The request's Idempotency-Key.
 */
export async function repayDebt(
  _ctx: AppContext,
  userId: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<RepayResult> {
  const cashRef = `loan-repay:${userId}:${idempotencyKey}`;
  return runInTransaction(async (client) => {
    const bal = await client.query<{ cash_cents: string; debt_cents: string }>(
      `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    const debt = BigInt(bal.rows[0]?.debt_cents ?? '0');

    const prior = await client.query<{ delta_cents: string }>(
      `SELECT delta_cents FROM ledger_entries WHERE idempotency_ref = $1`,
      [cashRef],
    );
    if (prior.rows[0]) {
      return {
        repaidCents: -Number(prior.rows[0].delta_cents),
        cashCents: Number(cash),
        debtCents: Number(debt),
      };
    }

    if (debt === 0n) throw new NothingToRepayError();
    const amount = BigInt(amountCents) < debt ? BigInt(amountCents) : debt;
    if (cash < amount) {
      throw new InsufficientCashError({
        have: cash.toString(),
        need: amount.toString(),
        shortfallCents: Number(amount - cash),
      });
    }

    await client.query(
      `UPDATE balances
         SET cash_cents = cash_cents - $1, debt_cents = debt_cents - $1, updated_at = now()
       WHERE user_id = $2`,
      [amount.toString(), userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'loan_repay', 'loan', $3, $4),
              ($1, $2, 'debt', 'loan_repay', 'loan', $3, $5)`,
      [userId, (-amount).toString(), userId, cashRef, `${cashRef}:debt`],
    );
    return {
      repaidCents: Number(amount),
      cashCents: Number(cash - amount),
      debtCents: Number(debt - amount),
    };
  });
}

interface DebtConfig {
  readonly lottery: { readonly exit_liquidity: { readonly weeklyDueCents: number } };
}

/** Sunday Unlock: Sunday 20:00 UTC (economy.json `sundayUnlockCron`). */
const UNLOCK_DOW = 0;
const UNLOCK_HOUR_UTC = 20;

/**
 * The next Sunday Unlock strictly after `now`.
 * @param now - Reference time.
 */
export function nextSundayUnlock(now: Date): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), UNLOCK_HOUR_UTC),
  );
  d.setUTCDate(d.getUTCDate() + ((UNLOCK_DOW - d.getUTCDay() + 7) % 7));
  if (d.getTime() <= now.getTime()) d.setUTCDate(d.getUTCDate() + 7);
  return d;
}

/**
 * When the next debt instalment is due and how much it is. Both are
 * null when the player owes nothing.
 * @param ctx - The application context.
 * @param debtCents - Outstanding debt.
 * @param now - Reference time.
 */
export function debtSchedule(
  ctx: AppContext,
  debtCents: number,
  now: Date = new Date(),
): { debtDueAt: string | null; debtWeeklyDueCents: number | null } {
  if (debtCents <= 0) return { debtDueAt: null, debtWeeklyDueCents: null };
  const weekly = ctx.configCache.load<DebtConfig>('economy').lottery.exit_liquidity.weeklyDueCents;
  return {
    debtDueAt: nextSundayUnlock(now).toISOString(),
    debtWeeklyDueCents: Math.min(weekly, debtCents),
  };
}

export interface LedgerItem {
  readonly id: string;
  /** The ledger `reason` code, e.g. shift_pay, rent, tip_out, loan_repay. */
  readonly kind: string;
  /** Signed: credits positive, debits negative. */
  readonly amountCents: number;
  readonly label: string;
  readonly at: string;
}

const LABELS: Record<string, string> = {
  topup: 'Top-up',
  shift_pay: 'Shift pay',
  gig_pay: 'Gig pay',
  rent: 'Rent',
  shop_order: 'Duo Shop order',
  shop_refund: 'Duo Shop refund',
  business_rent: 'Business rent',
  business_pay: 'Business income',
  business_buy: 'Business purchase',
  business_sell: 'Business sale',
  tip: 'Tip received',
  tip_out: 'Tip sent',
  trade_buy: 'Coin buy',
  trade_sell: 'Coin sell',
  perp_margin: 'Perp opened',
  perp_close: 'Perp closed',
  liq_pay: 'Perp liquidated',
  prediction: 'Prediction stake',
  prediction_payout: 'Prediction payout',
  lottery_payout: 'Birth lottery',
  loan_repay: 'Debt repayment',
  beef_stake: 'Beef stake',
  beef_stake_refund: 'Beef stake refund',
  beef_payout: 'Beef winnings',
  beef_fee: 'Beef fee',
  cosmetic: 'Cosmetic',
  season_pass_buy: 'Season pass',
  daily_clue: 'Daily clue',
  daily_streak: 'Daily streak chest',
  streak_freeze: 'Streak freeze',
  quest_reward: 'Quest reward',
  weekly_perk: 'Sunday Unlock perk',
  airdrop: 'Airdrop',
  project_seed: 'Project funding',
  project_payroll: 'Project payroll',
  fee: 'Fee',
  tax: 'Tax',
  penalty: 'Penalty',
};

/** A label for any reason, including ones added after this map. */
function labelFor(reason: string): string {
  const known = LABELS[reason];
  if (known) return known;
  const words = reason.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The player's cash history, newest first. `before` is the `next` cursor
 * from the previous page (a ledger id); `next` is null on the last page.
 * @param ctx - The application context.
 * @param userId - Whose ledger.
 * @param before - Exclusive cursor, or null for the newest page.
 * @param limit - Page size.
 */
export async function listLedger(
  ctx: AppContext,
  userId: string,
  before: string | null,
  limit: number,
): Promise<{ items: LedgerItem[]; next: string | null }> {
  const params: unknown[] = [userId, limit];
  let where = `user_id = $1 AND account = 'cash' AND delta_cents <> 0`;
  if (before !== null) {
    params.push(before);
    where += ` AND id < $3`;
  }
  const r = await ctx.db.withConnection((c) =>
    c.query<{ id: string; reason: string; delta_cents: string; created_at: Date }>(
      `SELECT id, reason, delta_cents, created_at
       FROM ledger_entries
       WHERE ${where}
       ORDER BY id DESC
       LIMIT $2`,
      params,
    ),
  );
  const items = r.rows.map((row) => ({
    id: String(row.id),
    kind: row.reason,
    amountCents: Number(row.delta_cents),
    label: labelFor(row.reason),
    at: row.created_at.toISOString(),
  }));
  const next = items.length === limit ? items[items.length - 1]!.id : null;
  return { items, next };
}
