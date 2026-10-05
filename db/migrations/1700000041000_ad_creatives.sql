-- Migration: 041_ad_creatives
--
-- One row per booking -> image. The S3 object lives at
-- ads/{upload_id} and is referenced by `image_key`. The
-- ad-booking service writes the row in the same transaction
-- as the ad_bookings row.
--
-- `mime_type` is constrained to the two formats the application
-- accepts (PNG and JPG); the upload route (POST /v1/uploads)
-- rejects anything else.
--
-- `size_bytes` is the raw upload size, <= 1 MB (1048576 bytes).
-- The CHECK enforces the cap at the DB layer; the upload route
-- is the first line of defense.
--
-- `uploaded_at` is informational; the audit log of who approved
-- / rejected lives in the M5 admin flow (out of M5 scope; the
-- ad_bookings row carries the live state).
--
-- Index:
--   (booking_id) UNIQUE — one creative per booking

-- Up Migration
CREATE TABLE ad_creatives (
  creative_id   uuid PRIMARY KEY,
  booking_id    uuid NOT NULL UNIQUE REFERENCES ad_bookings(booking_id),
  image_key     text NOT NULL,
  mime_type     text NOT NULL
                 CHECK (mime_type IN ('image/png', 'image/jpeg')),
  size_bytes    integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  uploaded_at   timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS ad_creatives;
