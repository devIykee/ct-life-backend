/**
 * Prediction market generator (BullMQ, every minute at :00; scheduled in
 * main.ts). See server/application/prediction-markets.ts.
 *
 * Fails closed: it opens markets only while both the `predict` capability
 * and PREDICTIONS_SETTLEMENT_ENABLED are on in the workers process, so no
 * market ever takes bets that nothing would settle. `crypto` markets also
 * need PREDICTIONS_CRYPTO_SOURCE; without it only `sim` and `event` open.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { isCapabilityOn } from '../application/capabilities.js';
import { generateMarkets } from '../application/prediction-markets.js';
import { referencePriceSource } from '../application/price-source.js';

export const PREDICTION_MARKETS_QUEUE = 'jobs-prediction-markets';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 * @param now - The current time (tests pass a fixed one).
 * @returns How many markets were opened (0 while off).
 */
export async function handlePredictionMarkets(
  _job: Job,
  ctx: AppContext,
  now: Date = new Date(),
): Promise<number> {
  if (!ctx.config.features.predictionSettlement || !isCapabilityOn(ctx, 'predict')) return 0;
  return generateMarkets(ctx, now, referencePriceSource(ctx));
}
