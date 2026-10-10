/**
 * Boards service.
 *
 * Top-N for the net_worth, weekly_pnl and clout boards, computed in
 * SQL on read (there is no board cache to invalidate).
 *
 * Scopes:
 *   - global: top-N across every user.
 *   - friends: top-N across the caller's follow list (M7 #3).
 *   - league: top-N across the caller's current season league
 *             cohort (M7 #3).
 *
 * Privacy: the Anon tribe's perk is "hidden from rich list", so Anon
 * characters are dropped from the wealth boards (net_worth,
 * weekly_pnl, weekly_return) in every scope before ranking and LIMIT.
 * They never appear in `entries`, not even to themselves; their own
 * standing is only returned in the caller-private `me` row.
 */
import { ValidationFailedError } from '../shared/domain/errors.js';
import { getLeagueCohort, getMyLeague } from './leagues.js';
import { currentSeasonIso } from './season-clock.js';
import type { AppContext } from './context.js';

export interface BoardEntry {
  rank: number;
  userId: string;
  alias: string;
  value: number;
}

type Scope = 'global' | 'friends' | 'league';

/** Tribes whose members are hidden from the rich list (tribes.json perk). */
const RICH_LIST_HIDDEN_TRIBES: readonly string[] = ['anon'];

/** The rich-list boards: the wealth rankings the Anon perk hides from. */
const RICH_LIST_BOARDS = new Set(['net_worth', 'weekly_pnl', 'weekly_return']);

/**
 * Per-board SQL: `joins` attach to `users u` / `characters c`, `value`
 * is the ranked expression. Never built from caller input.
 */
const BOARD_SQL: Readonly<Record<string, { joins: string; value: string }>> = {
  net_worth: {
    joins: 'LEFT JOIN balances b ON b.user_id = u.id',
    value: '(COALESCE(b.cash_cents, 0) - COALESCE(b.debt_cents, 0))',
  },
  weekly_pnl: {
    joins: '',
    value: `(SELECT COALESCE(SUM(l.delta_cents), 0) FROM ledger_entries l
             WHERE l.user_id = u.id AND l.created_at > now() - interval '7 days')`,
  },
  clout: {
    joins: 'LEFT JOIN skills s ON s.user_id = u.id',
    value: 's.clout',
  },
};

/** Boards in the contract that are not computed yet; always empty. */
const EMPTY_BOARDS = new Set(['weekly_return', 'trust_score']);

/**
 * The board's rows restricted to a cohort ($1, NULL = everyone), as a
 * CTE named `board` with a `visible` flag for the rich-list rule ($2).
 */
function boardCte(boardId: string): string {
  const sql = BOARD_SQL[boardId]!;
  return `WITH board AS (
    SELECT u.id AS user_id, c.alias, ${sql.value} AS value,
           NOT (COALESCE(c.tribe_id, '') = ANY($2::text[])) AS visible
    FROM users u
    LEFT JOIN characters c ON c.user_id = u.id
    ${sql.joins}
    WHERE ($1::uuid[] IS NULL OR u.id = ANY($1::uuid[]))
  )`;
}

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
    scope: Scope,
    limit: number,
    callerUserId?: string,
  ): Promise<BoardEntry[]> {
    const cohort = await this.resolveCohort(boardId, scope, callerUserId);
    if (cohort === undefined || (cohort !== null && cohort.length === 0)) return [];
    const r = await this.ctx.db.withConnection((c) =>
      c.query<{ user_id: string; alias: string | null; value: string | number | null }>(
        `${boardCte(boardId)}
         SELECT user_id, alias, value FROM board
         WHERE visible
         ORDER BY value DESC NULLS LAST, user_id
         LIMIT $3`,
        [cohort, this.hiddenTribes(boardId), limit],
      ),
    );
    return r.rows.map((row, i) => ({
      rank: i + 1,
      userId: row.user_id,
      alias: row.alias ?? '',
      value: Number(row.value ?? 0),
    }));
  }

  /**
   * The caller's own row on a board: their value and the rank they
   * would hold among the visible players in the scope. Returned to the
   * caller only, so a hidden (Anon) player still sees their standing.
   * Null if the caller is outside the scope's cohort.
   */
  async mine(boardId: string, scope: Scope, callerUserId: string): Promise<BoardEntry | null> {
    const cohort = await this.resolveCohort(boardId, scope, callerUserId);
    if (cohort === undefined) return null;
    if (cohort !== null && !cohort.includes(callerUserId)) return null;
    const r = await this.ctx.db.withConnection((c) =>
      c.query<{
        user_id: string;
        alias: string | null;
        value: string | number | null;
        rank: string;
      }>(
        `${boardCte(boardId)}
         SELECT m.user_id, m.alias, m.value,
                1 + (SELECT COUNT(*) FROM board o
                     WHERE o.visible AND o.user_id <> m.user_id
                       AND COALESCE(o.value, 0) > COALESCE(m.value, 0)) AS rank
         FROM board m
         WHERE m.user_id = $3`,
        [cohort, this.hiddenTribes(boardId), callerUserId],
      ),
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      rank: Number(row.rank),
      userId: row.user_id,
      alias: row.alias ?? '',
      value: Number(row.value ?? 0),
    };
  }

  /**
   * Validate the board and resolve the scope to a cohort: null for
   * global, the member ids otherwise, undefined for a board that is
   * not computed yet.
   */
  private async resolveCohort(
    boardId: string,
    scope: Scope,
    callerUserId?: string,
  ): Promise<string[] | null | undefined> {
    if ((scope === 'friends' || scope === 'league') && callerUserId === undefined) {
      throw new ValidationFailedError({ reason: 'caller required for non-global scope' });
    }
    if (EMPTY_BOARDS.has(boardId)) return undefined;
    if (BOARD_SQL[boardId] === undefined) throw new ValidationFailedError({ boardId });
    if (scope === 'friends') return this.friendCohort(callerUserId!);
    if (scope === 'league') return this.leagueCohort(callerUserId!);
    return null;
  }

  private hiddenTribes(boardId: string): readonly string[] {
    return RICH_LIST_BOARDS.has(boardId) ? RICH_LIST_HIDDEN_TRIBES : [];
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
}
