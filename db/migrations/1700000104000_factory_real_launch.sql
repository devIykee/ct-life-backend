-- Migration: 104_factory_real_launch
--
-- The Rugpull Factory launches REAL Solana tokens on Meteora's Dynamic
-- Bonding Curve (DBC). The Cash sandbox is retired. See docs/FACTORY-REAL.md.
--
-- factory_launches  one row per prepared launch: the player's wallet, the
--                   fresh mint and pool addresses, the prepared transaction
--                   (public data: it is what the wallet signs), its
--                   blockhash deadline, and the status
--                   prepared -> submitted -> confirmed | expired | failed.
--                   The mint's secret key is NEVER stored here: it lives in
--                   Redis for 15 minutes (to co-sign the fallback path), then
--                   is gone.
-- factory_tokens    the live registry of confirmed real tokens (one per mint),
--                   with a cached read model of the on-chain pool (price,
--                   reserves, curve progress, migrated) refreshed on read.
-- factory_token_trades  swaps seen on our pools (Helius raw webhook), for
--                   charts, volume and the creator-sell (rug) detector.
-- factory_creator_moves  creator wallet balance drops on a launched mint:
--                   sell (heat + exposé, penalty only) or transfer out
--                   (smaller heat). One row per transaction signature.
-- factory_metadata  token image and metadata JSON when the 'self' metadata
--                   store serves them from our own API (devnet / no Pinata).
-- factory_webhook_events  raw webhook signatures already processed (Helius
--                   retries, expect duplicates).

-- Up Migration
CREATE TABLE factory_launches (
  launch_id               uuid PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet                  text NOT NULL,
  cluster                 text NOT NULL CHECK (cluster IN ('devnet', 'mainnet')),
  dbc_config              text NOT NULL,
  mint                    text NOT NULL UNIQUE,
  pool                    text NOT NULL UNIQUE,
  name                    text NOT NULL,
  ticker                  text NOT NULL,
  description             text NOT NULL DEFAULT '',
  metadata_uri            text NOT NULL,
  image_uri               text NOT NULL,
  prepared_tx             text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  risk_accepted_at        timestamptz NOT NULL,
  status                  text NOT NULL DEFAULT 'prepared'
                           CHECK (status IN ('prepared', 'submitted', 'confirmed', 'expired', 'failed')),
  signature               text UNIQUE,
  error                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  confirmed_at            timestamptz
);
CREATE INDEX factory_launches_user_idx ON factory_launches (user_id, created_at DESC);

CREATE TABLE factory_tokens (
  mint                text PRIMARY KEY,
  launch_id           uuid NOT NULL UNIQUE REFERENCES factory_launches(launch_id),
  pool                text NOT NULL UNIQUE,
  cluster             text NOT NULL,
  creator_user_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  creator_wallet      text NOT NULL,
  name                text NOT NULL,
  ticker              text NOT NULL,
  image_uri           text NOT NULL,
  metadata_uri        text NOT NULL,
  signature           text NOT NULL,
  launched_at         timestamptz NOT NULL DEFAULT now(),
  -- read model (refreshed from chain)
  price_lamports_per_token numeric,
  quote_reserve_lamports   numeric,
  base_reserve             numeric,
  progress_bps        integer,
  migrated            boolean NOT NULL DEFAULT false,
  state_refreshed_at  timestamptz,
  rug_flagged_at      timestamptz
);
CREATE UNIQUE INDEX factory_tokens_ticker_uniq ON factory_tokens (cluster, upper(ticker));
CREATE INDEX factory_tokens_creator_idx ON factory_tokens (creator_wallet);
CREATE INDEX factory_tokens_launched_idx ON factory_tokens (launched_at DESC);

CREATE TABLE factory_token_trades (
  signature        text NOT NULL,
  mint             text NOT NULL REFERENCES factory_tokens(mint) ON DELETE CASCADE,
  trader_wallet    text NOT NULL,
  side             text NOT NULL CHECK (side IN ('buy', 'sell')),
  token_amount     numeric NOT NULL,
  lamports         numeric NOT NULL,
  slot             bigint,
  at               timestamptz NOT NULL,
  PRIMARY KEY (signature, mint, trader_wallet)
);
CREATE INDEX factory_token_trades_mint_at_idx ON factory_token_trades (mint, at DESC);

CREATE TABLE factory_creator_moves (
  signature     text NOT NULL,
  mint          text NOT NULL REFERENCES factory_tokens(mint) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('sell', 'transfer_out')),
  token_amount  numeric NOT NULL,
  share_bps     integer NOT NULL,
  heat_added    integer NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signature, mint)
);

CREATE TABLE factory_metadata (
  id          text PRIMARY KEY,
  mime        text NOT NULL,
  content     bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE factory_webhook_events (
  signature   text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS factory_webhook_events;
DROP TABLE IF EXISTS factory_metadata;
DROP TABLE IF EXISTS factory_creator_moves;
DROP TABLE IF EXISTS factory_token_trades;
DROP TABLE IF EXISTS factory_tokens;
DROP TABLE IF EXISTS factory_launches;
