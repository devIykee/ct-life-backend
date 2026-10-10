-- Up Migration
-- Per-user, per-career progression.
--
-- Shift completion used to pay Cash and report XP without storing it,
-- and GET /v1/careers hardcoded level 1 / 0 XP, so every earned XP
-- point was lost on the next read. One row per (user, career) the
-- player has applied to or worked; `xp` is the progress inside the
-- current `level` and resets by that level's threshold on promotion
-- (thresholds are careers.json `levels[].xp`).

CREATE TABLE IF NOT EXISTS career_progress (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  career_id   text NOT NULL,
  level       smallint NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 5),
  xp          integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  applied_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, career_id)
);

-- Down Migration
DROP TABLE IF EXISTS career_progress;
