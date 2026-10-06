-- Migration: 048_project_hq_rooms
--
-- The M6 Project HQ room. Each project may have multiple HQs
-- (main, meeting, dev, mod, kol, auditor). Every HQ has a
-- backing LiveKit room (voice_room_id) and a small
-- message channel surfaced through the M6 project-hq Colyseus
-- room. The HQ is the unit of capacity + auth for a project
-- voice hangout.
--
-- `project_id` is the parent project (M5 #65 projects table).
--
-- `kind` is the HQ family:
--   'main'    - the default HQ; project owner + hired members
--   'meeting' - small synchronous standup
--   'dev'     - dev-only room (the hired devs from M5 #65)
--   'mod'     - moderation room
--   'kol'     - KOL room (private KOLs only)
--   'auditor' - the auditor hangout
-- The CHECK keeps the enum honest at the schema level.
--
-- `capacity` is the hard upper bound on concurrent members
-- (project_hq_members rows where last_seen_at is recent).
-- CHECK between 2 and 50 mirrors the spec's room cap.
--
-- `voice_room_id` is the LiveKit room name (`{kind}:{id}`).
-- UNIQUE so a re-create cannot double-bind the same LiveKit
-- room.
--
-- `created_at` is set on insert.

-- Up Migration
CREATE TABLE project_hq_rooms (
  hq_id          uuid PRIMARY KEY,
  project_id     uuid NOT NULL,
  kind           text NOT NULL
                  CHECK (kind IN ('main', 'meeting', 'dev', 'mod', 'kol', 'auditor')),
  capacity       int NOT NULL CHECK (capacity BETWEEN 2 AND 50),
  voice_room_id  text NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_hq_rooms_project_idx
  ON project_hq_rooms (project_id);

-- Down Migration
DROP TABLE IF EXISTS project_hq_rooms;
