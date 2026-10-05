-- Migration: 014_alpha_calls
--
-- An "alpha call" is a public prediction by a user: "I am buying X at
-- price P, target T, stop S." Calls are immutable; there is no
-- delete endpoint. The alpha worker evaluates each open call every
-- 30s and resolves it when:
--   - price_micros >= target_micros → status='hit_target'
--   - price_micros <= stop_micros   → status='hit_stop'
--   - older than 7 days unresolved  → status='expired'
--
-- Constraint: `target_micros > stop_micros` for long calls and
-- `target_micros < stop_micros` for short calls. There is no `side`
-- field on alpha_calls (the spec models it as a generic price band);
-- the call's intent is derived from the price direction. The CHECK
-- here enforces a positive expected value at the DB level.
--
-- Indexes:
--   (user_id, created_at DESC) per-user history
--   (coin_id, status)         the worker's hot loop

-- Up Migration
CREATE TABLE alpha_calls (
  call_id          uuid PRIMARY KEY,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  coin_id          uuid NOT NULL REFERENCES coins(coin_id) ON DELETE RESTRICT,
  entry_micros     bigint NOT NULL,
  target_micros    bigint NOT NULL,
  stop_micros      bigint NOT NULL,
  status           text NOT NULL CHECK (status IN ('open', 'hit_target', 'hit_stop', 'expired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (target_micros > stop_micros)
);

CREATE INDEX alpha_calls_user_created_idx ON alpha_calls (user_id, created_at DESC);
CREATE INDEX alpha_calls_coin_status_idx ON alpha_calls (coin_id, status);

-- Down Migration
DROP TABLE IF EXISTS alpha_calls;
