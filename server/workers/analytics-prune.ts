/**
 * Analytics retention: once a day, delete product events older than
 * ANALYTICS_RETENTION_DAYS (default 180). See docs/ANALYTICS.md.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { pruneAnalyticsEvents } from '../application/analytics.js';

export const ANALYTICS_PRUNE_QUEUE = 'jobs-analytics-prune';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 */
export async function handleAnalyticsPrune(_job: Job, ctx: AppContext): Promise<void> {
  try {
    const n = await pruneAnalyticsEvents(ctx.db, ctx.config.analytics.retentionDays);
    if (n > 0) console.info(`[analytics-prune] deleted ${n} events`);
  } catch (e) {
    console.error('[analytics-prune] failed:', (e as Error).message);
  }
}
