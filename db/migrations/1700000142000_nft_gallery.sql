-- Migration: 142_nft_gallery (unlock D4, capability nftGallery)
--
-- The home gallery wall: NFTs a player really holds, framed in numbered
-- slots, read through Helius DAS (devnet; mainnet read-only and only for
-- allow-listed collections). Nothing here mints or moves an asset.
--
--   home_gallery_frames  per player (survives a move, like home_settings).
--                        One asset per slot, one slot per asset. The asset's
--                        display facts are copied at framing time so a visitor
--                        never costs a DAS call; the daily worker removes a
--                        frame whose asset left the wallet.
--   nft_images           the image proxy: a source URL seen in a DAS result,
--                        keyed by a hash of it, and once fetched the
--                        re-encoded PNG (<= 512 px, <= 512 KiB). Only URLs the
--                        server itself read from DAS are ever fetched.
--                        `pending` images share a byte budget and the least
--                        recently served unframed ones are evicted to make room;
--                        `ok` (allow-listed or framed) images are exempt.

-- Up Migration
CREATE TABLE nft_images (
  hash         text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{40}$'),
  source_url   text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
  mime         text CHECK (mime IS NULL OR mime = 'image/png'),
  width        integer CHECK (width IS NULL OR width BETWEEN 1 AND 4096),
  height       integer CHECK (height IS NULL OR height BETWEEN 1 AND 4096),
  bytes        bytea,
  fail_reason  text,
  -- `ok`: allow-listed or framed by its owner (exempt from the pending budget);
  -- `pending`: any other NFT image (anyone can mint one), budgeted and evictable.
  class        text NOT NULL DEFAULT 'pending' CHECK (class IN ('ok', 'pending')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  fetched_at   timestamptz,
  last_served_at timestamptz,
  CHECK ((status = 'ok') = (bytes IS NOT NULL))
);

CREATE INDEX nft_images_evict_idx ON nft_images (class, status, last_served_at);

-- Running byte totals per class, updated in the same transaction as the bytes
-- they count (no full-table SUM per request).
CREATE TABLE nft_image_usage (
  class  text PRIMARY KEY CHECK (class IN ('ok', 'pending')),
  bytes  bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0)
);
INSERT INTO nft_image_usage (class) VALUES ('ok'), ('pending');

CREATE TABLE home_gallery_frames (
  owner_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot           integer NOT NULL CHECK (slot BETWEEN 1 AND 64),
  asset_id       text NOT NULL,
  network        text NOT NULL CHECK (network IN ('devnet', 'mainnet')),
  name           text NOT NULL,
  collection     text,
  image_hash     text NOT NULL REFERENCES nft_images(hash),
  moderation     text NOT NULL CHECK (moderation IN ('ok', 'pending', 'nsfw', 'blocked')),
  framed_at      timestamptz NOT NULL DEFAULT now(),
  checked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, slot),
  UNIQUE (owner_user_id, asset_id)
);

CREATE INDEX home_gallery_frames_checked_idx ON home_gallery_frames (checked_at);

-- Down Migration
DROP TABLE IF EXISTS home_gallery_frames;
DROP TABLE IF EXISTS nft_image_usage;
DROP TABLE IF EXISTS nft_images;
