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
 *     + count of feed_posts in that district by members of that
 *       tribe (joined through characters.tribe_id) on that day.
 *
 * Districts with zero activity roll over to their
 * `default_holder_tribe_id` (the tribe whose `homeTurf` matches
 * the district slug, or `trencher` for the marina/cabal districts).
 */
import type { AppContext } from '../application/context.js';
import { rollDailyDistrict } from '../application/tribes.js';

interface ActivityRow {
  district_id: string;
  tribe_id: string;
  post_count: number;
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
  // Pull the day's activity per tribe per district. The tribe_id
  // is the poster's character.tribe_id.
  const activity = await ctx.db.withConnection(async (c) => {
    return c.query<ActivityRow>(
      `SELECT d.district_id,
              COALESCE(ch.tribe_id, 'anon') AS tribe_id,
              COALESCE(COUNT(p.post_id), 0)::int AS post_count
       FROM districts d
       LEFT JOIN characters ch ON true
       LEFT JOIN feed_posts p
         ON p.user_id = ch.user_id
            AND p.district_slug = d.slug
            AND p.created_at >= $1::timestamptz
            AND p.created_at < $2::timestamptz
       GROUP BY d.district_id, ch.tribe_id`,
      [`${dayDate}T00:00:00Z`, `${dayDate}T23:59:59.999Z`],
    );
  });
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
