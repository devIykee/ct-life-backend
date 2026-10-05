-- Migration: 020_tombstones
--
-- A "tombstone" is a record of capital lost in a rug (or
-- slow-bleed) event. The market engine writes a row when a coin
-- transitions to stage='dead'. The Rekt Clinic serves the most
-- recent 50 with a join to users for the alias.
--
-- `lost_cents` is the absolute amount the user lost on their
-- position (always positive; the sign is in the reason). One
-- row per (user_id, coin_id) — the engine UPSERTs on a re-rug.
-- `at` is the timestamp of the death event.

-- Up Migration
CREATE TABLE tombstones (
  coin_id      uuid PRIMARY KEY REFERENCES coins(coin_id) ON DELETE RESTRICT,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  alias        text NOT NULL,
  lost_cents   bigint NOT NULL CHECK (lost_cents > 0),
  reason       text NOT NULL CHECK (reason IN ('rug', 'slow_bleed')),
  at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (coin_id, user_id)
);

CREATE INDEX tombstones_at_idx ON tombstones (at DESC);

-- Down Migration
DROP TABLE IF EXISTS tombstones;
