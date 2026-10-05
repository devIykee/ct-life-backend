-- Migration: 032_daily_clue_attempts
--
-- One row per (user, clue) pair. The UNIQUE enforces "one attempt
-- per user per day" at the database level; the application
-- translates a duplicate insert into a 409 ALREADY_ATTEMPTED.
--
-- `attempt_text` is what the user submitted (1..200 chars; the
-- application also lowercases + trims before hashing for
-- comparison).
--
-- `correct` is recorded on insert (after the application
-- compared the hash). The combination of UNIQUE (user_id,
-- clue_id) and the `correct` column is the audit trail for the
-- Sunday Unlock + Weekly Meta rotation: "winners and losers of
-- the week" comes from this table.
--
-- Index:
--   (user_id, clue_id) UNIQUE — primary access pattern
--   (clue_id) — leaderboard queries "who solved today?"

-- Up Migration
CREATE TABLE daily_clue_attempts (
  attempt_id     uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  clue_id        uuid NOT NULL REFERENCES daily_clue(clue_id),
  attempt_text   text NOT NULL CHECK (length(attempt_text) BETWEEN 1 AND 200),
  correct        boolean NOT NULL,
  attempted_at   timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, clue_id)
);

CREATE INDEX daily_clue_attempts_clue_idx
  ON daily_clue_attempts (clue_id);

-- Down Migration
DROP TABLE IF EXISTS daily_clue_attempts;
