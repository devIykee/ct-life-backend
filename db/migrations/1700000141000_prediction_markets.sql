-- Migration: 141_prediction_markets (unlock D3, capability predict)
--
-- Server-generated Prediction Pit markets. A bet now names a market and one
-- of its outcomes; the old free-text outcome ids (and the coin-flip resolver
-- they relied on) are gone.
--
--   prediction_markets  one row per market. `strike_micros` and `basis` are
--                       recorded when the market opens; `resolved_value_micros`
--                       and `resolved_outcome_id` are recorded once, when it
--                       resolves, and settlement only ever reads them.
--                       Status: open (taking bets until closes_at) -> resolved
--                       or void (source unavailable: every stake refunded).
--   prediction_price_snapshots
--                       the in-game coin price once a minute, written by the
--                       market worker; the `sim` resolver reads the snapshot of
--                       the market's resolves_at minute.
--   predictions         gains market_id (null on legacy rows), payout_cents
--                       (what was credited: 0 on a loss, the stake on a void)
--                       and resolved_at.

-- Up Migration
CREATE TABLE prediction_markets (
  market_id              text PRIMARY KEY,
  kind                   text NOT NULL CHECK (kind IN ('sim', 'crypto', 'event', 'mirror')),
  question_key           text NOT NULL,
  params                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcomes               jsonb NOT NULL,
  horizon                text NOT NULL CHECK (horizon IN ('5m', '15m', '1h', 'daily')),
  opens_at               timestamptz NOT NULL,
  closes_at              timestamptz NOT NULL,
  resolves_at            timestamptz NOT NULL,
  source                 jsonb NOT NULL,
  payout_bps             integer NOT NULL CHECK (payout_bps > 10000 AND payout_bps <= 100000),
  min_stake_cents        bigint NOT NULL CHECK (min_stake_cents > 0),
  max_stake_cents        bigint NOT NULL,
  status                 text NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'closed', 'resolved', 'void')),
  strike_micros          bigint,
  basis                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_value_micros  bigint,
  resolved_outcome_id    text,
  resolved_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at AND resolves_at >= closes_at),
  CHECK (max_stake_cents >= min_stake_cents),
  CHECK ((status = 'resolved') = (resolved_outcome_id IS NOT NULL))
);

CREATE INDEX prediction_markets_open_idx ON prediction_markets (status, closes_at);
CREATE INDEX prediction_markets_due_idx ON prediction_markets (status, resolves_at);

CREATE TABLE prediction_price_snapshots (
  coin_id       uuid NOT NULL,
  minute        timestamptz NOT NULL,
  price_micros  bigint NOT NULL CHECK (price_micros >= 0),
  PRIMARY KEY (coin_id, minute)
);

ALTER TABLE predictions
  ADD COLUMN market_id     text REFERENCES prediction_markets(market_id),
  ADD COLUMN payout_cents  bigint CHECK (payout_cents IS NULL OR payout_cents >= 0),
  ADD COLUMN resolved_at   timestamptz;

CREATE INDEX predictions_market_status_idx ON predictions (market_id, status);
CREATE INDEX predictions_user_created_idx ON predictions (user_id, created_at);

-- Down Migration
DROP INDEX IF EXISTS predictions_user_created_idx;
DROP INDEX IF EXISTS predictions_market_status_idx;
ALTER TABLE predictions
  DROP COLUMN IF EXISTS resolved_at,
  DROP COLUMN IF EXISTS payout_cents,
  DROP COLUMN IF EXISTS market_id;
DROP TABLE IF EXISTS prediction_price_snapshots;
DROP TABLE IF EXISTS prediction_markets;
