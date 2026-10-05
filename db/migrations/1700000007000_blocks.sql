-- Migration: 007_blocks
--
-- One-way blocks. The blocker hides the blocked user's chat, DMs and
-- other social signals. The UNIQUE (blocker_user_id, blocked_user_id)
-- constraint prevents double-blocks; the application re-tries on
-- 23505 (unique_violation) as an idempotent success.

-- Up Migration
CREATE TABLE blocks (
  id                  bigserial PRIMARY KEY,
  blocker_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blocks_pair_unique UNIQUE (blocker_user_id, blocked_user_id)
);

-- Down Migration
DROP TABLE IF EXISTS blocks;
