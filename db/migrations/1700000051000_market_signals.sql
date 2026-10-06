-- Migration: 051_market_signals
--
-- The M6 alpha-calls v2. Extends the M3 alpha_calls surface
-- with multi-horizon signals. A signal is a published
-- prediction about a coin's price over a fixed horizon
-- (5m / 15m / 1h / 1d) with a direction and a confidence in
-- basis points. The M6 signal is the new alpha_calls v2 row;
-- the existing M3 alpha_calls table is kept for the
-- traditional target/stop calls.
--
-- `coin` is the coin symbol (matches coins.coin_id symbol).
-- `horizon_minutes` is one of 5, 15, 60, 1440. The CHECK
-- keeps the enum honest at the schema level.
--
-- `direction` is 'up' or 'down'. The CHECK keeps the enum
-- honest.
--
-- `confidence_bps` is the caller's confidence in basis points
-- (0..10000). 10000 = 100%. The CHECK range guards the
-- input.
--
-- `entry_price_micros` is the coin's price at publish.
--
-- `expires_at` is `created_at + horizon_minutes`. The
-- resolution worker flips status to 'expired' if no tick
-- has resolved it.
--
-- `status` is 'open', 'hit', 'missed', or 'expired'. The
-- CHECK keeps the enum honest.
--
-- Index:
--   (coin, status, expires_at) - the resolution worker's
--   hot-path: "active signals for this coin that are due".
--
-- The M3 trust score (server/application/alpha.ts) weights
-- the new v2 signals the same way it weights the v1 calls;
-- the v2 row is additive.

-- Up Migration
CREATE TABLE market_signals (
  signal_id          uuid PRIMARY KEY,
  user_id            uuid NOT NULL,
  coin               text NOT NULL,
  horizon_minutes    int NOT NULL
                      CHECK (horizon_minutes IN (5, 15, 60, 1440)),
  direction          text NOT NULL
                      CHECK (direction IN ('up', 'down')),
  confidence_bps     int NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  entry_price_micros bigint NOT NULL CHECK (entry_price_micros > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  status             text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open', 'hit', 'missed', 'expired'))
);

CREATE INDEX market_signals_active_idx
  ON market_signals (coin, status, expires_at);

CREATE INDEX market_signals_user_idx
  ON market_signals (user_id);

-- Down Migration
DROP TABLE IF EXISTS market_signals;
