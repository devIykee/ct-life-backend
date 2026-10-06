-- Migration: 050_season_memberships
--
-- The M7 per-player league assignment for a season. One row per
-- (user_id, season_iso). The rollover worker
-- (server/workers/season-rollover.ts) writes the row at the
-- start of a new season, computed from the player's net worth
-- + the league tier's max_members cap. Idempotent on
-- (user_id, season_iso) so a re-run within the same season
-- upserts (ON CONFLICT DO UPDATE).
--
-- `season_iso` is the ISO-8601 week identifier (e.g. '2026-W40')
-- or season identifier ('2026-Q4'); the service derives it from
-- the rollover date. The format is opaque here; the worker
-- picks one and stays with it.
--
-- `net_worth_cents` is the player's cash_cents - debt_cents at
-- the time of the rollover. CHECK may be negative (debt) but
-- the entry league for negative net worth is iron (the floor
-- is 0).
--
-- `rank` is the player's rank within the league at the start
-- of the season (1-indexed). CHECK > 0.
--
-- `promoted_from_league_id` is the league the player was in
-- last season (nullable for the first ever assignment).
--
-- UNIQUE (user_id, season_iso) is the floor for idempotent
-- rollover.

-- Up Migration
CREATE TABLE season_memberships (
  membership_id           uuid PRIMARY KEY,
  user_id                 uuid NOT NULL,
  season_iso              text NOT NULL,
  league_id               text NOT NULL,
  net_worth_cents         bigint NOT NULL,
  rank                    int NOT NULL CHECK (rank > 0),
  promoted_from_league_id text,
  created_at              timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (league_id) REFERENCES leagues(league_id) ON DELETE RESTRICT,
  FOREIGN KEY (promoted_from_league_id) REFERENCES leagues(league_id) ON DELETE SET NULL,
  UNIQUE (user_id, season_iso)
);

CREATE INDEX season_memberships_season_league_idx
  ON season_memberships (season_iso, league_id);

CREATE INDEX season_memberships_user_idx
  ON season_memberships (user_id);

-- Down Migration
DROP TABLE IF EXISTS season_memberships;
