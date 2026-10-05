-- Migration: 024_paid_call_escrow
--
-- Each paid call has one escrow row. The escrow lifecycle:
--
--   pending  →  active  →  settled
--                    ↘  refunded
--                    ↘  disputed  (M5+ moderation, not in M4)
--
-- `pending`: caller created the call and posted the LiveKit URL, but
-- the on-chain funding signature has not yet been confirmed by the
-- Helius webhook.
--
-- `active`: funding signature confirmed. The call can proceed.
-- `settled_cents` accumulates as the call runs.
--
-- `settled`: call ended normally. settled_cents is the final amount
-- credited to the creator (minus the 5% fee, which lives in a
-- separate 'fee' ledger row).
--
-- `refunded`: creator declined, or the funding never landed and the
-- caller cancelled. settled_cents stays at 0.
--
-- `disputed`: reserved for M5; not used in M4.
--
-- `call_id` is the same UUIDv7 the backend minted for the
-- `voice_rooms` row of `kind='paid_call'`. We do not set it as a
-- FOREIGN KEY because the voice_rooms row is the LiveKit name; the
-- application maintains the 1:1 link.
--
-- `settlement_tx_signature` is the on-chain signature that funded
-- the escrow (Solana Pay transfer to the treasury). The Helius
-- webhook writes it once the transfer is confirmed.
--
-- Indexes:
--   (status)            the worker pollits pending → active transitions
--   (payer_user_id)     the caller's call list
--   (payee_user_id)     the creator's incoming call list

-- Up Migration
CREATE TABLE paid_call_escrow (
  escrow_id                  uuid PRIMARY KEY,
  call_id                    uuid NOT NULL UNIQUE,
  payer_user_id              uuid NOT NULL,
  payee_user_id              uuid NOT NULL,
  total_cents                bigint NOT NULL CHECK (total_cents > 0),
  settled_cents              bigint NOT NULL DEFAULT 0 CHECK (settled_cents >= 0),
  status                     text NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'active', 'settled', 'refunded', 'disputed')),
  settlement_tx_signature    text UNIQUE,
  started_at                 timestamptz NOT NULL DEFAULT now(),
  ended_at                   timestamptz
);

CREATE INDEX paid_call_escrow_status_idx
  ON paid_call_escrow (status);

CREATE INDEX paid_call_escrow_payer_idx
  ON paid_call_escrow (payer_user_id);

CREATE INDEX paid_call_escrow_payee_idx
  ON paid_call_escrow (payee_user_id);

-- Down Migration
DROP TABLE IF EXISTS paid_call_escrow;