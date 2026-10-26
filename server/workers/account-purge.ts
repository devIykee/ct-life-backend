/**
 * Account purge: every few minutes erase the files queued by DELETE /v1/me
 * (likeness photos and models in the private store, ad creatives and creator
 * images in the ads bucket). Rows stay queued and retry until the store
 * confirms, so a storage outage delays but never skips an erasure.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { purgeStorage, type KeyDeleter } from '../application/account-deletion.js';

export const ACCOUNT_PURGE_QUEUE = 'jobs-account-purge';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 * @param likenessDelete - Deleter for the private likeness store, when configured.
 */
export async function handleAccountPurge(
  _job: Job,
  ctx: AppContext,
  likenessDelete?: KeyDeleter,
): Promise<void> {
  try {
    await purgeStorage(ctx, {
      ads: (key) => ctx.s3.remove(key),
      ...(likenessDelete ? { likeness: likenessDelete } : {}),
    });
  } catch (e) {
    console.error('[account-purge] failed:', (e as Error).message);
  }
}
