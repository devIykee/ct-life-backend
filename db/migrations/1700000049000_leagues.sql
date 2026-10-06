-- Migration: 049_leagues
--
-- The M7 league tier table. One row per league tier (iron,
-- bronze, silver, gold, diamond). The contract registry in
-- `contract/config/leagues.json` is the source of truth for the
-- min_net_worth_cents + max_members + promote rules; this table
-- is a denormalized read cache the service consults.
--
-- `slug` is the stable id; UNIQUE. Matches contract.
--
-- `min_net_worth_cents` is the floor for entry into the league.
-- CHECK >= 0.
--
-- `max_members` is the cap on how many players can be in this
-- league at the start of a season; CHECK > 0.
--
-- `sort_order` is the promotion ladder position (0 = iron,
-- 1 = bronze, ...). Used to compute the next league up.
-- UNIQUE.
--
-- `promote_to_slug` is the slug of the league above this one
-- (nullable for the top league, diamond).

-- Up Migration
CREATE TABLE leagues (
  league_id          text PRIMARY KEY,
  slug               text NOT NULL UNIQUE,
  label              text NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  min_net_worth_cents bigint NOT NULL CHECK (min_net_worth_cents >= 0),
  max_members        int NOT NULL CHECK (max_members > 0),
  sort_order         int NOT NULL UNIQUE,
  promote_to_slug    text
);

-- Down Migration
DROP TABLE IF EXISTS leagues;
