-- Migration: 060_webhook_events_helius_program
--
-- Add 'helius_program' as a valid source for the program-event
-- webhook (Helius Enhanced Webhook filtered by program address).
-- This webhook delivers the Settled / Refunded events emitted by
-- ct_escrow; idempotency on (source, signature) is unchanged.

ALTER TABLE webhook_events
  DROP CONSTRAINT webhook_events_source_check;

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_source_check
    CHECK (source IN ('helius', 'livekit', 'ore', 'helius_program'));

-- Down Migration
ALTER TABLE webhook_events
  DROP CONSTRAINT webhook_events_source_check;

ALTER TABLE webhook_events
  ADD CONSTRAINT webhook_events_source_check
    CHECK (source IN ('helius', 'livekit', 'ore'));