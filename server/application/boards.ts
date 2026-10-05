/**
 * Boards service.
 *
 * M2 stub: returns a synthetic top-N from the `balances` table for
 * the net_worth and weekly_pnl boards. M3 replaces this with a
 * Redis ZSET-backed board and a Sunday Unlock refresh.
 */
import { ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export class BoardsService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Top `limit` entries for a board. Boards are listed in
   * contract/ids/boards.json; the M2 scope is `global` only.
   */
  async top(
    boardId: string,
    scope: 'global' | 'friends' | 'league',
    limit: number,
  ): Promise<Array<{ rank: number; userId: string; alias: string; value: number }>> {
    if (scope !== 'global') {
      // M2 supports only the global scope. Friends/league are M6.
      throw new ValidationFailedError({ reason: 'scope_not_implemented', scope });
    }
    switch (boardId) {
      case 'net_worth':
        return this.netWorthTop(limit);
      case 'weekly_pnl':
        return this.weeklyPnlTop(limit);
      case 'clout':
        return this.cloutTop(limit);
      case 'weekly_return':
      case 'trust_score':
        // M2: not yet computed. Return an empty list.
        return [];
      default:
        throw new ValidationFailedError({ boardId });
    }
  }

  private async netWorthTop(limit: number) {
    return this.ctx.db.withConnection(async (c) => {
      const r = await c.query<{
        user_id: string;
        alias: string | null;
        cash_cents: string;
        debt_cents: string;
      }>(
        `SELECT u.id AS user_id, c.alias,
                COALESCE(b.cash_cents, 0) AS cash_cents,
                COALESCE(b.debt_cents, 0) AS debt_cents
         FROM users u
         LEFT JOIN characters c ON c.user_id = u.id
         LEFT JOIN balances b ON b.user_id = u.id
         ORDER BY (COALESCE(b.cash_cents, 0) - COALESCE(b.debt_cents, 0)) DESC
         LIMIT $1`,
        [limit],
      );
      return r.rows.map((row, i) => ({
        rank: i + 1,
        userId: row.user_id,
        alias: row.alias ?? '',
        value: Number(row.cash_cents) - Number(row.debt_cents),
      }));
    });
  }

  private async weeklyPnlTop(limit: number) {
    // M2 stub: weekly PnL equals the sum of ledger_entries with
    // reason in ('shift_pay', 'trade_buy', 'trade_sell', 'tip',
    // 'tax', 'fee') over the last 7 days. We do a simple SQL sum
    // for now; the proper windowing is M5.
    return this.ctx.db.withConnection(async (c) => {
      const r = await c.query<{ user_id: string; alias: string | null; pnl: string }>(
        `SELECT u.id AS user_id, c.alias,
                COALESCE(SUM(l.delta_cents), 0) AS pnl
         FROM users u
         LEFT JOIN characters c ON c.user_id = u.id
         LEFT JOIN ledger_entries l ON l.user_id = u.id
           AND l.created_at > now() - interval '7 days'
         GROUP BY u.id, c.alias
         ORDER BY pnl DESC
         LIMIT $1`,
        [limit],
      );
      return r.rows.map((row, i) => ({
        rank: i + 1,
        userId: row.user_id,
        alias: row.alias ?? '',
        value: Number(row.pnl),
      }));
    });
  }

  private async cloutTop(limit: number) {
    return this.ctx.db.withConnection(async (c) => {
      const r = await c.query<{ user_id: string; alias: string | null; clout: number }>(
        `SELECT u.id AS user_id, c.alias, s.clout
         FROM users u
         LEFT JOIN characters c ON c.user_id = u.id
         LEFT JOIN skills s ON s.user_id = u.id
         ORDER BY s.clout DESC NULLS LAST
         LIMIT $1`,
        [limit],
      );
      return r.rows.map((row, i) => ({
        rank: i + 1,
        userId: row.user_id,
        alias: row.alias ?? '',
        value: row.clout,
      }));
    });
  }
}
