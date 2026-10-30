/**
 * Home NFT gallery tuning, loaded once from contract/config/nft_gallery.json
 * (schema: nft_gallery.schema.json, explained in docs/NFT_GALLERY.md).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const Collection = z.object({ address: z.string().min(32).max(44), name: z.string().min(1) });

const NftGalleryFile = z.object({
  maxSlots: z.number().int().min(1).max(64),
  holdingsCacheSec: z.number().int().min(60),
  dasRequestsPerSecond: z.number().int().min(1).max(50),
  maxImageBytes: z.number().int().min(16_384),
  maxImagePx: z.number().int().min(64).max(2048),
  maxSourceBytes: z.number().int().min(65_536),
  maxPendingImageBytes: z.number().int().min(1_048_576),
  maxOkImageBytes: z.number().int().min(1_048_576),
  maxNewImagesPerWalletPerDay: z.number().int().min(1).max(10_000),
  devnetCollections: z.array(Collection),
  mainnetCollections: z.array(Collection),
});

export type NftGalleryConfig = z.infer<typeof NftGalleryFile>;

let cached: NftGalleryConfig | null = null;

/**
 * The parsed nft_gallery.json (read once per process).
 * @returns The config.
 */
export function nftGalleryConfig(): NftGalleryConfig {
  cached ??= NftGalleryFile.parse(
    JSON.parse(readFileSync(join(process.cwd(), 'contract/config/nft_gallery.json'), 'utf8')),
  );
  return cached;
}
