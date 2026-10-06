-- Migration: 053_nft_collections
--
-- The M6 NFT collection. A collection is a curated set of
-- mint-able items; the M5 #66 single-mint flow extends with
-- per-item max_supply and a per-item counter so the same
-- item can be minted multiple times. The owner of the
-- collection curates the items; the M6 mint flow (#77)
-- is the dev path that mints a Metaplex Core asset per
-- (user, item, counter) tuple.
--
-- `owner_user_id` is the collection's curator.
-- `name` is the collection's display name.
-- `description` is the collection description.

-- Up Migration
CREATE TABLE nft_collections (
  collection_id   uuid PRIMARY KEY,
  owner_user_id   uuid NOT NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description     text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nft_collections_owner_idx
  ON nft_collections (owner_user_id);

-- Down Migration
DROP TABLE IF EXISTS nft_collections;
