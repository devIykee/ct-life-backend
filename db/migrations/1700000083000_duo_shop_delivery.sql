-- Migration: 083_duo_shop_delivery
--
-- The Duo Shop: Cash goods and furniture ordered on the in-game phone and
-- delivered to the doorstep (or a lobby locker) at a scheduled time.
-- Builds on 082 (home_units, homes.unit_id).
--
-- shop_items       — the catalogue. The frontend owns the ids
--                    (contract/ids/shop_items.json); the API upserts them.
--                    Items dropped from the file are kept (orders point at
--                    them) and marked inactive.
-- shop_orders      — one order. status: placed -> out_for_delivery ->
--                    delivered, or placed -> cancelled. `out_at` is when the
--                    courier leaves (60 s before `eta_at`). `unit_id` is the
--                    door the order was placed for (null for a locker).
-- shop_order_items — the lines, with the unit price at order time.
-- player_items     — off-chain owned items, one row per physical unit.
--                    Not NFTs, never tradable. Created on delivery.
-- home_placements  — where an owned item stands in a home. One row per item
--                    (the primary key is the item), so an item is never
--                    placed twice.
--
-- Indexes:
--   shop_orders (user_id, placed_at DESC)        — "my orders"
--   shop_orders (status, eta_at) WHERE open      — the delivery sweep
--   player_items (user_id, acquired_at DESC)     — "my items"
--   home_placements (home_id)                    — read a home's placements

-- Up Migration
CREATE TABLE shop_items (
  item_id      text PRIMARY KEY,
  category     text NOT NULL CHECK (category IN ('furniture', 'decor', 'appliance', 'food', 'clothing')),
  name         text NOT NULL,
  price_cents  bigint NOT NULL CHECK (price_cents > 0),
  deliverable  boolean NOT NULL DEFAULT true,
  placeable    boolean NOT NULL DEFAULT false,
  footprint_w  numeric(6, 2),
  footprint_d  numeric(6, 2),
  footprint_h  numeric(6, 2),
  model_key    text NOT NULL,
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT placeable OR (footprint_w > 0 AND footprint_d > 0 AND footprint_h > 0))
);

CREATE INDEX shop_items_category_idx
  ON shop_items (category);

CREATE TABLE shop_orders (
  order_id      uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status        text NOT NULL DEFAULT 'placed'
                  CHECK (status IN ('placed', 'out_for_delivery', 'delivered', 'cancelled')),
  delivery_window text NOT NULL CHECK (delivery_window IN ('asap', '30m', '1h')),
  destination   text NOT NULL CHECK (destination IN ('door', 'locker')),
  unit_id       text REFERENCES home_units(unit_id),
  items_cents   bigint NOT NULL CHECK (items_cents > 0),
  fee_cents     bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  total_cents   bigint NOT NULL CHECK (total_cents > 0),
  placed_at     timestamptz NOT NULL DEFAULT now(),
  out_at        timestamptz NOT NULL,
  eta_at        timestamptz NOT NULL,
  delivered_at  timestamptz,
  cancelled_at  timestamptz,
  CHECK (destination = 'locker' OR unit_id IS NOT NULL)
);

CREATE INDEX shop_orders_user_idx
  ON shop_orders (user_id, placed_at DESC);

CREATE INDEX shop_orders_open_idx
  ON shop_orders (status, eta_at)
  WHERE status IN ('placed', 'out_for_delivery');

CREATE TABLE shop_order_items (
  order_id          uuid NOT NULL REFERENCES shop_orders(order_id) ON DELETE CASCADE,
  item_id           text NOT NULL REFERENCES shop_items(item_id),
  qty               integer NOT NULL CHECK (qty > 0),
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, item_id)
);

CREATE TABLE player_items (
  instance_id  uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id      text NOT NULL REFERENCES shop_items(item_id),
  order_id     uuid REFERENCES shop_orders(order_id),
  acquired_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_items_user_idx
  ON player_items (user_id, acquired_at DESC);

CREATE TABLE home_placements (
  instance_id  uuid PRIMARY KEY REFERENCES player_items(instance_id) ON DELETE CASCADE,
  home_id      text NOT NULL REFERENCES homes(home_id) ON DELETE CASCADE,
  x            double precision NOT NULL,
  z            double precision NOT NULL,
  rot_y        double precision NOT NULL,
  placed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX home_placements_home_idx
  ON home_placements (home_id);

-- Down Migration
DROP TABLE IF EXISTS home_placements;
DROP TABLE IF EXISTS player_items;
DROP TABLE IF EXISTS shop_order_items;
DROP TABLE IF EXISTS shop_orders;
DROP TABLE IF EXISTS shop_items;
