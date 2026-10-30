/**
 * Alpha call grading (BullMQ, every 30 s; scheduled in main.ts).
 *
 * Calls `evaluateAlphaCalls` to resolve any open call whose target or stop
 * has been hit, or whose 7-day expiry has passed. Each resolution is a
 * conditional update (`AND status = 'open'`), so overlapping runs are safe.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { evaluateAlphaCalls } from '../application/alpha.js';

export const ALPHA_GRADING_QUEUE = 'jobs-alpha-grading';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 * @returns How many calls were resolved.
 */
export async function handleAlphaGrading(_job: Job, ctx: AppContext): Promise<number> {
  const n = await evaluateAlphaCalls(ctx);
  if (n > 0) console.info(`[alpha] resolved ${n} call(s)`);
  return n;
}
