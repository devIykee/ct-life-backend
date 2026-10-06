-- Migration: 053_beef_elo
--
-- The M7 #5 per-user Elo. One row per user. The Elo is bumped
-- at match settlement (Elo update = K * (actual - expected) where
-- K=32 by default). A user's starting Elo is 1500 (the master
-- prompt's default).
--
-- `elo` is the current rating. CHECK 0..3000.
--
-- `matches_played` is the running counter; CHECK >= 0.
-- `wins`, `losses`, `draws` track the W/L record; CHECK >= 0.
-- CHECK wins + losses + draws = matches_played.
--
-- UNIQUE on user_id is the floor; the Elo row is upserted on
-- every match settlement.

-- Up Migration
CREATE TABLE beef_elo (
  user_id         uuid PRIMARY KEY,
  elo             int NOT NULL CHECK (elo BETWEEN 0 AND 3000),
  matches_played  int NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  wins            int NOT NULL DEFAULT 0 CHECK (wins >= 0),
  losses          int NOT NULL DEFAULT 0 CHECK (losses >= 0),
  draws           int NOT NULL DEFAULT 0 CHECK (draws >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CHECK (wins + losses + draws = matches_played)
);

-- Down Migration
DROP TABLE IF EXISTS beef_elo;
