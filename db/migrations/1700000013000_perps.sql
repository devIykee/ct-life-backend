-- Migration: 013_perps
--
-- Leveraged positions (long or short) on a coin. The Perp Pit service
-- is the only writer of `entry_micros`, `liq_micros`, `status`, and
-- `realized_cents`.
--
-- `leverage` is bounded [1, 25] by the spec. `margin_cents` is the
-- collateral posted at open time. `units` (implied) = margin * leverage.
--
-- Liquidation price math:
--   long  → entry * (1 - 1/leverage)
--   short → entry * (1 + 1/leverage)
--
-- The liquidation worker reads the engine's price_micros and closes
-- the perp with status='liquidated' if the price crosses liq_micros.

-- Up Migration
CREATE TABLE perps (
  perp_id          uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  coin_id          uuid NOT NULL REFERENCES coins(coin_id) ON DELETE RESTRICT,
  side             text NOT NULL CHECK (side IN ('long', 'short')),
  leverage         smallint NOT NULL CHECK (leverage BETWEEN 1 AND 25),
  margin_cents     bigint NOT NULL CHECK (margin_cents > 0),
  entry_micros     bigint NOT NULL,
  liq_micros       bigint NOT NULL,
  status           text NOT NULL CHECK (status IN ('open', 'closed', 'liquidated')),
  realized_cents   bigint,
  closed_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX perps_user_status_idx ON perps (user_id, status);
CREATE INDEX perps_status_coin_idx ON perps (status, coin_id);

-- Down Migration
DROP TABLE IF EXISTS perps;
