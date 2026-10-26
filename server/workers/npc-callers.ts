/**
 * NPC callers: every 5 minutes, let each Timeline caller whose turn has come
 * post a call on a live house coin (see application/npc-callers.ts).
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { runNpcCallers } from '../application/npc-callers.js';

export const NPC_CALLERS_QUEUE = 'jobs-npc-callers';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 */
export async function handleNpcCallers(_job: Job, ctx: AppContext): Promise<void> {
  try {
    await runNpcCallers(ctx);
  } catch (e) {
    console.error('[npc-callers] failed:', (e as Error).message);
  }
}
