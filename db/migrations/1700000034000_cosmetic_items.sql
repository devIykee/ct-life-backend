-- Migration: 034_cosmetic_items
--
-- The shop catalog. One row per item the player can buy or
-- earn. The catalog is small (50-200 rows total) and is read
-- frequently; we keep it in Postgres rather than a JSON file
-- so the application can be redeployed without a config push.
--
-- `slot` is one of the seven equip slots from items.json. The
-- CHECK keeps it aligned with the FE side.
--
-- `item_key` is the BE-owned canonical key (e.g. 'top_hoodie_black').
-- It is UNIQUE so the FE cannot request two items with the same
-- key.
--
-- `price_cents` is the Cash price (e.g. 1000 = $10). Cash
-- purchases debit this from the buyer's balance.
--
-- `onchain_only` means the item can only be acquired via the
-- NFT mint flow (server/application/nft-mint.ts). The
-- cosmetics shop will refuse the purchase with a 400.
--
-- `created_at` is informational; cosmetic items are
-- versioned by inserting a new row, not by mutating the
-- existing one (the FE knows the latest by max(created_at)).

-- Up Migration
CREATE TABLE cosmetic_items (
  item_id        uuid PRIMARY KEY,
  slot           text NOT NULL
                  CHECK (slot IN ('skin', 'head', 'hair', 'top', 'bottom', 'shoes', 'acc')),
  item_key       text NOT NULL UNIQUE,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  price_cents    bigint NOT NULL CHECK (price_cents >= 0),
  onchain_only   boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS cosmetic_items;
