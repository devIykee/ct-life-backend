-- Migration: 025_creator_profiles
--
-- One per user who enables them. The `user_id` is PRIMARY KEY so a
-- user cannot have more than one creator profile. The application
-- also enforces this with a UNIQUE on user_id (redundant with PK,
-- but kept for the SQL check).
--
-- `handle` is the public identifier; UNIQUE so no two creators
-- share a handle. The handle is lowercase alphanumerics + underscores;
-- length 3..32 enforced by a CHECK.
--
-- `categories` is the creator's vertical tags (e.g. 'alpha', 'memes',
-- 'analysis'). text[] with a default empty array. We do not constrain
-- the list because the team will add verticals over time.
--
-- `banner_image_key` and `avatar_image_key` are S3 object keys; the
-- actual upload flow ships in M5.
--
-- Indexes:
--   (handle) UNIQUE — the public lookup
--   (user_id) PK — one row per user

-- Up Migration
CREATE TABLE creator_profiles (
  user_id            uuid PRIMARY KEY,
  handle             text NOT NULL UNIQUE
                      CHECK (length(handle) BETWEEN 3 AND 32
                        AND handle ~ '^[a-z0-9_]+$'),
  bio                text NOT NULL DEFAULT '' CHECK (length(bio) <= 500),
  banner_image_key   text,
  avatar_image_key   text,
  categories         text[] NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX creator_profiles_categories_idx
  ON creator_profiles USING gin (categories);

-- Down Migration
DROP TABLE IF EXISTS creator_profiles;