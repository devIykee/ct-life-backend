/**
 * Daily board refresh worker.
 *
 * Hourly cron. M2 stub: increments a Redis counter. M3 reads the
 * ledger and rebuilds the weekly_pnl and net_worth ZSETs.
 */
import type { Job } from 'bullmq';
import { createLogger } from '../shared/logger/logger.js';
import type { RedisLayer } from '../shared/redis/client.js';

/**
 *
 */
export async function handleDailyBoardRefresh(job: Job, redis: RedisLayer): Promise<void> {
  const log = createLogger().child({ worker: 'daily-board' });
  await redis.main.incr('board:refresh:counter');
  log.info({ jobId: job.id }, 'daily board refresh');
}
