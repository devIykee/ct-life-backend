-- Migration: 017_feed_posts
--
-- The global + following feed. Posts are short (1..280 chars). The
-- `following` scope joins on `follows` to filter the result set.
--
-- Index:
--   (created_at DESC)         global scope hot read
--   (user_id, created_at DESC) per-user history
--   The join is `(follows.follower_user_id = me) AND
--   (feed_posts.user_id = follows.followee_user_id)` — covered
--   by the per-user index + a sort.

-- Up Migration
CREATE TABLE feed_posts (
  post_id     uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  text        text NOT NULL CHECK (length(text) BETWEEN 1 AND 280),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX feed_posts_user_created_idx ON feed_posts (user_id, created_at DESC);
CREATE INDEX feed_posts_created_idx ON feed_posts (created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS feed_posts;
