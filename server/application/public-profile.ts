/**
 * Public profile service.
 *
 * Returns the public shape (contract section 4) with netWorthCents
 * derived from balances + open positions. M2 has no positions
 * (those land in M3) so netWorthCents == cashCents - debtCents.
 */
import type { AppContext } from './context.js';

export interface PublicProfile {
  readonly id: string;
  readonly alias: string;
  readonly skrName: string | null;
  readonly isSeeker: boolean;
  readonly tribeId: string | null;
  readonly minerTier: 'none' | 'prospector' | 'miner' | 'refiner';
  readonly look: unknown | null;
  readonly netWorthCents: number;
  readonly isOptedInSmartMoney: boolean;
}

export class PublicProfileService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Look up a user by id. Returns null if not found.
   * `netWorthCents` = cashCents - debtCents (M2: no positions yet).
   */
  async byId(userId: string): Promise<PublicProfile | null> {
    return this.ctx.db.withConnection(async (c) => {
      const r = await c.query<{
        id: string;
        is_seeker: boolean;
        skr_name: string | null;
        tribe_id: string | null;
        look: unknown;
        alias: string | null;
        cash_cents: string;
        debt_cents: string;
        is_opted_in_smart_money: boolean;
        miner_tier: 'none' | 'prospector' | 'miner' | 'refiner';
      }>(
        `SELECT u.id, u.is_seeker, u.skr_name, u.is_opted_in_smart_money, u.miner_tier,
                c.tribe_id, c.look, c.alias,
                COALESCE(b.cash_cents, 0) AS cash_cents,
                COALESCE(b.debt_cents, 0) AS debt_cents
         FROM users u
         LEFT JOIN characters c ON c.user_id = u.id
         LEFT JOIN balances b ON b.user_id = u.id
         WHERE u.id = $1`,
        [userId],
      );
      const row = r.rows[0];
      if (!row) return null;
      const cash = Number(row.cash_cents);
      const debt = Number(row.debt_cents);
      return {
        id: row.id,
        alias: row.alias ?? '',
        skrName: row.skr_name,
        isSeeker: row.is_seeker,
        tribeId: row.tribe_id,
        minerTier: row.miner_tier,
        look: row.look,
        netWorthCents: cash - debt,
        isOptedInSmartMoney: row.is_opted_in_smart_money,
      };
    });
  }
}
