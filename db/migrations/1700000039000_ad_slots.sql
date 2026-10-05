-- Migration: 039_ad_slots
--
-- The on-chain / on-world ad inventory. The M4 ads.ts held this
-- in memory; M5 moves it to Postgres so the booking and creative
-- upload flow can persist between restarts.
--
-- `slot_id` is the BE-owned string ID (e.g. 'billboard_01'). The
-- string PK is intentional - the FE references slots by ID in
-- the UI.
--
-- `kind` is the slot family (e.g. 'billboard', 'pixel_tile',
-- 'phone_app'). Not a CHECK because new slot families ship
-- in later phases.
--
-- `terms` is a jsonb with the per-term price + duration (e.g.
-- {"term_7d": 50000, "term_30d": 200000}). The application
-- validates the shape on read.
--
-- `next_free_at` is the earliest time a new booking can start
-- for this slot; the ad-booking service sets it to
-- created_at + term_duration on every successful booking.

-- Up Migration
CREATE TABLE ad_slots (
  slot_id        text PRIMARY KEY,
  kind           text NOT NULL,
  terms          jsonb NOT NULL,
  next_free_at   timestamptz
);

-- Down Migration
DROP TABLE IF EXISTS ad_slots;
