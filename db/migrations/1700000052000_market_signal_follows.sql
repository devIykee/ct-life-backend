-- Migration: 052_market_signal_follows
--
-- The M6 signal follow. One row per (signal, user) pair.
-- 'copy' means the engine mirrors the caller's buy/sell into
-- the follower's account when the signal resolves 'hit';
-- 'watch' just records the follow and tracks the signal's
-- outcome against the follower's watchlist.
--
-- `follow_kind` is 'copy' or 'watch'. The CHECK keeps the
-- enum honest at the schema level.
--
-- UNIQUE (signal_id, user_id) is the floor for idempotent
-- follow. A second follow of the same signal by the same user
-- translates to a unique_violation, which the application
-- maps to 409.

-- Up Migration
CREATE TABLE market_signal_follows (
  follow_id    uuid PRIMARY KEY,
  signal_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  follow_kind  text NOT NULL
                CHECK (follow_kind IN ('copy', 'watch')),
  created_at   timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (signal_id) REFERENCES market_signals(signal_id) ON DELETE CASCADE,
  UNIQUE (signal_id, user_id)
);

CREATE INDEX market_signal_follows_user_idx
  ON market_signal_follows (user_id);

-- Down Migration
DROP TABLE IF EXISTS market_signal_follows;
