/**
 * Builder worker: one BullMQ queue, three job schedulers.
 *
 *   payroll        Monday 00:00 UTC  wages (game-paid) + operating cost (treasury)
 *   risk           daily 12:00 UTC   exploit / rug accusation / audit, price shock
 *   expire-offers  hourly at :07     pending role offers past expiry -> expired
 *
 * Every handler is idempotent (payroll runs table, a per-day Redis claim for
 * risk, a conditional UPDATE for offers), so a retried or overlapping job
 * never pays or rolls twice. Logic lives in server/application/project-*.ts.
 */
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import type { Logger } from 'pino';
import type { AppContext } from '../application/context.js';
import { expireOffers } from '../application/project-offers.js';
import { runDailyRisk, runWeeklyPayroll } from '../application/project-payroll.js';
import { SeededRng } from '../shared/domain/rng.js';

export const PROJECTS_QUEUE = 'jobs-projects';

/**
 * BullMQ handler, dispatched on the job name.
 * @param job - The scheduled job.
 * @param ctx - The app context.
 * @param log - Logger.
 */
export async function handleProjectsJob(job: Job, ctx: AppContext, log: Logger): Promise<void> {
  try {
    if (job.name === 'payroll') {
      log.info(await runWeeklyPayroll(ctx), 'projects payroll');
    } else if (job.name === 'risk') {
      // Seeded per run from the clock; tests inject their own Rng.
      const fired = await runDailyRisk(ctx, new SeededRng(Date.now() >>> 0));
      log.info({ fired }, 'projects risk');
    } else if (job.name === 'expire-offers') {
      await expireOffers(ctx);
    }
  } catch (e) {
    log.error({ job: job.name, err: (e as Error).message }, 'projects job failed');
  }
}

/**
 * Register the queue, its schedulers and the worker.
 * @param ctx - The app context.
 * @param conn - BullMQ connection options for the queue.
 * @param client - A dedicated connection for the worker.
 * @param log - Logger.
 * @returns A function that closes the worker and the queue.
 */
export async function startProjectsWorker(
  ctx: AppContext,
  conn: ConnectionOptions,
  client: IORedis,
  log: Logger,
): Promise<() => Promise<void>> {
  const queue = new Queue(PROJECTS_QUEUE, { connection: conn });
  const worker = new Worker(PROJECTS_QUEUE, async (job) => handleProjectsJob(job, ctx, log), {
    connection: client,
  });
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err: err.message }, 'projects failed'),
  );
  const opts = { removeOnComplete: 100, removeOnFail: 500 };
  await queue.upsertJobScheduler(
    'projects-payroll',
    { pattern: '0 0 * * 1', tz: 'UTC' },
    { name: 'payroll', data: {}, opts },
  );
  await queue.upsertJobScheduler(
    'projects-risk',
    { pattern: '0 12 * * *', tz: 'UTC' },
    { name: 'risk', data: {}, opts },
  );
  await queue.upsertJobScheduler(
    'projects-expire-offers',
    { pattern: '7 * * * *', tz: 'UTC' },
    { name: 'expire-offers', data: {}, opts },
  );
  return async () => {
    await worker.close();
    await queue.close();
  };
}
