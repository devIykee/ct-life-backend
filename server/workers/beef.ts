/**
 * CT Beef phase worker (unlock A6): every 15 s, move matches whose phase ended
 * (open -> expired, active -> voting, voting -> closed) and push beef_update /
 * beef_result (server/application/beef-close.ts). Every action also re-checks
 * the timer, so the worker running late never changes an outcome; it only
 * decides when the result is published.
 *
 * Scheduled only while the app capability `beef` is on (no new matches exist
 * otherwise); with it off the scheduler is removed, the same fail-closed
 * pattern as the predictions worker.
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Redis as IORedis } from 'ioredis';
import type { AppContext } from '../application/context.js';
import { advanceBeefPhases } from '../application/beef-close.js';
import { isCapabilityOn } from '../application/capabilities.js';

export const BEEF_PHASES_QUEUE = 'jobs-beef-phases';
/** How often the sweep runs. */
export const BEEF_PHASES_EVERY_MS = 15_000;

interface Log {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 */
export async function handleBeefPhases(_job: Job, ctx: AppContext): Promise<{ moved: number }> {
  return advanceBeefPhases(ctx);
}

/**
 * Create the queue and the worker, and schedule the sweep while `beef` is on.
 * @param ctx - The app context.
 * @param conn - The BullMQ queue connection.
 * @param workerConnection - A dedicated connection for the worker.
 * @param log - The workers logger.
 * @returns A closer for shutdown.
 */
export async function startBeefPhases(
  ctx: AppContext,
  conn: ConnectionOptions,
  workerConnection: IORedis,
  log: Log,
): Promise<{ close(): Promise<void> }> {
  const queue = new Queue(BEEF_PHASES_QUEUE, { connection: conn });
  const worker = new Worker(BEEF_PHASES_QUEUE, async (job) => handleBeefPhases(job, ctx), {
    connection: workerConnection,
  });
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'beef-phases failed'),
  );
  if (isCapabilityOn(ctx, 'beef')) {
    await queue.upsertJobScheduler(
      'beef-phases',
      { every: BEEF_PHASES_EVERY_MS },
      { name: 'sweep', data: {} },
    );
  } else {
    await queue.removeJobScheduler('beef-phases');
    log.info({}, 'beef phases off (capability beef not in CAPABILITIES_ON)');
  }
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
