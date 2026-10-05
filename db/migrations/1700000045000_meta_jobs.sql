-- Migration: 045_meta_jobs
--
-- Audit log for the Sunday Unlock + Weekly Meta rotation
-- workers. UNIQUE (kind, week_iso) means each weekly
-- rotation writes exactly one row; a re-run of the cron
-- cannot double-credit season pass holders.
--
-- `kind` is the worker family:
--   'weekly_meta'   - the Weekly Meta rotation
--   'sunday_unlock' - the Sunday Unlock perk drop
--
-- `week_iso` is the ISO-8601 week identifier (e.g. '2026-W40').
-- The application derives it from the current Monday's date.
--
-- `payload` is a jsonb with the worker's output:
--   weekly_meta  : { winners: [userId], losers: [userId], meta: {...} }
--   sunday_unlock: { perks: [{userId, kind, amountCents}], totalCents }
--
-- `created_at` is set by the application on insert.

-- Up Migration
CREATE TABLE meta_jobs (
  job_id        uuid PRIMARY KEY,
  kind          text NOT NULL
                 CHECK (kind IN ('weekly_meta', 'sunday_unlock')),
  week_iso      text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (kind, week_iso)
);

-- Down Migration
DROP TABLE IF EXISTS meta_jobs;
