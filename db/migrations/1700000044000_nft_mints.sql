-- Migration: 044_nft_mints
--
-- The M5 cosmetic NFT flow. One row per mint; the
-- nft-mint service inserts the row after the M3 Helius
-- webhook confirms the on-chain transaction.
--
-- `item_id` is the cosmetic_items.item_id; the chain
-- metadata (name, image) lives off-chain at the Metaplex
-- Core asset URI.
--
-- `mint_address` is the SPL mint pubkey for the Core
-- asset. UNIQUE so a reorg / replay cannot insert the
-- same mint twice.
--
-- `signature` is the Solana transaction signature that
-- created the asset. UNIQUE for the same reason.
--
-- `network` is 'devnet' or 'mainnet'. The CHECK keeps
-- the application honest about which cluster the
-- mint landed on; cosmetic mints default to devnet
-- per the build-spec, with the mainnet path behind
-- RUN_MAINNET_TESTS=1.
--
-- `minted_at` is set by the application; the worker
-- backfills when the webhook arrives late.

-- Up Migration
CREATE TABLE nft_mints (
  mint_id        uuid PRIMARY KEY,
  user_id        uuid NOT NULL,
  item_id        text NOT NULL,
  mint_address   text NOT NULL UNIQUE,
  signature      text NOT NULL UNIQUE,
  network        text NOT NULL CHECK (network IN ('devnet', 'mainnet')),
  minted_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX nft_mints_user_idx
  ON nft_mints (user_id);

-- Down Migration
DROP TABLE IF EXISTS nft_mints;
