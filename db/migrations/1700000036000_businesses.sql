-- Migration: 036_businesses
--
-- One row per player-founded business. Five kinds:
--   lemonade_stand, laundromat, cafe, shop, arcade
-- Each kind has a fixed rent + income range in
-- contract/config/businesses.json.
--
-- `rent_cents_per_week` is the weekly rent; the businesses
-- worker debits this every Monday 00:00 UTC (same cadence as
-- the M4 home rent worker). The CHECK > 0 is the floor; the
-- application caps it to the kind's configured max.
--
-- `income_min_cents` and `income_max_cents` are the bounds
-- for a normal-day payout. A bad day pays 0, a great day pays
-- income_max; the per-kind table in businesses.json picks the
-- probability.
--
-- `closed_at` is set when the player closes the business via
-- POST /v1/businesses/{id}/close (M5 out of scope at #62 but
-- the column is reserved).
--
-- Index:
--   (owner_user_id) — the player's business list

-- Up Migration
CREATE TABLE businesses (
  business_id            uuid PRIMARY KEY,
  owner_user_id          uuid NOT NULL,
  kind                   text NOT NULL
                          CHECK (kind IN ('lemonade_stand', 'laundromat', 'cafe', 'shop', 'arcade')),
  rent_cents_per_week    bigint NOT NULL CHECK (rent_cents_per_week > 0),
  income_min_cents       bigint NOT NULL CHECK (income_min_cents >= 0),
  income_max_cents       bigint NOT NULL CHECK (income_max_cents >= income_min_cents),
  created_at             timestamptz NOT NULL DEFAULT now(),
  closed_at              timestamptz
);

CREATE INDEX businesses_owner_idx
  ON businesses (owner_user_id);

-- Down Migration
DROP TABLE IF EXISTS businesses;
