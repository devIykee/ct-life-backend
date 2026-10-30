-- Migration: 130_devnet_drips (unlock WP-C, block C)
--
-- One row per devnet SOL drip from the ops treasury (POST /v1/devnet/drip, capability
-- devnetDrip). Devnet SOL has no value; players need a little for fees on season-pass
-- payments, paid calls and Factory launches, and the public faucet is rate-limited.
--
-- `wallet_hash` is sha256(wallet) (walletHash in server/shared/solana/keypair.ts), not the
-- address, so account deletion (which anonymises users in place) leaves no wallet here.
--
-- UNIQUE (wallet_hash, day) and UNIQUE (user_id, day): at most one drip per wallet and per
-- account per UTC day, enforced by the database so two racing requests cannot both
-- send. A drip whose send failed before reaching the network is deleted, which frees the
-- day's slot. `signature` is known before the send (the server signs locally).
--
-- Indexes:
--   (day) for the global daily budget sum.

-- Up Migration
CREATE TABLE devnet_drips (
  drip_id     uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_hash text NOT NULL,
  day         date NOT NULL,
  lamports    bigint NOT NULL CHECK (lamports > 0),
  signature   text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet_hash, day),
  UNIQUE (user_id, day)
);

CREATE INDEX devnet_drips_day_idx ON devnet_drips (day);

-- Down Migration
DROP TABLE IF EXISTS devnet_drips;
