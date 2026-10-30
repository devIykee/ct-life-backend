/**
 * Paid-call sweep (unlock C2): every 15 s, refund unanswered and declined calls once the
 * escrow allows it, end live calls at their booked minutes, retry failed settles, and
 * expire unpaid bookings (server/application/paid-calls.ts `sweepPaidCalls`). A no-op
 * while the `paidCalls` capability is off. One BullMQ job scheduler, so only one worker
 * runs a pass at a time and no chain transaction is sent twice.
 */
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type IORedis from 'ioredis';
import type { AppContext } from '../application/context.js';
import { isCapabilityOn } from '../application/capabilities.js';
import { sweepPaidCalls } from '../application/paid-calls.js';

export const PAID_CALLS_QUEUE = 'jobs-paid-calls';
const EVERY_MS = 15_000;

/**
 * One sweep pass.
 * @param ctx - The app context.
 */
export async function handlePaidCallSweep(ctx: AppContext): Promise<void> {
  if (!isCapabilityOn(ctx, 'paidCalls')) return;
  try {
    const c = await sweepPaidCalls(ctx);
    if (c.expired + c.notAnswered + c.refunded + c.autoEnded + c.settled > 0) {
      console.info('[paid-calls] sweep', c);
    }
  } catch (e) {
    console.error('[paid-calls] sweep failed:', (e as Error).message);
  }
}

/**
 * Register the queue, the worker and the 15-second scheduler.
 * @returns A close function for shutdown.
 */
export async function startPaidCallSweep(args: {
  connection: ConnectionOptions;
  workerConnection: IORedis;
  ctx: AppContext;
}): Promise<{ close(): Promise<void> }> {
  const queue = new Queue(PAID_CALLS_QUEUE, { connection: args.connection });
  const worker = new Worker(PAID_CALLS_QUEUE, async () => handlePaidCallSweep(args.ctx), {
    connection: args.workerConnection,
    concurrency: 1,
  });
  await queue.upsertJobScheduler(
    'paid-calls-sweep',
    { every: EVERY_MS },
    { name: 'sweep', data: {} },
  );
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
