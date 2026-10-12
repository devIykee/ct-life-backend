-- Up Migration
-- Owner-bound ad uploads and a paid booking lifecycle: a booking reserves a
-- slot window, waits for a verified USDC payment, then goes to review.
-- Rejected or cancelled paid bookings record an owed refund.

CREATE TABLE ad_uploads (
  upload_id   uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  image_key   text NOT NULL UNIQUE,
  mime_type   text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg')),
  size_bytes  integer NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 1048576),
  sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ad_uploads_user_created_idx ON ad_uploads (user_id, created_at DESC);

ALTER TABLE ad_bookings DROP CONSTRAINT ad_bookings_status_check;
ALTER TABLE ad_bookings ADD CONSTRAINT ad_bookings_status_check
  CHECK (status IN ('awaiting_payment', 'pending_review', 'live', 'rejected', 'cancelled', 'expired'));

ALTER TABLE ad_bookings
  ADD COLUMN intent_id uuid UNIQUE REFERENCES payment_intents(intent_id) ON DELETE RESTRICT,
  ADD COLUMN price_cents bigint CHECK (price_cents > 0),
  ADD COLUMN starts_at timestamptz,
  ADD COLUMN ends_at timestamptz,
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN decided_at timestamptz,
  ADD COLUMN refund_status text CHECK (refund_status IN ('due', 'refunded')),
  ADD COLUMN refund_cents bigint CHECK (refund_cents > 0),
  ADD COLUMN refund_signature text UNIQUE,
  ADD CONSTRAINT ad_bookings_window_check CHECK (ends_at IS NULL OR ends_at > starts_at);

CREATE INDEX ad_bookings_slot_window_idx ON ad_bookings (slot_id, ends_at)
  WHERE status IN ('awaiting_payment', 'pending_review', 'live');
