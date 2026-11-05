/** Persistent scheduler; all remote calls use the SDK's actual five-second abort timeout. */
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type IORedis from 'ioredis';
import type { AppContext } from '../application/context.js';
import { sweepMediaGrants } from '../application/media-access.js';
import { createLogger } from '../shared/logger/logger.js';

/** Register the durable media reconciliation scheduler and close all owned resources on shutdown. */
export async function startMediaAccessSweep(args: {
  connection: ConnectionOptions;
  workerConnection: IORedis;
  ctx: AppContext;
}): Promise<{ close(): Promise<void> }> {
  const queue = new Queue('jobs-media-access', { connection: args.connection });
  const log = createLogger().child({ mod: 'media-access' });
  let roomCursor = 0;
  let participantOffsets: Record<string, number> = {};
  const worker = new Worker(
    'jobs-media-access',
    async () => {
      const result = await sweepMediaGrants(args.ctx, roomCursor, participantOffsets);
      roomCursor = result.nextRoomCursor;
      participantOffsets = result.participantOffsets;
      if (result.failures)
        log.error(
          { failures: result.failures },
          'Media access reconciliation incomplete; durable grants retained for retry',
        );
    },
    { connection: args.workerConnection, concurrency: 1 },
  );
  worker.on('failed', () =>
    log.error('Media access reconciliation failed; durable grants retained for retry'),
  );
  await queue.upsertJobScheduler(
    'media-access-sweep',
    { every: 15_000 },
    {
      name: 'sweep',
      data: {},
      opts: { removeOnComplete: 100, removeOnFail: 100 },
    },
  );
  return {
    async close() {
      await worker.close();
      await queue.close();
    },
  };
}
