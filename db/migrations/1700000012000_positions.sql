-- Migration: 012_positions
--
-- Per-user per-coin holdings. A position is created on a buy, mutated
-- on every buy or sell, and never deleted. `units` is the running
-- sum of base units held; CHECK >= 0 enforces the "no negative
-- inventory" floor at the database.
--
-- `cost_basis_cents` is the running weighted average cost. The trade
-- service updates it on every buy. `realized_cents` is the
-- cumulative PnL closed (added on every sell).
--
-- UNIQUE (user_id, coin_id) enforces one row per (user, coin). The
-- market trade service is the only writer.

-- Up Migration
CREATE TABLE positions (
  position_id      uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  coin_id          uuid NOT NULL REFERENCES coins(coin_id) ON DELETE RESTRICT,
  units            bigint NOT NULL CHECK (units >= 0),
  cost_basis_cents bigint NOT NULL,
  realized_cents   bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, coin_id)
);

-- Down Migration
DROP TABLE IF EXISTS positions;
