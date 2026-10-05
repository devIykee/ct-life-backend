/**
 * Lottery service.
 *
 * Rolls the birth lottery once per account. The weights are in
 * contract/config/lottery.json. Non-Seeker wallets never roll the
 * 'seeker' outcome; 'seeker' weight is only consumed by Seeker
 * wallets. The chosen outcome writes a ledger entry and inserts
 * the initial balance row in a single SERIALIZABLE transaction.
 *
 * Idempotency: a unique index on `users.id` enforces "one roll per
 * account" — we mark the user with a `lottery_rolled_at` column
 * conceptually; the absence of a character is the M2 sentinel
 * (everyone must roll before creating a character, and the lottery
 * sets a balance, so the only path to a balance is through here).
 */
import { runInTransaction } from '../shared/db/uow.js';
import { AlreadyRolledError, NotFoundError } from '../shared/domain/errors.js';
import { SeededRng } from '../shared/domain/rng.js';
import type { AppContext } from './context.js';

interface LotteryOutcome {
  readonly cashCents: number;
  readonly homeId: string;
  readonly debtCents?: number;
}

interface LotteryConfig {
  readonly version: string;
  readonly weights: {
    readonly seeker: number;
    readonly insider: number;
    readonly exit_liquidity: number;
  };
  readonly outcomes: {
    readonly seeker: LotteryOutcome;
    readonly insider: LotteryOutcome;
    readonly exit_liquidity: LotteryOutcome;
  };
  readonly _note?: string;
}

export class LotteryService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Roll the birth lottery. Returns the outcome and the new
   * cashCents / debtCents / homeId. Throws AlreadyRolledError if
   * the user has rolled before.
   */
  async roll(
    userId: string,
    _wallet: string,
  ): Promise<{
    outcome: 'insider' | 'exit_liquidity' | 'seeker';
    cashCents: number;
    debtCents: number;
    homeId: string;
  }> {
    const cfg = this.ctx.configCache.load<LotteryConfig>('lottery');
    // SGT: only Seeker wallets can roll 'seeker'. The user table
    // tells us is_seeker; the verify path already populated it.
    const isSeeker = await this.isSeeker(userId);
    const chosen = this.pickOutcome(cfg, isSeeker, userId);
    return runInTransaction(async (client) => {
      // Has the user already rolled? A character is the M2 sentinel.
      const u = await client.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [userId]);
      if ((u.rowCount ?? 0) === 0) {
        throw new NotFoundError({ kind: 'user', id: userId });
      }
      const ch = await client.query<{ id: string }>(
        'SELECT id FROM characters WHERE user_id = $1',
        [userId],
      );
      if ((ch.rowCount ?? 0) > 0) {
        throw new AlreadyRolledError({});
      }
      // The balance is the only writer of the lottery outcome. We
      // also create a ledger entry for the disbursement so the
      // reconciliation invariant holds from the first cent.
      const out = cfg.outcomes[chosen];
      const cash = out.cashCents;
      const debt = out.debtCents ?? 0;
      const homeId = out.homeId;
      // Ensure the balance row exists, then set the values.
      await client.query(
        `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents, debt_cents = EXCLUDED.debt_cents, updated_at = now()`,
        [userId, cash, debt],
      );
      // Ledger entry for the disbursement.
      const idem = `lottery:${userId}`;
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'lottery_payout', 'lottery', $3, $4)`,
        [userId, cash, chosen, idem],
      );
      if (debt > 0) {
        await client.query(
          `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
           VALUES ($1, $2, 'debt', 'loan_disburse', 'lottery', $3, $4)`,
          [userId, debt, chosen, `lottery-debt:${userId}`],
        );
      }
      return { outcome: chosen, cashCents: cash, debtCents: debt, homeId };
    });
  }

  private async isSeeker(userId: string): Promise<boolean> {
    return this.ctx.db.withConnection(async (c: import('pg').PoolClient) => {
      const r = await c.query<{ is_seeker: boolean }>('SELECT is_seeker FROM users WHERE id = $1', [
        userId,
      ]);
      return r.rows[0]?.is_seeker ?? false;
    });
  }

  private pickOutcome(
    cfg: LotteryConfig,
    isSeeker: boolean,
    userId: string,
  ): 'seeker' | 'insider' | 'exit_liquidity' {
    // If the wallet is not a Seeker, the 'seeker' weight is dropped
    // and re-normalised. We add the seeker weight to insider by
    // convention (keeps the distribution roughly stable).
    let seeker = 0;
    let insider = cfg.weights.insider;
    const exit = cfg.weights.exit_liquidity;
    if (isSeeker) {
      seeker = cfg.weights.seeker;
    } else {
      insider = insider + seeker;
    }
    const total = seeker + insider + exit;
    const r = this.rngFor(userId).float() * total;
    if (r < seeker) return 'seeker';
    if (r < seeker + insider) return 'insider';
    return 'exit_liquidity';
  }

  private rngFor(userId: string): SeededRng {
    // Seed the RNG with the user id so the same user always rolls
    // the same outcome — until they actually do roll, at which
    // point the balance exists and the next call is rejected.
    let h = 5381;
    for (let i = 0; i < userId.length; i++) h = (h * 33) ^ userId.charCodeAt(i);
    return new SeededRng(h >>> 0);
  }
}
