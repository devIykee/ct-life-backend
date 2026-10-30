/**
 * How a player's season ended (`GET /v1/me/season-results?seasonId=`), for the
 * end-of-season share card.
 *
 * Seasons are ISO weeks (`2026-W43`, server/application/season-clock.ts). The
 * rollover (Monday 00:00 UTC, server/application/leagues.ts) writes a
 * `season_memberships` row for the season that starts, so:
 *
 *   - a season is finished once the current week is later than it;
 *   - the player's league in season S is S's row; the row of the next season
 *     the player has (S+1 normally) says where they went: a higher tier is
 *     `promoted`, lower `relegated`, same or no row yet `stayed`;
 *   - `finalRank` is the player's place in S's league by net worth at the end
 *     of S (the next row's `net_worth_cents`, written at the rollover); when
 *     there is no next row yet it falls back to the rank at the start of S.
 *
 * Rewards come from the ledger: `reason = 'season_reward'`, `ref_type =
 * 'season'`, `ref_id = <seasonId>`. Nothing pays a season reward yet, so this
 * is `[]` until a payout exists; it is read, never invented.
 */
import type { AppContext } from './context.js';
import { currentSeasonIso, SEASON_FORMAT } from './season-clock.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';

export type SeasonOutcome = 'promoted' | 'relegated' | 'stayed';

export interface SeasonReward {
  readonly kind: 'cash' | 'item' | 'badge';
  readonly cashCents: number | null;
  readonly itemId: string | null;
  readonly badgeId: string | null;
}

export interface SeasonResult {
  readonly seasonId: string;
  readonly leagueId: string;
  readonly finalRank: number;
  readonly outcome: SeasonOutcome;
  readonly toLeagueId: string | null;
  readonly rewards: readonly SeasonReward[];
}

interface MembershipDbRow {
  season_iso: string;
  league_id: string;
  rank: number;
  net_worth_cents: string;
}

/**
 * League order from the contract (bottom tier first), so promotion is decided
 * the same way whether or not the leagues table has been seeded.
 * @param ctx - The app context.
 * @returns league id -> tier index.
 */
function tierIndex(ctx: AppContext): Map<string, number> {
  const cfg = ctx.configCache.load<{ leagues: Array<{ id: string }> }>('leagues');
  return new Map(cfg.leagues.map((l, i) => [l.id, i]));
}

/**
 * @param fromLeague - The league in the finished season.
 * @param nextLeague - The league in the following season, or null.
 * @param tiers - league id -> tier index.
 * @returns The outcome and the destination league (null when stayed).
 */
export function seasonOutcome(
  fromLeague: string,
  nextLeague: string | null,
  tiers: ReadonlyMap<string, number>,
): { outcome: SeasonOutcome; toLeagueId: string | null } {
  if (nextLeague === null || nextLeague === fromLeague)
    return { outcome: 'stayed', toLeagueId: null };
  const from = tiers.get(fromLeague) ?? -1;
  const to = tiers.get(nextLeague) ?? -1;
  if (to > from) return { outcome: 'promoted', toLeagueId: nextLeague };
  if (to < from) return { outcome: 'relegated', toLeagueId: nextLeague };
  return { outcome: 'stayed', toLeagueId: null };
}

/**
 * The result of `seasonId`, or of the latest finished season when omitted.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param seasonId - An ISO week, e.g. `2026-W43`, or undefined.
 * @param now - Injectable clock.
 * @returns The result; `404 NOT_FOUND` when the player has no finished season.
 */
export async function getSeasonResults(
  ctx: AppContext,
  userId: string,
  seasonId: string | undefined,
  now: Date = new Date(),
): Promise<SeasonResult> {
  if (seasonId !== undefined && !SEASON_FORMAT.test(seasonId)) {
    throw new ValidationFailedError({ field: 'seasonId', reason: 'expected YYYY-Www' });
  }
  const current = currentSeasonIso(now);
  if (seasonId !== undefined && seasonId >= current) {
    throw new NotFoundError({ kind: 'season_result', seasonId, reason: 'not_finished' });
  }
  return ctx.db.withConnection(async (c) => {
    const own = await c.query<MembershipDbRow>(
      `SELECT season_iso, league_id, rank, net_worth_cents
         FROM season_memberships
        WHERE user_id = $1 AND season_iso < $2 AND ($3::text IS NULL OR season_iso = $3)
        ORDER BY season_iso DESC LIMIT 1`,
      [userId, current, seasonId ?? null],
    );
    const row = own.rows[0];
    if (!row) throw new NotFoundError({ kind: 'season_result', seasonId: seasonId ?? null });

    const next = await c.query<MembershipDbRow>(
      `SELECT season_iso, league_id, rank, net_worth_cents
         FROM season_memberships
        WHERE user_id = $1 AND season_iso > $2
        ORDER BY season_iso ASC LIMIT 1`,
      [userId, row.season_iso],
    );
    const after = next.rows[0] ?? null;

    let finalRank = row.rank;
    if (after) {
      // Place in S's league by end-of-season net worth (the next row's).
      const ahead = await c.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM season_memberships s
           JOIN season_memberships nx ON nx.user_id = s.user_id AND nx.season_iso = $3
          WHERE s.season_iso = $1 AND s.league_id = $2 AND nx.net_worth_cents > $4`,
        [row.season_iso, row.league_id, after.season_iso, after.net_worth_cents],
      );
      finalRank = Number(ahead.rows[0]?.n ?? 0) + 1;
    }

    const paid = await c.query<{ delta_cents: string }>(
      `SELECT delta_cents FROM ledger_entries
        WHERE user_id = $1 AND account = 'cash' AND reason = 'season_reward'
          AND ref_type = 'season' AND ref_id = $2
        ORDER BY id`,
      [userId, row.season_iso],
    );
    const rewards: SeasonReward[] = paid.rows.map((p) => ({
      kind: 'cash',
      cashCents: Number(p.delta_cents),
      itemId: null,
      badgeId: null,
    }));

    const { outcome, toLeagueId } = seasonOutcome(
      row.league_id,
      after?.league_id ?? null,
      tierIndex(ctx),
    );
    return {
      seasonId: row.season_iso,
      leagueId: row.league_id,
      finalRank,
      outcome,
      toLeagueId,
      rewards,
    };
  });
}
