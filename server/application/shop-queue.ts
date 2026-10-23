/**
 * Duo Shop delivery queue: the API's side of the BullMQ queue the workers
 * process (`server/workers/shop-delivery.ts`).
 *
 * Placing an order schedules two delayed jobs, `out` (courier leaves, 60 s
 * before the ETA) and `deliver` (the ETA). Redis is only the clock: the
 * order row is the truth, every job re-checks it under a row lock, and a
 * minute-by-minute sweep in the worker picks up any order whose job was
 * lost. So scheduling is best effort and never fails a request.
 */
import { Queue } from 'bullmq';
import { loadConfig } from '../shared/config/config.js';

export const SHOP_DELIVERY_QUEUE = 'jobs-shop-delivery';

export type ShopJobName = 'out' | 'deliver' | 'sweep';

export interface ShopJobData {
  readonly orderId?: string;
}

let queue: Queue<ShopJobData> | null = null;

function getQueue(): Queue<ShopJobData> {
  if (queue) return queue;
  const url = new URL(loadConfig().redisUrl);
  queue = new Queue<ShopJobData>(SHOP_DELIVERY_QUEUE, {
    connection: {
      host: url.hostname,
      port: Number(url.port || 6379),
      password: url.password || undefined,
      db: Number(url.pathname.slice(1) || 0),
      maxRetriesPerRequest: null,
    },
  });
  // A Redis outage must not crash the API through an unhandled error event.
  queue.on('error', () => undefined);
  return queue;
}

/** BullMQ job ids may not contain ':'. */
function jobId(step: 'out' | 'deliver', orderId: string): string {
  return `shop-${step}-${orderId}`;
}

/**
 * Schedule the two delayed jobs of an order. Best effort: the sweep
 * delivers an order whose jobs never made it.
 * @param order - The order id and its two times.
 * @param now - The current time (injectable for tests).
 */
export async function scheduleShopDelivery(
  order: { orderId: string; outAt: Date; etaAt: Date },
  now: Date = new Date(),
): Promise<void> {
  try {
    const q = getQueue();
    const opts = { removeOnComplete: true, removeOnFail: true } as const;
    await q.add(
      'out',
      { orderId: order.orderId },
      {
        ...opts,
        jobId: jobId('out', order.orderId),
        delay: Math.max(0, order.outAt.getTime() - now.getTime()),
      },
    );
    await q.add(
      'deliver',
      { orderId: order.orderId },
      {
        ...opts,
        jobId: jobId('deliver', order.orderId),
        delay: Math.max(0, order.etaAt.getTime() - now.getTime()),
      },
    );
  } catch {
    // The worker's sweep covers a job that could not be queued.
  }
}

/**
 * Drop the pending jobs of a cancelled order. Best effort: a job that
 * still fires finds the order cancelled and does nothing.
 * @param orderId - The order.
 */
export async function unscheduleShopDelivery(orderId: string): Promise<void> {
  try {
    const q = getQueue();
    await Promise.all([q.remove(jobId('out', orderId)), q.remove(jobId('deliver', orderId))]);
  } catch {
    // See above.
  }
}

/**
 * Close the API-side queue connection (shutdown, tests).
 */
export async function closeShopQueue(): Promise<void> {
  const q = queue;
  queue = null;
  await q?.close().catch(() => undefined);
}
