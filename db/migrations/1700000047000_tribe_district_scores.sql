-- Migration: 047_tribe_district_scores
--
-- The M7 daily score per (tribe, district). One row per
-- (tribe_id, district_id, day_date). The district-rollover
-- worker (server/workers/district-rollover.ts) reads the
-- top-scoring tribe for each district at end-of-day and
-- flips the district's `current_owner_tribe_id` to that
-- tribe.
--
-- `tribe_id` is the text id from contract/ids/tribes.json.
--
-- `district_id` is the FK to districts.district_id.
--
-- `day_date` is the UTC date the score applies to. The
-- worker writes a single row per tribe per district per
-- day; running the worker twice on the same day upserts
-- (ON CONFLICT DO UPDATE) so the second run is idempotent.
--
-- `score` is the per-day score (cumulative member activity
-- in the district + base_score_per_day from districts).
-- CHECK > 0 (a tribe with zero activity is not written).
--
-- UNIQUE (tribe_id, district_id, day_date) is the floor
-- for idempotent daily rolls.
--
-- Index:
--   (district_id, day_date DESC, score DESC) - the worker's
--   "top tribe for this district on this day" hot path.

-- Up Migration
CREATE TABLE tribe_district_scores (
  score_id     uuid PRIMARY KEY,
  tribe_id     text NOT NULL,
  district_id  text NOT NULL,
  day_date     date NOT NULL,
  score        int NOT NULL CHECK (score > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (district_id) REFERENCES districts(district_id) ON DELETE CASCADE,
  UNIQUE (tribe_id, district_id, day_date)
);

CREATE INDEX tribe_district_scores_lookup_idx
  ON tribe_district_scores (district_id, day_date DESC, score DESC);

CREATE INDEX tribe_district_scores_tribe_idx
  ON tribe_district_scores (tribe_id);

-- Down Migration
DROP TABLE IF EXISTS tribe_district_scores;
