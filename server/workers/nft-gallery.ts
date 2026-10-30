/**
 * NFT gallery ownership re-check (BullMQ, daily 04:30 UTC; scheduled in
 * main.ts). Removes frames whose asset left the owner's wallet or was burnt
 * (server/application/nft-gallery.ts `recheckFrames`). Does nothing while
 * the `nftGallery` capability is off in the workers process.
 */
import type { Job } from 'bullmq';
import type { AppContext } from '../application/context.js';
import { isCapabilityOn } from '../application/capabilities.js';
import { recheckFrames } from '../application/nft-gallery.js';

export const NFT_GALLERY_QUEUE = 'jobs-nft-gallery';

/**
 * BullMQ handler.
 * @param _job - The repeatable job (carries no data).
 * @param ctx - The app context.
 * @returns How many frames were removed.
 */
export async function handleNftGalleryRecheck(_job: Job, ctx: AppContext): Promise<number> {
  if (!isCapabilityOn(ctx, 'nftGallery')) return 0;
  const n = await recheckFrames(ctx);
  if (n > 0) console.info(`[nft-gallery] removed ${n} frames`);
  return n;
}
