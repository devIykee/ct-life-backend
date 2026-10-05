-- Migration: 022_voice_rooms
--
-- Voice rooms cover Spaces (audio rooms), free video calls, and paid
-- calls. A single `voice_rooms` row backs all three; the `kind`
-- distinguishes them so the column-shape stays uniform.
--
-- `room_id` is the LiveKit room name (`{kind}:{id}`). The id is the
-- UUIDv7 the backend generated when the room was opened. Primary key
-- on `room_id` (text) lets us look up by the LiveKit name without
-- an extra column.
--
-- `host_user_id` is the row's host for Spaces and video calls; for
-- paid calls the host is the caller (`payer_user_id` on the matching
-- `paid_call_escrow`). The host column is not enforced as a FK to
-- users for ON DELETE because we want a tombstone row to survive a
-- deleted user account (audit trail). The application enforces the
-- referential integrity on creation.
--
-- `status` is a state machine: live → ended. We do not need a third
-- value here; the per-room events table can carry detailed audit
-- history if we ever need it.
--
-- `max_speakers` defaults to 8 (the spec limit). Spaces can have up
-- to 8 promoted speakers + the host.
--
-- `requires_payment` and `price_per_minute_cents` are only set for
-- `kind='paid_call'`; the service that opens a paid call writes
-- them, the other writes leave them NULL / false.
--
-- Indexes:
--   (status, started_at DESC)  the live spaces list
--   (host_user_id)             the user's "spaces I host" list
--   (kind, status)             the M4 endpoints' kind-scoped queries

-- Up Migration
CREATE TABLE voice_rooms (
  room_id               text PRIMARY KEY,
  host_user_id          uuid NOT NULL,
  kind                  text NOT NULL CHECK (kind IN ('space', 'video', 'paid_call')),
  title                 text NOT NULL,
  status                text NOT NULL DEFAULT 'live'
                          CHECK (status IN ('live', 'ended')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  max_speakers          smallint NOT NULL DEFAULT 8 CHECK (max_speakers BETWEEN 1 AND 8),
  requires_payment      boolean NOT NULL DEFAULT false,
  price_per_minute_cents bigint CHECK (price_per_minute_cents IS NULL OR price_per_minute_cents > 0),
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_rooms_status_started_idx
  ON voice_rooms (status, started_at DESC);

CREATE INDEX voice_rooms_host_idx
  ON voice_rooms (host_user_id);

CREATE INDEX voice_rooms_kind_status_idx
  ON voice_rooms (kind, status);

-- Down Migration
DROP TABLE IF EXISTS voice_rooms;