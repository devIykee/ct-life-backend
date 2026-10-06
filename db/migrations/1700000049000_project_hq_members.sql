-- Migration: 049_project_hq_members
--
-- The M6 Project HQ membership. One row per (hq, user) pair.
-- A user joins an HQ by calling POST /v1/projects/{id}/hq/{hqId}/join
-- (M6 #73); the application mints a LiveKit token + inserts the
-- row. The same call on replay is a no-op.
--
-- `hq_id` is the parent HQ room (M6 #48).
-- `user_id` is the player.
-- `joined_at` is set on first join.
-- `last_seen_at` is updated on each leave (and on heartbeat ticks
-- from the realtime room).
--
-- UNIQUE (hq_id, user_id) is the floor for idempotent join.

-- Up Migration
CREATE TABLE project_hq_members (
  member_id     uuid PRIMARY KEY,
  hq_id         uuid NOT NULL,
  user_id       uuid NOT NULL,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (hq_id) REFERENCES project_hq_rooms(hq_id) ON DELETE CASCADE,
  UNIQUE (hq_id, user_id)
);

CREATE INDEX project_hq_members_hq_idx
  ON project_hq_members (hq_id);

CREATE INDEX project_hq_members_user_idx
  ON project_hq_members (user_id);

-- Down Migration
DROP TABLE IF EXISTS project_hq_members;
