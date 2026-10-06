-- Migration: 059_paid_call_escrow_onchain
--
-- Additive: extend `paid_call_escrow` for the Anchor ct_escrow
-- on-chain settlement path. Master prompt M4 follow-up: the
-- server now optionally builds + submits the Anchor
-- `settle(seconds_used)` instruction signed by the configured
-- settle authority. The session PDA on Solana is keyed by
-- (fan, onchain_session_id) — we store the monotonic id so the
-- webhook can recompute the PDA and reconcile the in-game ledger.
--
-- Columns:
--   onchain_session_id (bigint) — the monotonic session id used to
--     derive the Session PDA. NULL means the call was created
--     before this migration landed (legacy local-compute path).
--
-- Status semantics:
--   `pending_onchain` is a new state added to the CHECK. The
--     settle transaction has been submitted; the program-event
--     webhook will reconcile the ledger when the `Settled` event
--     lands. The next state is `settled` (or `refunded` on the
--     `Refunded` event).

-- Up Migration
ALTER TABLE paid_call_escrow
  ADD COLUMN onchain_session_id bigint;

ALTER TABLE paid_call_escrow
  DROP CONSTRAINT paid_call_escrow_status_check;

ALTER TABLE paid_call_escrow
  ADD CONSTRAINT paid_call_escrow_status_check
    CHECK (status IN ('pending', 'active', 'settled', 'refunded', 'disputed', 'pending_onchain'));

-- Down Migration
ALTER TABLE paid_call_escrow
  DROP CONSTRAINT paid_call_escrow_status_check;

ALTER TABLE paid_call_escrow
  ADD CONSTRAINT paid_call_escrow_status_check
    CHECK (status IN ('pending', 'active', 'settled', 'refunded', 'disputed'));

ALTER TABLE paid_call_escrow
  DROP COLUMN IF EXISTS onchain_session_id;