/**
 * Push worker.
 *
 * One repeatable job every 5 minutes runs the two time-driven sweeps:
 *
 *   streak_ending   from 3 hours before the UTC reset, to players who claimed
 *                   yesterday and not today
 *   daily_clue      once per UTC day per player, outside their quiet hours
 *
 * Liquidation and home-visit pushes are event driven: the services call
 * `notifyLiquidated` / `notifyHomeVisit` after their commit. Every send goes through
 * `sendPush` (push-delivery.ts), so with no FCM credentials the whole worker is a no-op.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import {
  sweepDailyClue,
  sweepStreakEnding,
  type PushTransport,
} from '../application/push-delivery.js';

export const PUSH_QUEUE = 'jobs-push';

/**
 * Run both sweeps.
 * @param ctx - The app context.
 * @param now - The current time (injectable for tests).
 * @param transport - The transport (for tests).
 * @returns How many pushes each sweep sent.
 */
export async function runPushSweep(
  ctx: AppContext,
  now: Date = new Date(),
  transport?: PushTransport | null,
): Promise<{ streakEnding: number; dailyClue: number }> {
  const streakEnding = await sweepStreakEnding(ctx, now, transport);
  const dailyClue = await sweepDailyClue(ctx, now, transport);
  return { streakEnding, dailyClue };
}

/**
 * BullMQ handler for `jobs-push`. Errors are logged, not thrown: the next sweep is the retry.
 * @param _job - The job.
 * @param ctx - The app context.
 */
export async function handlePush(_job: Job, ctx: AppContext): Promise<void> {
  try {
    await runPushSweep(ctx);
  } catch (e) {
    console.error('[push] sweep failed:', (e as Error).message);
  }
}
