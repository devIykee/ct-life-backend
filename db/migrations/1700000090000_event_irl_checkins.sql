-- Migration: 090_event_irl_checkins
--
-- Opt-in IRL check-in for real events (Breakpoint 2026). Privacy first: the
-- server checks the phone's position against the venue geofence in memory and
-- throws it away. NO coordinates, accuracy or distance are ever stored.
--
-- event_checkins — one row per (event, player): when they checked in and
--                  whether they chose to appear on the attendee board.
--                  `visible` is false until the player opts in. The primary
--                  key makes the one-time reward once; users.wallet is
--                  unique, so one claim per wallet follows.
-- events.geo_*   — the VENUE's geofence (public, from the calendar file):
--                  center, radius in metres, and the source of the
--                  coordinates. Not user data.
--
-- Indexes:
--   event_checkins (event_id, checked_in_at DESC, user_id) WHERE visible — the board

-- Up Migration
ALTER TABLE events
  ADD COLUMN geo_lat      double precision,
  ADD COLUMN geo_lng      double precision,
  ADD COLUMN geo_radius_m integer CHECK (geo_radius_m IS NULL OR geo_radius_m > 0),
  ADD COLUMN geo_source   text;

CREATE TABLE event_checkins (
  event_id       text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checked_in_at  timestamptz NOT NULL DEFAULT now(),
  visible        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX event_checkins_board_idx
  ON event_checkins (event_id, checked_in_at DESC, user_id)
  WHERE visible;

-- Down Migration
DROP TABLE IF EXISTS event_checkins;
ALTER TABLE events
  DROP COLUMN IF EXISTS geo_source,
  DROP COLUMN IF EXISTS geo_radius_m,
  DROP COLUMN IF EXISTS geo_lng,
  DROP COLUMN IF EXISTS geo_lat;
