-- Migration: 018_follows
--
-- A directed edge: `follower_user_id` follows `followee_user_id`.
-- The PRIMARY KEY (follower, followee) enforces "follow at most
-- once" and powers the O(1) "is X following Y?" check. The
-- (followee) index is for "who follows me?" lookups.
--
-- Self-follow is forbidden by a CHECK.

-- Up Migration
CREATE TABLE follows (
  follower_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_user_id, followee_user_id),
  CHECK (follower_user_id <> followee_user_id)
);

CREATE INDEX follows_followee_idx ON follows (followee_user_id);

-- Down Migration
DROP TABLE IF EXISTS follows;
