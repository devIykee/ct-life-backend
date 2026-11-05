/**
 * Map Travel sweep (docs/TRAVEL.md): every 30 s, refund booked trips whose arrival ticket
 * expired unused (`expires_at` passed), in full and once each (ledger `travel_refund`,
 * idempotency_ref `travel-refund:<tripId>`), and end them `expired_refunded`. An arrived
 * trip is never refunded. Runs whether or not `travel` is on, so trips booked before the
 * capability is switched off are still settled.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { sweepTravelTrips } from '../application/travel.js';

export const TRAVEL_SWEEP_QUEUE = 'jobs-travel-sweep';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 */
export async function handleTravelSweep(_job: Job, ctx: AppContext): Promise<void> {
  try {
    await sweepTravelTrips(ctx);
  } catch (e) {
    console.error('[travel-sweep] failed:', (e as Error).message);
  }
}
