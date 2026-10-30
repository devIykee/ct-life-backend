/**
 * District standings: today's tribe scores in one district and the caller's
 * own contribution (`GET /v1/districts/:id/standings`).
 *
 * The score is the same formula the daily rollover uses
 * (server/workers/district-rollover.ts), computed live for today:
 *
 *   score(tribe) = base_score_per_day (default holder only)
 *                + player posts and check-ins in the district today by members
 *                  of that tribe, each player counting at most
 *                  MAX_POSTS_PER_PLAYER_PER_DAY times.
 *
 * The rollover at 00:05 UTC (`rolloverAt`) writes yesterday's final scores to
 * `tribe_district_scores` and flips the owner. `myContribution` is the caller's
 * capped count today; it is null for the `anon` tribe (hidden by design) and
 * for a player with no character.
 */
import type { AppContext } from './context.js';
import { listDistricts } from './tribes.js';
import { NotFoundError } from '../shared/domain/errors.js';

/** Most posts one player can add to a district's score per day. */
export const MAX_POSTS_PER_PLAYER_PER_DAY = 3;
/** Minutes past UTC midnight when the rollover worker runs (cron `5 0 * * *`). */
export const ROLLOVER_MINUTE_UTC = 5;
/** The tribe whose members' contributions are never shown. */
const HIDDEN_TRIBE = 'anon';

export interface ActivityRow {
  district_id: string;
  tribe_id: string;
  post_count: number;
}

export interface DistrictStandings {
  readonly districtId: string;
  readonly dayDate: string;
  readonly rolloverAt: string;
  readonly standings: ReadonlyArray<{ tribeId: string; score: number }>;
  readonly myTribeId: string | null;
  readonly myContribution: number | null;
}

/**
 * The day's capped activity per district and tribe (player posts and
 * check-ins, not server-written career posts or NPC authors).
 * @param ctx - The app context.
 * @param dayDate - The UTC day, YYYY-MM-DD.
 * @param districtSlug - Only this district, or every district when omitted.
 * @returns One row per district and tribe with activity.
 */
export async function districtActivity(
  ctx: AppContext,
  dayDate: string,
  districtSlug?: string,
): Promise<ActivityRow[]> {
  const r = await ctx.db.withConnection((c) =>
    c.query<ActivityRow>(
      `SELECT d.district_id, ch.tribe_id, SUM(LEAST(per_user.n, $2))::int AS post_count
         FROM (SELECT p.user_id, p.district_slug, COUNT(*) AS n
                 FROM feed_posts p
                WHERE p.district_slug IS NOT NULL
                  AND ($3::text IS NULL OR p.district_slug = $3)
                  AND (p.kind IS NULL OR p.kind IN ('player', 'checkin'))
                  AND p.created_at >= $1::timestamptz
                  AND p.created_at < $1::timestamptz + interval '1 day'
                GROUP BY p.user_id, p.district_slug) per_user
         JOIN districts d ON d.slug = per_user.district_slug
         JOIN characters ch ON ch.user_id = per_user.user_id
        GROUP BY d.district_id, ch.tribe_id`,
      [`${dayDate}T00:00:00Z`, MAX_POSTS_PER_PLAYER_PER_DAY, districtSlug ?? null],
    ),
  );
  return r.rows;
}

/**
 * @param now - The current time.
 * @returns Today's UTC date (YYYY-MM-DD) and the next rollover instant.
 */
export function standingsDay(now: Date): { dayDate: string; rolloverAt: string } {
  const dayDate = now.toISOString().slice(0, 10);
  const next = new Date(`${dayDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  next.setUTCMinutes(ROLLOVER_MINUTE_UTC);
  return { dayDate, rolloverAt: next.toISOString() };
}

/**
 * Today's standings in a district.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param districtId - `districts.district_id`.
 * @param now - Injectable clock.
 * @returns The standings, highest score first.
 */
export async function getDistrictStandings(
  ctx: AppContext,
  userId: string,
  districtId: string,
  now: Date = new Date(),
): Promise<DistrictStandings> {
  // listDistricts seeds the table on first use, so a fresh deploy still answers.
  const district = (await listDistricts(ctx)).find((d) => d.districtId === districtId);
  if (!district) throw new NotFoundError({ kind: 'district', id: districtId });
  const { dayDate, rolloverAt } = standingsDay(now);

  const scores = new Map<string, number>();
  if (district.baseScorePerDay > 0) {
    scores.set(district.defaultHolderTribeId, district.baseScorePerDay);
  }
  for (const row of await districtActivity(ctx, dayDate, district.slug)) {
    scores.set(row.tribe_id, (scores.get(row.tribe_id) ?? 0) + Number(row.post_count));
  }
  const standings = [...scores.entries()]
    .map(([tribeId, score]) => ({ tribeId, score }))
    .sort((a, b) => b.score - a.score || a.tribeId.localeCompare(b.tribeId));

  const mine = await ctx.db.withConnection((c) =>
    c.query<{ tribe_id: string; n: number }>(
      `SELECT ch.tribe_id,
              LEAST((SELECT COUNT(*) FROM feed_posts p
                      WHERE p.user_id = ch.user_id
                        AND p.district_slug = $2
                        AND (p.kind IS NULL OR p.kind IN ('player', 'checkin'))
                        AND p.created_at >= $3::timestamptz
                        AND p.created_at < $3::timestamptz + interval '1 day'), $4)::int AS n
         FROM characters ch WHERE ch.user_id = $1`,
      [userId, district.slug, `${dayDate}T00:00:00Z`, MAX_POSTS_PER_PLAYER_PER_DAY],
    ),
  );
  const me = mine.rows[0];
  const myTribeId = me?.tribe_id ?? null;
  const myContribution = me && me.tribe_id !== HIDDEN_TRIBE ? Number(me.n) : null;
  return { districtId, dayDate, rolloverAt, standings, myTribeId, myContribution };
}
