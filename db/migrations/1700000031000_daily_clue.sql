-- Migration: 031_daily_clue
--
-- One row per calendar day. The puzzle text + answer hash are
-- published by the daily-clue worker (Cron-style) at 00:00 UTC
-- for the current day. Players POST a guess against the
-- daily_clue_attempts table; the application never reveals the
-- answer hash to the client (the contract says only `clueText`
-- and `expiresAt` come back from GET /v1/daily-clue).
--
-- `date` is a `date` and is UNIQUE so the application cannot
-- insert two clues for the same day.
--
-- `answer_hash` is a SHA-256 hex digest of the canonical
-- lowercased answer; the application compares hashes.
--
-- `prize_cents` is the Cash prize (e.g. 5000 = $50) credited to
-- the winner via a 'daily_clue' ledger row. The CHECK is > 0 so
-- a row cannot be inserted with a zero / negative prize.
--
-- `expires_at` is the day boundary in UTC (24h after 00:00).
-- Workers and the application both use it as the cutoff for
-- the late-attempt rejection.
--
-- Index:
--   (date) — implicit via the UNIQUE; the explicit index keeps
--            the GET /v1/daily-clue lookup fast.

-- Up Migration
CREATE TABLE daily_clue (
  clue_id       uuid PRIMARY KEY,
  date          date NOT NULL UNIQUE,
  clue_text     text NOT NULL CHECK (length(clue_text) BETWEEN 1 AND 500),
  answer_hash   text NOT NULL CHECK (length(answer_hash) = 64),
  prize_cents   bigint NOT NULL CHECK (prize_cents > 0),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX daily_clue_date_idx
  ON daily_clue (date);

-- Down Migration
DROP TABLE IF EXISTS daily_clue;
