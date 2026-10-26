/**
 * Rekt Burger sweep: once a minute, close clock-in shifts that ran to their maximum
 * length and pay them up to it, so a player who closed the app is paid without coming back.
 * Each close runs under the same row lock as a clock-out, so it cannot double pay.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { sweepRektShifts } from '../application/rekt-burger.js';

export const REKT_SWEEP_QUEUE = 'jobs-rekt-sweep';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 */
export async function handleRektSweep(_job: Job, ctx: AppContext): Promise<void> {
  try {
    await sweepRektShifts(ctx);
  } catch (e) {
    console.error('[rekt-sweep] failed:', (e as Error).message);
  }
}
