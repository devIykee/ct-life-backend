/**
 * Boards service.
 *
 * M2 stub: returns a synthetic top-N from the `balances` table for
 * the net_worth and weekly_pnl boards. M3 replaced the weekly_pnl
 * and net_worth boards with a SQL sum; the M7 #3 slice extends the
 * service with `scope=friends|league` support per the master
 * prompt's "boards with scope=friends|league" gate.
 *
 * Scopes:
 *   - global: top-N across every user (M2 default).
 *   - friends: top-N across the caller's follow list (M7 #3).
 *   - league: top-N across the caller's current season league
 *             cohort (M7 #3).
 */
import { ValidationFailedError } from '../shared/domain/errors.js';
import { getLeagueCohort, getMyLeague } from './leagues.js';
import { currentSeasonIso } from './season-clock.js';
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
   * Top `limit` entries for a board. `callerUserId` is required
   * for friends/league scopes; ignored for global.
   */
  async top(
    boardId: string,
    scope: 'global' | 'friends' | 'league',
    limit: number,
    callerUserId?: string,
  ): Promise<Array<{ rank: number; userId: string; alias: string; value: number }>> {
    if ((scope === 'friends' || scope === 'league') && callerUserId === undefined) {
      throw new ValidationFailedError({ reason: 'caller required for non-global scope' });
    }
    // Resolve the cohort (the set of user_ids the top-N is restricted to).
    let cohort: string[] | null = null;
    if (scope === 'friends') {
      cohort = await this.friendCohort(callerUserId!);
    } else if (scope === 'league') {
      cohort = await this.leagueCohort(callerUserId!);
    }
    if (cohort !== null && cohort.length === 0) return [];
    switch (boardId) {
      case 'net_worth':
        return this.netWorthTop(limit, cohort);
      case 'weekly_pnl':
        return this.weeklyPnlTop(limit, cohort);
      case 'clout':
        return this.cloutTop(limit, cohort);
      case 'weekly_return':
      case 'trust_score':
        // M2: not yet computed. Return an empty list.
        return [];
      default:
        throw new ValidationFailedError({ boardId });
    }
  }

  private async friendCohort(callerUserId: string): Promise<string[]> {
    const r = await this.ctx.db.withConnection(async (c) => {
      return c.query<{ followee_user_id: string }>(
        `SELECT followee_user_id FROM follows WHERE follower_user_id = $1`,
        [callerUserId],
      );
    });
    return [callerUserId, ...r.rows.map((row) => row.followee_user_id)];
  }

  private async leagueCohort(callerUserId: string): Promise<string[]> {
    const seasonIso = currentSeasonIso();
    const m = await getMyLeague(this.ctx, callerUserId, seasonIso);
    if (m === null) return [callerUserId];
    return await getLeagueCohort(this.ctx, seasonIso, m.leagueId);
  }

  private async netWorthTop(limit: number, cohort: string[] | null) {
    if (cohort === null) {
      const r = await this.ctx.db.withConnection(async (c) => {
        return c.query<{
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
      });
      return r.rows.map((row, i) => ({
        rank: i + 1,
        userId: row.user_id,
        alias: row.alias ?? '',
        value: Number(row.cash_cents) - Number(row.debt_cents),
      }));
    }
    const r = await this.ctx.db.withConnection(async (c) => {
      return c.query<{
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
         WHERE u.id = ANY($1::uuid[])
         ORDER BY (COALESCE(b.cash_cents, 0) - COALESCE(b.debt_cents, 0)) DESC
         LIMIT $2`,
        [cohort, limit],
      );
    });
    return r.rows.map((row, i) => ({
      rank: i + 1,
      userId: row.user_id,
      alias: row.alias ?? '',
      value: Number(row.cash_cents) - Number(row.debt_cents),
    }));
  }

  private async weeklyPnlTop(limit: number, cohort: string[] | null) {
    if (cohort === null) {
      const r = await this.ctx.db.withConnection(async (c) => {
        return c.query<{ user_id: string; alias: string | null; pnl: string }>(
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
      });
      return r.rows.map((row, i) => ({
        rank: i + 1,
        userId: row.user_id,
        alias: row.alias ?? '',
        value: Number(row.pnl),
      }));
    }
    const r = await this.ctx.db.withConnection(async (c) => {
      return c.query<{ user_id: string; alias: string | null; pnl: string }>(
        `SELECT u.id AS user_id, c.alias,
                COALESCE(SUM(l.delta_cents), 0) AS pnl
         FROM users u
         LEFT JOIN characters c ON c.user_id = u.id
         LEFT JOIN ledger_entries l ON l.user_id = u.id
           AND l.created_at > now() - interval '7 days'
         WHERE u.id = ANY($1::uuid[])
         GROUP BY u.id, c.alias
         ORDER BY pnl DESC
         LIMIT $2`,
        [cohort, limit],
      );
    });
    return r.rows.map((row, i) => ({
      rank: i + 1,
      userId: row.user_id,
      alias: row.alias ?? '',
      value: Number(row.pnl),
    }));
  }

  private async cloutTop(limit: number, cohort: string[] | null) {
    if (cohort === null) {
      const r = await this.ctx.db.withConnection(async (c) => {
        return c.query<{ user_id: string; alias: string | null; clout: number }>(
          `SELECT u.id AS user_id, c.alias, s.clout
           FROM users u
           LEFT JOIN characters c ON c.user_id = u.id
           LEFT JOIN skills s ON s.user_id = u.id
           ORDER BY s.clout DESC NULLS LAST
           LIMIT $1`,
          [limit],
        );
      });
      return r.rows.map((row, i) => ({
        rank: i + 1,
        userId: row.user_id,
        alias: row.alias ?? '',
        value: row.clout,
      }));
    }
    const r = await this.ctx.db.withConnection(async (c) => {
      return c.query<{ user_id: string; alias: string | null; clout: number }>(
        `SELECT u.id AS user_id, c.alias, s.clout
         FROM users u
         LEFT JOIN characters c ON c.user_id = u.id
         LEFT JOIN skills s ON s.user_id = u.id
         WHERE u.id = ANY($1::uuid[])
         ORDER BY s.clout DESC NULLS LAST
         LIMIT $2`,
        [cohort, limit],
      );
    });
    return r.rows.map((row, i) => ({
      rank: i + 1,
      userId: row.user_id,
      alias: row.alias ?? '',
      value: row.clout,
    }));
  }
}
