/**
 * Sunday Unlock and Weekly Meta placeholders.
 *
 * M5 wires the real handlers. M2 ships the repeatable jobs so the
 * cron expressions and queue names are locked in.
 */
import type { Job } from 'bullmq';
import { createLogger } from '../shared/logger/logger.js';
import type { RedisLayer } from '../shared/redis/client.js';

/**
 *
 */
export async function handleSundayUnlock(job: Job, _redis: RedisLayer): Promise<void> {
  const log = createLogger().child({ worker: 'sunday-unlock' });
  log.info({ jobId: job.id }, 'sunday unlock placeholder');
}

/**
 *
 */
export async function handleWeeklyMeta(job: Job, _redis: RedisLayer): Promise<void> {
  const log = createLogger().child({ worker: 'weekly-meta' });
  log.info({ jobId: job.id }, 'weekly meta placeholder');
}
