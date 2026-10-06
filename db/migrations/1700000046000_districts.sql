-- Migration: 046_districts
--
-- The M7 districts. A district is a fixed geographic slice of
-- the city (timeline_square, perp_pit, builder_hills, airdrop_farm,
-- spaces_studio, prediction_pit, the_trenches, dubai_marina,
-- cabal_lounge, marina_villa). One district belongs to one tribe
-- at a time; the top-scoring tribe at the end of each day wins
-- control of the district for the next 24h.
--
-- `slug` is the stable id used in URLs and the realtime
-- (`district:<slug>`). UNIQUE.
--
-- `name` and `lore` are display fields.
--
-- `current_owner_tribe_id` is the tribe that currently controls
-- the district (text; the contract registry in `contract/ids/
-- tribes.json` is the source of truth for the enum). nullable
-- for districts that have never been won (the application seeds
-- a default holder at startup).
--
-- `controlled_since` is the timestamp the current owner took
-- over. nullable for never-won districts.
--
-- `default_holder_tribe_id` is the tribe the district belongs
-- to by default (from the contract registry's `homeTurf` field).
-- Used by the seed code to set `current_owner_tribe_id` on first
-- run.
--
-- `base_score_per_day` is the per-day score floor; the worker
-- that rolls the daily scores reads this when computing the
-- winner. CHECK > 0.
--
-- Index:
--   (current_owner_tribe_id) - "all districts owned by tribe X"

-- Up Migration
CREATE TABLE districts (
  district_id              text PRIMARY KEY,
  slug                     text NOT NULL UNIQUE,
  name                     text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  lore                     text NOT NULL DEFAULT '' CHECK (length(lore) <= 1000),
  current_owner_tribe_id   text,
  controlled_since         timestamptz,
  default_holder_tribe_id  text NOT NULL,
  base_score_per_day       int NOT NULL CHECK (base_score_per_day > 0),
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX districts_owner_idx
  ON districts (current_owner_tribe_id);

-- Down Migration
DROP TABLE IF EXISTS districts;
