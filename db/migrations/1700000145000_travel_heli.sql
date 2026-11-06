-- Migration: 145_travel_heli
--
-- Map Travel phase 3 (docs/TRAVEL.md, capability travelHeli): helicopter trips.
-- `mode` gains 'heli'. For a heli trip `pickup_stop_id` holds the pickup helipad id
-- (a public pad or the owner's home pad) and the arrival is the public pad nearest
-- the destination door. Nothing else changes.

-- Up Migration
ALTER TABLE travel_trips DROP CONSTRAINT travel_trips_mode_check;
ALTER TABLE travel_trips ADD CONSTRAINT travel_trips_mode_check
  CHECK (mode IN ('bus', 'taxi', 'heli'));

-- Down Migration
ALTER TABLE travel_trips DROP CONSTRAINT travel_trips_mode_check;
ALTER TABLE travel_trips ADD CONSTRAINT travel_trips_mode_check
  CHECK (mode IN ('bus', 'taxi'));
