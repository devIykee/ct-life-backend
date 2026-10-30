-- Migration: 131_paid_calls_onchain (unlock WP-C C2, block C)
--
-- Creator mode: a creator opts in with a USDC rate (base units, 0.25..50 USDC a
-- minute) and a maximum call length. `payout_wallet` is the creator's wallet when they
-- turned it on; it seeds the escrow Session PDA and receives the creator's share.
--
-- `paid_calls`: one row per paid call on the ct_escrow program (server-built
-- open_session, server-verified funding, server-signed accept / settle / refund). It
-- replaces the cents-based `paid_call_escrow` path (left in place, unused, for history).
-- Amounts are USDC base units (bigint). No Cash ever moves (docs/ECONOMY.md).
--
-- Lifecycle:
--   awaiting_payment -> ringing (Session account verified on chain)
--   ringing -> live (accept sent) | refunding (declined / not answered in time)
--   live -> settled | settling (settle send failed; the worker retries)
--   refunding -> refunded
--   awaiting_payment -> expired (nothing on chain) | refunding (funded too late, or the
--                       creator got busy before it rang)
--   settling / refunding -> closed_unknown (the session closed and no settle or refund
--                       transaction for it was found; creator and fee amounts are zero)
--
-- One open call per fan and per creator (partial UNIQUE indexes) makes the
-- `409 call_in_progress` race-free.

-- Up Migration
ALTER TABLE creator_profiles
  ADD COLUMN enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN rate_per_min_usdc bigint
    CHECK (rate_per_min_usdc IS NULL OR rate_per_min_usdc BETWEEN 250000 AND 50000000),
  ADD COLUMN max_minutes smallint CHECK (max_minutes IS NULL OR max_minutes BETWEEN 1 AND 60),
  ADD COLUMN payout_wallet text,
  ADD COLUMN mode_updated_at timestamptz;

CREATE TABLE paid_calls (
  call_id           uuid PRIMARY KEY,
  fan_user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creator_user_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  fan_wallet        text NOT NULL,
  creator_wallet    text NOT NULL,
  session_id        bigint NOT NULL CHECK (session_id > 0),
  session_pda       text NOT NULL UNIQUE,
  rate_per_min      bigint NOT NULL CHECK (rate_per_min BETWEEN 250000 AND 50000000),
  max_minutes       smallint NOT NULL CHECK (max_minutes BETWEEN 1 AND 60),
  fee_bps           smallint NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  deposit           bigint NOT NULL CHECK (deposit > 0),
  status            text NOT NULL DEFAULT 'awaiting_payment'
                     CHECK (status IN ('awaiting_payment', 'ringing', 'live', 'settling',
                                       'settled', 'refunding', 'refunded', 'expired',
                                       'closed_unknown')),
  end_reason        text,
  open_signature    text UNIQUE,
  accept_signature  text,
  settle_signature  text,
  refund_signature  text,
  opened_at         timestamptz,
  accept_by         timestamptz,
  accepted_at       timestamptz,
  ended_at          timestamptz,
  seconds_used      integer CHECK (seconds_used IS NULL OR seconds_used >= 0),
  minutes_used      smallint,
  creator_amount    bigint,
  fee_amount        bigint,
  refund_amount     bigint,
  pay_by            timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (fan_user_id <> creator_user_id)
);

CREATE UNIQUE INDEX paid_calls_one_open_per_fan ON paid_calls (fan_user_id)
  WHERE status IN ('awaiting_payment', 'ringing', 'live', 'settling');
CREATE UNIQUE INDEX paid_calls_one_open_per_creator ON paid_calls (creator_user_id)
  WHERE status IN ('ringing', 'live', 'settling');
CREATE INDEX paid_calls_sweep_idx ON paid_calls (status, created_at)
  WHERE status IN ('awaiting_payment', 'ringing', 'live', 'settling', 'refunding');

-- Down Migration
DROP TABLE IF EXISTS paid_calls;
ALTER TABLE creator_profiles
  DROP COLUMN IF EXISTS mode_updated_at,
  DROP COLUMN IF EXISTS payout_wallet,
  DROP COLUMN IF EXISTS max_minutes,
  DROP COLUMN IF EXISTS rate_per_min_usdc,
  DROP COLUMN IF EXISTS enabled;
