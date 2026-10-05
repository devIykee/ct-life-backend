-- Migration: 015_predictions
--
-- Binary bets on outcomes (e.g. "BTC 24h > 0?"). The stake is in
-- cash cents. On `closes_at` the worker resolves:
--   - correct       → 2x stake credited via ledger (status='won')
--   - incorrect     → stake forfeit; the 'house' is the burning of
--                     the loser's stake (status='lost')
--   - cancelled     → stake refunded (status='cancelled')
--
-- `horizon` is the resolution window: 5m, 15m, 1h, daily. The
-- prediction market outcomes are seeded into a Redis sorted set
-- per horizon (predictions:active:<horizon>) from
-- contract/config/predictions.json.
--
-- `closes_at > created_at` is enforced as a CHECK. Negative-time
-- bets are nonsense and the spec rejects them.

-- Up Migration
CREATE TABLE predictions (
  prediction_id   uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  outcome_id      text NOT NULL,
  stake_cents     bigint NOT NULL CHECK (stake_cents > 0),
  status          text NOT NULL CHECK (status IN ('open', 'won', 'lost', 'cancelled')),
  horizon         text NOT NULL CHECK (horizon IN ('5m', '15m', '1h', 'daily')),
  closes_at       timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > created_at)
);

CREATE INDEX predictions_status_closes_idx ON predictions (status, closes_at);
CREATE INDEX predictions_user_status_idx ON predictions (user_id, status);

-- Down Migration
DROP TABLE IF EXISTS predictions;
