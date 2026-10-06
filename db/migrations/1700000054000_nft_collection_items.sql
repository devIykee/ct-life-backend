-- Migration: 054_nft_collection_items
--
-- The M6 NFT collection item. One row per (collection,
-- item_key). `item_key` is the stable identifier inside the
-- collection (e.g. 'mystic_axe'). `max_supply` is the cap
-- on how many times this item can be minted across the
-- collection's lifetime. `minted` is the running counter
-- (CHECK <= max_supply). The M6 mint flow (server/application/
-- nft-collections.ts) increments `minted` inside a
-- SERIALIZABLE UoW; the UNIQUE on (collection_id, item_key)
-- keeps item_keys unique within a collection.
--
-- The deterministic mint_address used by the M5 #66 NFT
-- service extends with a per-item counter: mint_address is
-- sha256(userId + itemKey + counter). Each successful mint
-- inserts an nft_mints row with a UNIQUE (mint_address,
-- signature) replay floor; the M3 #38 Helius webhook
-- confirms the on-chain credit.

-- Up Migration
CREATE TABLE nft_collection_items (
  item_id      uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  item_key     text NOT NULL CHECK (length(item_key) BETWEEN 1 AND 64),
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  max_supply   int NOT NULL CHECK (max_supply > 0),
  minted       int NOT NULL DEFAULT 0 CHECK (minted >= 0 AND minted <= max_supply),

  FOREIGN KEY (collection_id) REFERENCES nft_collections(collection_id) ON DELETE CASCADE,
  UNIQUE (collection_id, item_key)
);

CREATE INDEX nft_collection_items_collection_idx
  ON nft_collection_items (collection_id);

-- Down Migration
DROP TABLE IF EXISTS nft_collection_items;
