/**
 * District rollover worker (M7 #1).
 *
 * Runs daily at 00:05 UTC. The worker rolls the scores of the day
 * that just ended (`dayToRoll`) and flips ownership when a new tribe
 * outscores the current one. The activity query lives in
 * server/application/district-standings.ts, so
 * `GET /districts/:id/standings` shows live the numbers this writes. `rollDistrictRollover(ctx, dayDate, now)` is
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
import { districtActivity } from '../application/district-standings.js';

export {
  MAX_POSTS_PER_PLAYER_PER_DAY,
  districtActivity,
  type ActivityRow,
} from '../application/district-standings.js';

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
 * The day a run at `now` should roll: the day that just ended. The job fires at
 * 00:05 UTC, so rolling "today" would score only five minutes of activity and
 * hand every district to its default holder.
 * @param now - When the job runs.
 * @returns YYYY-MM-DD (UTC) of the previous day.
 */
export function dayToRoll(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * BullMQ handler wrapper. The worker's main.ts wires this to the
 * `jobs:district-rollover` queue (cron `5 0 * * *`).
 */
export async function handleDistrictRollover(
  job: { data: { dayDate?: string } },
  ctx: AppContext,
): Promise<{ changed: number }> {
  return rollDistrictRollover(ctx, job.data.dayDate ?? dayToRoll(new Date()));
}
