-- Migration: 019_webhook_events
--
-- Idempotency log for inbound webhooks. (source, signature) is
-- UNIQUE: the Helius webhook handler inserts once, and any
-- retry of the same delivery is rejected at the DB layer.
-- The transport layer maps SQLSTATE 23505 to a successful
-- 200 response with the cached payload.
--
-- `processed_at` is set when the handler finishes applying the
-- side-effects. NULL means the payload was received but the
-- application work did not complete; a janitor can re-run.
--
-- `payload` is the raw JSON body. Stored verbatim so we can
-- debug signature edge cases without re-fetching from the
-- upstream.

-- Up Migration
CREATE TABLE webhook_events (
  event_id      uuid PRIMARY KEY,
  source        text NOT NULL CHECK (source IN ('helius', 'livekit', 'ore')),
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  signature     text NOT NULL,
  UNIQUE (source, signature)
);

-- Down Migration
DROP TABLE IF EXISTS webhook_events;
