/**
 * Leagues + seasons service (M7 #2).
 *
 * Endpoints:
 *
 *   GET /v1/leagues                  — list every league tier
 *   GET /v1/leagues/{slug}           — get a league tier by slug
 *   GET /v1/me/league                — the caller's current season membership
 *
 * Rollover (worker):
 *
 *   runSeasonRollover(seasonIso)     — assign a season_memberships
 *                                       row to every user with a balance,
 *                                       ranked by net worth within each
 *                                       league's max_members cap. Idempotent
 *                                       on (user_id, season_iso).
 *
 * Promotion rules (contract/config/leagues.json):
 *
 *   - A league has min_net_worth_cents (entry floor) + max_members
 *     (cap). Players with net_worth < next_league.min_net_worth_cents
 *     stay in the current league; players above the cap are demoted
 *     to the next league down.
 *   - The worker is the only writer of season_memberships.rank
 *     and season_memberships.promoted_from_league_id.
 *
 * The season_iso format is opaque to the application; the worker
 * picks a 30-day rolling window (e.g. '2026-Q4-w3' or '2026-W40')
 * and stays with it across rollovers. The unit test exercises
 * both formats.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

interface LeagueConfigEntry {
  id: string;
  label: string;
  minNetWorthCents: number;
  maxMembers: number;
  promote: string | null;
}

export interface LeagueRow {
  readonly leagueId: string;
  readonly slug: string;
  readonly label: string;
  readonly minNetWorthCents: number;
  readonly maxMembers: number;
  readonly sortOrder: number;
  readonly promoteToSlug: string | null;
}

export interface SeasonMembershipRow {
  readonly userId: string;
  readonly seasonIso: string;
  readonly leagueId: string;
  readonly netWorthCents: number;
  readonly rank: number;
  readonly promotedFromLeagueId: string | null;
}

interface LeagueDbRow {
  league_id: string;
  slug: string;
  label: string;
  min_net_worth_cents: string;
  max_members: number;
  sort_order: number;
  promote_to_slug: string | null;
}

interface MembershipDbRow {
  user_id: string;
  season_iso: string;
  league_id: string;
  net_worth_cents: string;
  rank: number;
  promoted_from_league_id: string | null;
}

interface BalanceRow {
  user_id: string;
  net_worth_cents: string;
}

function readConfig(ctx: AppContext): {
  leagues: LeagueConfigEntry[];
  seasonLengthDays: number;
} {
  return ctx.configCache.load<{
    leagues: LeagueConfigEntry[];
    seasonLengthDays: number;
  }>('leagues');
}

/** Idempotently seed the league tier table from the config. */
export async function ensureLeagues(ctx: AppContext): Promise<void> {
  const cfg = readConfig(ctx);
  // Build the promote map.
  const promoteMap = new Map<string, string | null>();
  for (const l of cfg.leagues) {
    if (l.promote !== null && l.promote.startsWith('above:')) {
      promoteMap.set(l.id, l.promote.slice('above:'.length));
    } else {
      promoteMap.set(l.id, null);
    }
  }
  for (let i = 0; i < cfg.leagues.length; i++) {
    const l = cfg.leagues[i]!;
    const promoteTo = promoteMap.get(l.id) ?? null;
    await ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO leagues (league_id, slug, label, min_net_worth_cents,
                              max_members, sort_order, promote_to_slug)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (league_id) DO UPDATE
           SET label = EXCLUDED.label,
               min_net_worth_cents = EXCLUDED.min_net_worth_cents,
               max_members = EXCLUDED.max_members,
               sort_order = EXCLUDED.sort_order,
               promote_to_slug = EXCLUDED.promote_to_slug`,
        [l.id, l.id, l.label, l.minNetWorthCents, l.maxMembers, i, promoteTo],
      );
    });
  }
}

/** List every league tier. */
export async function listLeagues(ctx: AppContext): Promise<LeagueRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<LeagueDbRow>(
      `SELECT league_id, slug, label, min_net_worth_cents, max_members,
              sort_order, promote_to_slug
       FROM leagues ORDER BY sort_order`,
    );
  });
  return r.rows.map(rowToLeague);
}

/** Get a league tier by slug. */
export async function getLeague(ctx: AppContext, slug: string): Promise<LeagueRow> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<LeagueDbRow>(
      `SELECT league_id, slug, label, min_net_worth_cents, max_members,
              sort_order, promote_to_slug
       FROM leagues WHERE slug = $1`,
      [slug],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ kind: 'league', slug });
  return rowToLeague(row);
}

/** The caller's current season membership. */
export async function getMyLeague(
  ctx: AppContext,
  userId: string,
  seasonIso: string,
): Promise<SeasonMembershipRow | null> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<MembershipDbRow>(
      `SELECT user_id, season_iso, league_id, net_worth_cents, rank,
              promoted_from_league_id
       FROM season_memberships
       WHERE user_id = $1 AND season_iso = $2`,
      [userId, seasonIso],
    );
  });
  const row = r.rows[0];
  if (!row) return null;
  return rowToMembership(row);
}

/** The list of user_ids in a season's league (the cohort for boards). */
export async function getLeagueCohort(
  ctx: AppContext,
  seasonIso: string,
  leagueId: string,
): Promise<string[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ user_id: string }>(
      `SELECT user_id FROM season_memberships
       WHERE season_iso = $1 AND league_id = $2
       ORDER BY rank ASC`,
      [seasonIso, leagueId],
    );
  });
  return r.rows.map((row) => row.user_id);
}

/**
 * Compute the season membership for every user with a balance. The
 * assignment rule:
 *
 *   - net_worth = cash_cents - debt_cents (the M2 formula).
 *   - Start at the lowest league (sort_order 0) and walk up; the
 *     first league whose min_net_worth_cents <= net_worth is the
 *     candidate.
 *   - If that league already has max_members members, drop to the
 *     next league down and try again. If the bottom league is full,
 *     the player is assigned to the bottom league and rank continues
 *     to grow (the cap is a soft cap for the top leagues; iron
 *     absorbs overflow).
 *
 * Idempotent: re-running the same seasonIso is a no-op (ON CONFLICT
 * (user_id, season_iso) DO UPDATE).
 */
export async function runSeasonRollover(
  ctx: AppContext,
  seasonIso: string,
): Promise<{
  totalAssigned: number;
  promoted: number;
  relegated: number;
}> {
  // Read leagues, sorted bottom-up by sort_order.
  const leagues = await listLeagues(ctx);
  // Read every user's net worth.
  const balances = await ctx.db.withConnection(async (c) => {
    return c.query<BalanceRow>(
      `SELECT b.user_id,
              (b.cash_cents - b.debt_cents) AS net_worth_cents
       FROM balances b
       WHERE b.user_id IS NOT NULL`,
    );
  });
  // Sort by net worth descending.
  const sorted = balances.rows.sort((a, b) =>
    Number(BigInt(b.net_worth_cents) - BigInt(a.net_worth_cents)),
  );
  // Walk the list, assign each player to the highest league whose
  // min_net_worth_cents <= net_worth and has remaining capacity.
  const counts = new Map<string, number>();
  for (const l of leagues) counts.set(l.leagueId, 0);
  // Read the prior season's memberships to set promoted_from_league_id.
  const priorSeason = priorSeasonIso(seasonIso);
  const priorMembers = new Map<string, string>();
  if (priorSeason !== null) {
    const r = await ctx.db.withConnection(async (c) => {
      return c.query<{ user_id: string; league_id: string }>(
        `SELECT user_id, league_id FROM season_memberships WHERE season_iso = $1`,
        [priorSeason],
      );
    });
    for (const row of r.rows) priorMembers.set(row.user_id, row.league_id);
  }
  let promoted = 0;
  let relegated = 0;
  let totalAssigned = 0;
  await runInTransaction(async (client) => {
    for (const b of sorted) {
      const netWorth = Number(BigInt(b.net_worth_cents));
      // Find the highest league whose min <= netWorth.
      let chosen: LeagueRow | null = null;
      for (let i = leagues.length - 1; i >= 0; i--) {
        const l = leagues[i]!;
        if (Number(l.minNetWorthCents) <= netWorth) {
          chosen = l;
          break;
        }
      }
      if (chosen === null) chosen = leagues[0]!;
      // If the chosen league is full, drop to the next league down.
      while (chosen !== null && (counts.get(chosen.leagueId) ?? 0) >= chosen.maxMembers) {
        const idx = leagues.findIndex((l) => l.leagueId === chosen!.leagueId);
        if (idx <= 0) break;
        chosen = leagues[idx - 1]!;
      }
      const rank = (counts.get(chosen.leagueId) ?? 0) + 1;
      counts.set(chosen.leagueId, rank);
      const promotedFrom = priorMembers.get(b.user_id) ?? null;
      if (promotedFrom !== null && promotedFrom !== chosen.leagueId) {
        // Compare sort_order to detect promotion vs relegation.
        const fromIdx = leagues.findIndex((l) => l.leagueId === promotedFrom);
        const toIdx = leagues.findIndex((l) => l.leagueId === chosen!.leagueId);
        if (toIdx > fromIdx) promoted++;
        else if (toIdx < fromIdx) relegated++;
      }
      await client.query(
        `INSERT INTO season_memberships
           (membership_id, user_id, season_iso, league_id, net_worth_cents,
            rank, promoted_from_league_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, season_iso) DO UPDATE
           SET league_id = EXCLUDED.league_id,
               net_worth_cents = EXCLUDED.net_worth_cents,
               rank = EXCLUDED.rank,
               promoted_from_league_id = EXCLUDED.promoted_from_league_id`,
        [uuidv7(), b.user_id, seasonIso, chosen.leagueId, netWorth.toString(), rank, promotedFrom],
      );
      totalAssigned++;
    }
    // Write the rollover log.
    await client.query(
      `INSERT INTO season_rollover_log (log_id, kind, season_iso, payload)
       VALUES ($1, 'season_rollover', $2, $3)
       ON CONFLICT (kind, season_iso) DO NOTHING`,
      [uuidv7(), seasonIso, JSON.stringify({ totalAssigned, promoted, relegated })],
    );
  });
  return { totalAssigned, promoted, relegated };
}

/**
 * The previous season's iso, or null if the format is unknown. The
 * caller passes the current season iso; this is best-effort
 * (weekIso -> prior week; arbitrary strings return null).
 */
function priorSeasonIso(seasonIso: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(seasonIso);
  if (m === null) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week > 1) return `${year}-W${String(week - 1).padStart(2, '0')}`;
  // ISO week 1 of year+1 is week 52 or 53 of year-1; we just
  // walk back the calendar.
  return `${year - 1}-W52`;
}

function rowToLeague(r: LeagueDbRow): LeagueRow {
  return {
    leagueId: r.league_id,
    slug: r.slug,
    label: r.label,
    minNetWorthCents: Number(r.min_net_worth_cents),
    maxMembers: r.max_members,
    sortOrder: r.sort_order,
    promoteToSlug: r.promote_to_slug,
  };
}

function rowToMembership(r: MembershipDbRow): SeasonMembershipRow {
  return {
    userId: r.user_id,
    seasonIso: r.season_iso,
    leagueId: r.league_id,
    netWorthCents: Number(r.net_worth_cents),
    rank: r.rank,
    promotedFromLeagueId: r.promoted_from_league_id,
  };
}
