/**
 * Rug Room sweep: once a minute, refund head-to-head challenges that ran
 * past their 2 minutes and close crash rounds nobody cashed out of. Both
 * are also handled lazily when the player next touches the casino, so the
 * worker only keeps the books tidy (a pending stake is Cash the player
 * cannot see). Every step runs under the same row locks as a request.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { sweepCasino } from '../application/casino.js';

export const CASINO_SWEEP_QUEUE = 'jobs-casino-sweep';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 */
export async function handleCasinoSweep(_job: Job, ctx: AppContext): Promise<void> {
  try {
    await sweepCasino(ctx);
  } catch (e) {
    console.error('[casino-sweep] failed:', (e as Error).message);
  }
}
