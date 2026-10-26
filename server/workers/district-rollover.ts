/**
 * District rollover worker (M7 #1).
 *
 * Runs daily at 00:05 UTC. The worker rolls the day's district
 * scores and flips ownership when a new tribe outscores the
 * current one. `rollDistrictRollover(ctx, dayDate, now)` is
 * exported so tests can drive the rollover without spinning up
 * BullMQ. The BullMQ handler (`handleDistrictRollover`) wires it
 * to the `jobs:district-rollover` queue.
 *
 * Score formula (server-authoritative; the client never picks):
 *
 *   score(tribe, district, day) =
 *     base_score_per_day
 *     + posts and check-ins in that district by members of that tribe
 *       (joined through characters.tribe_id) on that day, at most
 *       MAX_POSTS_PER_PLAYER_PER_DAY per player.
 *
 * Districts with zero activity roll over to their
 * `default_holder_tribe_id` (the tribe whose `homeTurf` matches
 * the district slug, or `trencher` for the marina/cabal districts).
 */
import type { AppContext } from '../application/context.js';
import { rollDailyDistrict } from '../application/tribes.js';

export interface ActivityRow {
  district_id: string;
  tribe_id: string;
  post_count: number;
}

/** Most posts one player can add to a district's score per day. */
export const MAX_POSTS_PER_PLAYER_PER_DAY = 3;

/**
 * The day's activity per district and tribe: player posts and check-ins (not
 * server-written career posts or NPC authors), each player counting at most
 * MAX_POSTS_PER_PLAYER_PER_DAY times per district, so one spammer cannot carry
 * a tribe. feed_posts.district_slug is set from the server's position hash
 * when a player posts (migration 102).
 * @param ctx - The app context.
 * @param dayDate - The UTC day, YYYY-MM-DD.
 * @returns One row per district and tribe with activity.
 */
export async function districtActivity(ctx: AppContext, dayDate: string): Promise<ActivityRow[]> {
  const r = await ctx.db.withConnection((c) =>
    c.query<ActivityRow>(
      `SELECT d.district_id, ch.tribe_id, SUM(LEAST(per_user.n, $2))::int AS post_count
         FROM (SELECT p.user_id, p.district_slug, COUNT(*) AS n
                 FROM feed_posts p
                WHERE p.district_slug IS NOT NULL
                  AND (p.kind IS NULL OR p.kind IN ('player', 'checkin'))
                  AND p.created_at >= $1::timestamptz
                  AND p.created_at < $1::timestamptz + interval '1 day'
                GROUP BY p.user_id, p.district_slug) per_user
         JOIN districts d ON d.slug = per_user.district_slug
         JOIN characters ch ON ch.user_id = per_user.user_id
        GROUP BY d.district_id, ch.tribe_id`,
      [`${dayDate}T00:00:00Z`, MAX_POSTS_PER_PLAYER_PER_DAY],
    ),
  );
  return r.rows;
}

/**
 * Roll the daily district scores + flip ownership.
 * The `now` parameter is injectable for tests.
 */
export async function rollDistrictRollover(
  ctx: AppContext,
  dayDate: string,
  now: Date = new Date(),
): Promise<{ changed: number }> {
  const activity = { rows: await districtActivity(ctx, dayDate) };
  // Districts + their default holders + base scores.
  const districts = await ctx.db.withConnection(async (c) => {
    return c.query<{
      district_id: string;
      default_holder_tribe_id: string;
      base_score_per_day: number;
    }>(`SELECT district_id, default_holder_tribe_id, base_score_per_day FROM districts`);
  });
  // Build the per-tribe-per-district score map.
  const scores = new Map<string, Map<string, number>>();
  for (const d of districts.rows) {
    const inner = new Map<string, number>();
    inner.set(d.default_holder_tribe_id, Number(d.base_score_per_day));
    scores.set(d.district_id, inner);
  }
  for (const r of activity.rows) {
    const inner = scores.get(r.district_id) ?? new Map<string, number>();
    const cur = inner.get(r.tribe_id) ?? 0;
    inner.set(r.tribe_id, cur + Number(r.post_count));
    scores.set(r.district_id, inner);
  }
  return rollDailyDistrict(dayDate, scores, now);
}

/**
 * BullMQ handler wrapper. The worker's main.ts wires this to the
 * `jobs:district-rollover` queue (cron `5 0 * * *`).
 */
export async function handleDistrictRollover(
  job: { data: { dayDate?: string } },
  ctx: AppContext,
): Promise<{ changed: number }> {
  const dayDate = job.data.dayDate ?? new Date().toISOString().slice(0, 10);
  return rollDistrictRollover(ctx, dayDate);
}
