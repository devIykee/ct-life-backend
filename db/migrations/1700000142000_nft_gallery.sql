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
--                        Framed images count per owner (slots x 512 KiB);
--                        unframed ones sit in two LRU pools (ok, pending).

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
  -- Moderation class: `ok` = allow-listed collection, `pending` = anything else.
  class        text NOT NULL DEFAULT 'pending' CHECK (class IN ('ok', 'pending')),
  -- Which usage counter holds the bytes: `framed` (referenced by a frame;
  -- bounded per owner), else the class's LRU pool (`ok` or `pending`).
  pool         text NOT NULL DEFAULT 'pending' CHECK (pool IN ('framed', 'ok', 'pending')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  fetched_at   timestamptz,
  last_served_at timestamptz,
  CHECK ((status = 'ok') = (bytes IS NOT NULL))
);

CREATE INDEX nft_images_evict_idx ON nft_images (pool, status, last_served_at);

-- Running byte totals per pool, updated in the same transaction as the bytes
-- they count (no full-table SUM per request). Always locked in pool order.
CREATE TABLE nft_image_usage (
  pool   text PRIMARY KEY CHECK (pool IN ('framed', 'ok', 'pending')),
  bytes  bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0)
);
INSERT INTO nft_image_usage (pool) VALUES ('framed'), ('ok'), ('pending');

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
