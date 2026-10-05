-- Migration: 023_voice_speakers
--
-- Each LiveKit participant in a voice room is a row here. The
-- `speaker_id` is the UUIDv7 the backend generated when the
-- participant joined.
--
-- `role` is one of:
--     host      — the room's host (1 per room)
--     speaker   — promoted; canPublish=true on LiveKit
--     listener  — joined but not promoted; canPublish=false
--
-- A user can only be a participant once per room at a time (no
-- double joins). The UNIQUE partial index on (room_id, user_id)
-- WHERE left_at IS NULL enforces this without blocking re-joins
-- (a participant who left and comes back writes a new row).
--
-- `hand_raised_at` is set when a listener hits POST /spaces/{id}/hand
-- and cleared on promote, leave, or end. The Spaces Room keeps the
-- queue sorted by `hand_raised_at ASC` so the longest waiting hand
-- is at the head.
--
-- `joined_at` is when the row was written (the join happened). The
-- LiveKit webhook updates `left_at` on participant_left; the
-- service that ends the room closes every open row with left_at=now()
-- if LiveKit missed the events.
--
-- Indexes:
--   (room_id, user_id) UNIQUE WHERE left_at IS NULL — active participant
--   (room_id, role) — current speakers query
--   (room_id, hand_raised_at) — hand queue

-- Up Migration
CREATE TABLE voice_speakers (
  speaker_id      uuid PRIMARY KEY,
  room_id         text NOT NULL REFERENCES voice_rooms(room_id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  role            text NOT NULL CHECK (role IN ('host', 'speaker', 'listener')),
  joined_at       timestamptz NOT NULL DEFAULT now(),
  left_at         timestamptz,
  hand_raised_at  timestamptz
);

CREATE UNIQUE INDEX voice_speakers_active_unique
  ON voice_speakers (room_id, user_id)
  WHERE left_at IS NULL;

CREATE INDEX voice_speakers_room_role_idx
  ON voice_speakers (room_id, role);

CREATE INDEX voice_speakers_room_hand_idx
  ON voice_speakers (room_id, hand_raised_at)
  WHERE hand_raised_at IS NOT NULL AND left_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS voice_speakers;