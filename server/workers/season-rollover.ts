/**
 * Season rollover worker (M7 #2).
 *
 * Runs every Monday at 00:00 UTC (the spec's "Monday 00:00 UTC
 * resets" cadence). Calls `runSeasonRollover(seasonIso)` which
 * is the only writer of `season_memberships` + the only writer
 * of `season_rollover_log` (idempotent on UNIQUE
 * (kind, season_iso)). The handler is exported so tests drive
 * the rollover without spinning up BullMQ.
 */
import type { AppContext } from '../application/context.js';
import { runSeasonRollover } from '../application/leagues.js';
import { currentSeasonIso } from '../application/season-clock.js';

/**
 * BullMQ handler for the season rollover job. Wired to the
 * `jobs:season-rollover` queue (cron `0 0 * * 1` — Mon 00:00 UTC).
 *
 * @param job - BullMQ job whose data may carry a `seasonIso` override.
 * @param ctx - Application context; the worker's only writer of
 *              `season_memberships` + `season_rollover_log`.
 * @returns The number of users assigned, promoted, and relegated.
 */
export async function handleSeasonRollover(
  job: { data: { seasonIso?: string } },
  ctx: AppContext,
): Promise<{ totalAssigned: number; promoted: number; relegated: number }> {
  const seasonIso = job.data.seasonIso ?? currentSeasonIso();
  return runSeasonRollover(ctx, seasonIso);
}
