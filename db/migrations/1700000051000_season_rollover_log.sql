-- Migration: 051_season_rollover_log
--
-- The M7 season rollover audit log. One row per (kind, season_iso).
-- The rollover worker writes a 'season_rollover' row when it
-- finishes assigning the season_memberships; a re-run is a no-op
-- because of the UNIQUE (kind, season_iso) constraint.
--
-- Same pattern as M5's `meta_jobs` table. Idempotency UNIQUE is
-- the floor; the application's ON CONFLICT is the no-op path.
--
-- `kind` is the worker family:
--   'season_rollover'   - the per-season promotion + reassignment
--
-- `payload` is jsonb with the worker's output:
--   { promoted: [{userId, from, to}], relegated: [{userId, from, to}],
--     totalMembers, seasonEndAt }

-- Up Migration
CREATE TABLE season_rollover_log (
  log_id        uuid PRIMARY KEY,
  kind          text NOT NULL
                 CHECK (kind IN ('season_rollover')),
  season_iso    text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (kind, season_iso)
);

-- Down Migration
DROP TABLE IF EXISTS season_rollover_log;
