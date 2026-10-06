-- Migration: 050_season_pass_perks
--
-- The M6 season pass weekly perks. One row per (user, week,
-- kind). The Sunday Unlock worker (M5 #60) credits
-- 'weekly_perk' to season-pass holders; the M6 claim route
-- credits 'exclusive_discount' and 'badge' on demand.
--
-- `kind` is the perk family:
--   'weekly_perk'        - the Sunday Unlock cash drop
--   'exclusive_discount' - a shop discount credited in cash
--   'badge'              - a profile badge (no cash, just a row)
-- The CHECK keeps the enum honest at the schema level.
--
-- `credited_cents` is the cash value of the perk. 0 for
-- 'badge' (a profile badge has no cash). The application
-- refuses negative values via the CHECK >= 0 floor.
--
-- `week_iso` is the ISO-8601 week identifier (e.g. '2026-W40').
-- The Sunday Unlock worker uses the same identifier.
--
-- UNIQUE (user_id, week_iso, kind) is the floor for double-claim
-- rejection. A second claim of the same kind in the same week
-- translates to a unique_violation, which the application maps
-- to 409.

-- Up Migration
CREATE TABLE season_pass_perks (
  perk_id          uuid PRIMARY KEY,
  user_id          uuid NOT NULL,
  week_iso         text NOT NULL,
  kind             text NOT NULL
                    CHECK (kind IN ('weekly_perk', 'exclusive_discount', 'badge')),
  credited_cents   bigint NOT NULL DEFAULT 0 CHECK (credited_cents >= 0),
  claimed_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, week_iso, kind)
);

CREATE INDEX season_pass_perks_user_idx
  ON season_pass_perks (user_id);

CREATE INDEX season_pass_perks_week_idx
  ON season_pass_perks (week_iso);

-- Down Migration
DROP TABLE IF EXISTS season_pass_perks;
