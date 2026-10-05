-- Migration: 016_dm_messages
--
-- Direct messages between two users. The server filters out messages
-- from anyone in the requester's blocks list (so a blocked user can
-- still send, but the requester never sees them).
--
-- `text` is bounded to 1..500 by the application AND by a CHECK
-- here. The server sanitises (strips links, phones) before insert;
-- the cap is the hard ceiling.
--
-- Index:
--   (to_user_id, created_at DESC) inbox tail-read
--   (from_user_id, to_user_id)   conversation lookup (added in 020)

-- Up Migration
CREATE TABLE dm_messages (
  message_id     uuid PRIMARY KEY,
  from_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  to_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  text           text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX dm_messages_to_created_idx ON dm_messages (to_user_id, created_at DESC);
CREATE INDEX dm_messages_conv_idx ON dm_messages (from_user_id, to_user_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS dm_messages;
