-- Migration: 048_district_ownership_history
--
-- The M7 ownership audit log. One row per ownership period.
-- The current owner of a district is the row with
-- `valid_to IS NULL` for that district.
--
-- The district-rollover worker (server/workers/
-- district-rollover.ts) inserts a new row on every
-- ownership change. The previous row's `valid_to` is set
-- to the same instant; that is the in-database proof of
-- the hand-off.
--
-- `tribe_id` is the new owner; `previous_tribe_id` is the
-- previous owner (nullable for the first ever assignment).
--
-- `valid_from` is the start of this ownership period.
-- `valid_to` is the end (NULL = still current).
--
-- UNIQUE (district_id, valid_from) is the floor; the
-- worker uses ON CONFLICT to make the rollover idempotent
-- on a re-run within the same day (no-op).
--
-- Index:
--   (district_id, valid_to) - "current owner of this
--   district" hot path.

-- Up Migration
CREATE TABLE district_ownership_history (
  history_id         uuid PRIMARY KEY,
  district_id        text NOT NULL,
  tribe_id           text NOT NULL,
  previous_tribe_id  text,
  valid_from         timestamptz NOT NULL,
  valid_to           timestamptz,

  FOREIGN KEY (district_id) REFERENCES districts(district_id) ON DELETE CASCADE,
  UNIQUE (district_id, valid_from)
);

CREATE INDEX district_ownership_history_current_idx
  ON district_ownership_history (district_id, valid_to);

-- Down Migration
DROP TABLE IF EXISTS district_ownership_history;
