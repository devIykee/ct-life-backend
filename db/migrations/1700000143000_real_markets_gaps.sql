-- Migration: 143_real_markets_gaps
--
-- Two gaps the Real Markets client round found (docs/REAL-MARKETS.md).
--
--   age_confirmations   append-only audit of 18+ confirmations made AFTER character
--                       creation (POST /v1/me/age-confirm). The flag itself stays
--                       `characters.age_confirmed_at`, the one column character creation,
--                       the casino, the Factory, the Prediction Pit and Real Markets read.
--                       A row is written only when the flag goes from unset to set; a
--                       repeat call writes nothing. `client_version` is the caller's
--                       X-Client-Version (no IP, no device id). Deleted with the account.
--
--   real_market_orders  + `recent_blockhash` and `ix_fingerprints`: what the server needs
--                       to recognise a built order's transaction on chain when the app
--                       died after the wallet broadcast it but before it reported the
--                       signature. A fingerprint is sha256(programId ':' base64(data)) of
--                       one instruction of the built transaction (compute-budget
--                       instructions excluded: wallets rewrite them). `reconciled_at` is
--                       set when the server, not the client, attached the signature.

-- Up Migration
CREATE TABLE age_confirmations (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('me_age_confirm')),
  client_version  text CHECK (client_version IS NULL OR length(client_version) <= 32),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX age_confirmations_user_idx ON age_confirmations (user_id, created_at DESC);

ALTER TABLE real_market_orders
  ADD COLUMN recent_blockhash text,
  ADD COLUMN ix_fingerprints  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN reconciled_at    timestamptz;

-- Reconciliation reads a player's unsigned orders of the last day.
CREATE INDEX real_market_orders_unsigned_idx
  ON real_market_orders (user_id, created_at DESC) WHERE status = 'built';

-- Down Migration
DROP INDEX IF EXISTS real_market_orders_unsigned_idx;
ALTER TABLE real_market_orders
  DROP COLUMN IF EXISTS reconciled_at,
  DROP COLUMN IF EXISTS ix_fingerprints,
  DROP COLUMN IF EXISTS recent_blockhash;
DROP TABLE IF EXISTS age_confirmations;
