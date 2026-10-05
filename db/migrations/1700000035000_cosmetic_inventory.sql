-- Migration: 035_cosmetic_inventory
--
-- The user's owned cosmetics. UNIQUE (user_id, item_id) is the
-- "you already own it" check; the cosmetics purchase service
-- translates a duplicate insert into a 200 idempotent replay.
--
-- `source` records how the player got the item:
--   'shop'   - bought with Cash
--   'mint'   - minted as an on-chain NFT (M5 #66)
--   'grant'  - admin / season pass perk / Sunday Unlock
--
-- The application enforces a daily cap (e.g. 5 items per user
-- per UTC day) by querying a SUM by source='shop' grouped by
-- user_id and truncating `acquired_at` to date.
--
-- Indexes:
--   (user_id, item_id) UNIQUE — primary access pattern
--   (user_id, acquired_at DESC) — recent acquisitions list

-- Up Migration
CREATE TABLE cosmetic_inventory (
  inventory_id   uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  item_id        uuid NOT NULL REFERENCES cosmetic_items(item_id),
  source         text NOT NULL
                  CHECK (source IN ('shop', 'mint', 'grant')),
  acquired_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, item_id)
);

CREATE INDEX cosmetic_inventory_user_acquired_idx
  ON cosmetic_inventory (user_id, acquired_at DESC);

-- Down Migration
DROP TABLE IF EXISTS cosmetic_inventory;
