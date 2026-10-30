/**
 * Prediction settlement (BullMQ, every 5 s; scheduled in main.ts).
 *
 * Resolves due markets from their recorded source values and pays or
 * refunds the bets on them through `resolveClosedPredictions`
 * (server/application/predictions.ts, prediction-resolver.ts). A bet is
 * claimed with a conditional status update before any payout, so an
 * overlapping run never pays one twice.
 *
 * Scheduled only with PREDICTIONS_SETTLEMENT_ENABLED=1 (off by default, fail
 * closed). Since unlock D3 the coin-flip stub is gone: every outcome comes
 * from a value recorded at the market's `resolvesAt`.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { resolveClosedPredictions } from '../application/predictions.js';
import { referencePriceSource } from '../application/price-source.js';

export const PREDICTIONS_QUEUE = 'jobs-predictions';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 * @returns How many bets were settled.
 */
export async function handlePredictions(_job: Job, ctx: AppContext): Promise<number> {
  const n = await resolveClosedPredictions(ctx, referencePriceSource(ctx));
  if (n > 0) console.info(`[predictions] settled ${n}`);
  return n;
}
