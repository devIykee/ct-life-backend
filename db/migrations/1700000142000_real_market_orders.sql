-- Migration: 142_real_market_orders (capabilities realMarkets / realMarketsJupiter)
--
-- Real Markets: real-money prediction orders the player signs with their OWN wallet on
-- Solana mainnet (docs/REAL-MARKETS.md). The server never signs or holds funds; this
-- table is a record for display (the player's order history) and anti-abuse (daily cap,
-- signature reuse) only. It holds no Cash and touches no ledger.
--
--   real_market_orders  one row per built order. Status:
--                         built      unsigned tx handed to the client
--                         submitted  the client reported a signature
--                         confirmed  the signature landed on mainnet, from the order's
--                                    wallet, invoking the built programs
--                         failed     it landed with an error, or never landed before the
--                                    blockhash expired
--                         mismatch   the signature is not this order (wrong fee payer
--                                    or programs)
--                       `provider_state` is the venue's view once the tx landed
--                       (Jupiter keepers fill later): pending | filled | failed | unknown.
--                       `country` is the ISO code the edge reported at build time (no IP
--                       is stored).

-- Up Migration
CREATE TABLE real_market_orders (
  order_id                uuid PRIMARY KEY,
  user_id                 uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet                  text NOT NULL,
  provider                text NOT NULL CHECK (provider IN ('panta', 'jupiter')),
  market_id               text NOT NULL,
  side                    text NOT NULL CHECK (side IN ('yes', 'no')),
  amount_base             bigint NOT NULL CHECK (amount_base > 0),
  est_shares              text,
  fee_usdc                text,
  provider_order_id       text,
  provider_quote_id       text,
  program_ids             text[] NOT NULL DEFAULT '{}',
  last_valid_block_height bigint,
  status                  text NOT NULL DEFAULT 'built'
                            CHECK (status IN ('built', 'submitted', 'confirmed', 'failed', 'mismatch')),
  provider_state          text CHECK (provider_state IN ('pending', 'filled', 'failed', 'unknown')),
  signature               text,
  error                   text,
  country                 text,
  risk_warning_version    text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  submitted_at            timestamptz,
  confirmed_at            timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX real_market_orders_user_created_idx
  ON real_market_orders (user_id, created_at DESC);

-- A signature belongs to at most one order (no replaying someone else's trade).
CREATE UNIQUE INDEX real_market_orders_signature_idx
  ON real_market_orders (signature) WHERE signature IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS real_market_orders;
