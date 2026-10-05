-- Migration: 010_payment_intents
--
-- Every external payment creates a row here. The client submits the
-- signature (Solana Pay) once the on-chain transfer is sent; the Helius
-- webhook (or the polling reconciler) reads the row, fetches the
-- transaction, and credits the ledger. `reference` is the unique
-- client-facing reference (also embedded in the Solana Pay URL). It is
-- UNIQUE so the webhook and the poller can race `INSERT ... ON CONFLICT
-- (reference) DO NOTHING` safely.
--
-- `kind` is what the payment is FOR: cash top-up, cosmetic, ad
-- booking, season pass. The M3 slice ships `topup` only; the rest
-- land in M4/M5. `currency` is what the client paid in. `amount` is
-- a string of base units (USDC 6dp, SOL 9dp, SKR 5dp, ORE 11dp).
--
-- `signature` is the on-chain transaction signature. UNIQUE so the
-- webhook is idempotent. `expires_at` is 15 minutes from creation; the
-- poller marks the row `expired` past that.
--
-- Indexes:
--   (user_id, created_at DESC) per-user history tail
--   (status, expires_at)      the poller picks up the soonest expiring

-- Up Migration
CREATE TABLE payment_intents (
  intent_id      uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind           text NOT NULL CHECK (kind IN ('topup', 'cosmetic', 'ad', 'season_pass')),
  currency       text NOT NULL CHECK (currency IN ('USDC', 'SOL', 'SKR', 'ORE')),
  amount         text NOT NULL,
  recipient      text NOT NULL,
  mint           text,
  reference      text NOT NULL UNIQUE,
  memo           text NOT NULL,
  cash_cents     bigint,
  bonus_bps      smallint NOT NULL DEFAULT 0 CHECK (bonus_bps >= 0),
  status         text NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired', 'failed')),
  signature      text UNIQUE,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX payment_intents_user_created_idx
  ON payment_intents (user_id, created_at DESC);

CREATE INDEX payment_intents_status_expires_idx
  ON payment_intents (status, expires_at);

-- Down Migration
DROP TABLE IF EXISTS payment_intents;
