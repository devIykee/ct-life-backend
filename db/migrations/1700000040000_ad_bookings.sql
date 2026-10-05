-- Migration: 040_ad_bookings
--
-- One row per ad placement. The state machine:
--
--   pending_review  ->  live  (admin approves)
--                  \->  rejected (admin rejects)
--
-- `slot_id` references ad_slots.slot_id (text FK).
-- `term_id` is the chosen term ('term_7d', 'term_30d', 'term_event').
-- `upload_id` is the S3 key the client uploaded; the matching
--              ad_creatives row holds the mime + size.
-- `link` is the click-through URL (1..500 chars).
--
-- `status` is one of the three. The CHECK keeps the application
-- honest. A pending_review row is invisible to GET /v1/ads/live;
-- the live endpoint filters on status='live'.
--
-- Indexes:
--   (slot_id, status)            — the live-ads query
--   (user_id, created_at DESC)   — the advertiser's history

-- Up Migration
CREATE TABLE ad_bookings (
  booking_id     uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  slot_id        text NOT NULL REFERENCES ad_slots(slot_id),
  term_id        text NOT NULL,
  upload_id      text NOT NULL,
  link           text NOT NULL CHECK (length(link) BETWEEN 1 AND 500),
  status         text NOT NULL DEFAULT 'pending_review'
                  CHECK (status IN ('pending_review', 'live', 'rejected')),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ad_bookings_slot_status_idx
  ON ad_bookings (slot_id, status);

CREATE INDEX ad_bookings_user_created_idx
  ON ad_bookings (user_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS ad_bookings;
