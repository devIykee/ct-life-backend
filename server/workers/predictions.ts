/**
 * Prediction resolution (BullMQ, every 5 s; scheduled in main.ts).
 *
 * Resolves every open prediction whose closes_at is in the past through
 * `resolveClosedPredictions` (server/application/predictions.ts). A
 * prediction is claimed with a conditional status update before any
 * payout, so an overlapping run never pays one twice.
 *
 * Scheduled only with PREDICTIONS_SETTLEMENT_ENABLED=1 (off by default):
 * `resolveOutcome` is still the M3 dev stub, not an oracle, so settling
 * real stakes with it is unsafe.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { resolveClosedPredictions } from '../application/predictions.js';

export const PREDICTIONS_QUEUE = 'jobs-predictions';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 * @returns How many predictions were resolved.
 */
export async function handlePredictions(_job: Job, ctx: AppContext): Promise<number> {
  const n = await resolveClosedPredictions(ctx);
  if (n > 0) console.info(`[predictions] resolved ${n}`);
  return n;
}
