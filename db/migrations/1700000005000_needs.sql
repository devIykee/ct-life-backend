-- Migration: 005_needs
--
-- Per-user needs (energy, hunger, fun, hygiene, sanity). Each is a
-- 0-100 smallint with a server-side CHECK. Decay is computed on read
-- from `last_action_at` against needs.json (server/shared/needs/decay.ts);
-- the row stores the last write and a timestamp.
--
-- The decay formula runs every read so the column never has to be
-- written. Writes happen when the player acts (POST /v1/needs/actions)
-- or when a paid action is consumed. The hourly decay is config-driven
-- (M2 needs.json), so this table does not need to change when the
-- config changes.

-- Up Migration
CREATE TABLE needs (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  energy           smallint NOT NULL DEFAULT 50 CHECK (energy BETWEEN 0 AND 100),
  hunger           smallint NOT NULL DEFAULT 50 CHECK (hunger BETWEEN 0 AND 100),
  fun              smallint NOT NULL DEFAULT 50 CHECK (fun BETWEEN 0 AND 100),
  hygiene          smallint NOT NULL DEFAULT 50 CHECK (hygiene BETWEEN 0 AND 100),
  sanity           smallint NOT NULL DEFAULT 50 CHECK (sanity BETWEEN 0 AND 100),
  last_action_at   timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS needs;
