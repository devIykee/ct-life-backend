-- Migration: 082_home_units
--
-- Enterable doors for homes. A unit is one door in the world: the
-- frontend owns the ids (contract/ids/home_units.json) and the API upserts
-- them into home_units. A lease takes a free unit of its tier and stores
-- it on the homes row.
--
-- `unit_id` is the door id, `flat:<buildingInstanceId>:<doorIndex>`.
-- `tier` is basement | flat | penthouse. `capacity` is the most people
-- living in the unit (the owner plus guests).
--
-- homes gets:
--   unit_id      — the unit this lease holds. Kept after move-out or
--                  eviction as history; a unit is only held while the
--                  home is active or overdue (the partial unique index).
--   status       — active | overdue | evicted | moved_out. The rent
--                  worker walks active -> overdue -> evicted.
--   missed_weeks — consecutive weekly rent runs the owner could not pay.
--   ended_at     — when the home became evicted or moved_out.
--
-- home_guests are the people the owner lets through the door.
--
-- Indexes:
--   homes (unit_id) WHERE active/overdue — one live lease per unit
--   home_units (tier)                     — free-unit lookup
--   home_guests (user_id)                 — "homes I may enter"

-- Up Migration
CREATE TABLE home_units (
  unit_id            text PRIMARY KEY,
  district           text NOT NULL,
  tier               text NOT NULL CHECK (tier IN ('basement', 'flat', 'penthouse')),
  room_type          text NOT NULL,
  weekly_rent_cents  bigint NOT NULL CHECK (weekly_rent_cents > 0),
  capacity           integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX home_units_tier_idx
  ON home_units (tier);

ALTER TABLE homes
  ADD COLUMN unit_id      text REFERENCES home_units(unit_id),
  ADD COLUMN status       text NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'overdue', 'evicted', 'moved_out')),
  ADD COLUMN missed_weeks integer NOT NULL DEFAULT 0 CHECK (missed_weeks >= 0),
  ADD COLUMN ended_at     timestamptz;

CREATE UNIQUE INDEX homes_live_unit_idx
  ON homes (unit_id)
  WHERE unit_id IS NOT NULL AND status IN ('active', 'overdue');

CREATE TABLE home_guests (
  home_id   text NOT NULL REFERENCES homes(home_id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (home_id, user_id)
);

CREATE INDEX home_guests_user_idx
  ON home_guests (user_id);

-- Down Migration
DROP TABLE IF EXISTS home_guests;
DROP INDEX IF EXISTS homes_live_unit_idx;
ALTER TABLE homes
  DROP COLUMN IF EXISTS ended_at,
  DROP COLUMN IF EXISTS missed_weeks,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS unit_id;
DROP TABLE IF EXISTS home_units;
