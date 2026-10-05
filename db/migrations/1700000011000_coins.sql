-- Migration: 011_coins
--
-- The market-engine universe. Each row is a coin on the launchpad
-- (or graduated to the AMM). The engine is the ONLY writer of
-- `price_micros`, `mcap_cents`, `vol_5m_cents`, and `change_5m_bps`;
-- every other module reads via the engine or via this table.
--
-- `price_micros` is the current price in micros (USD per 1 coin
-- base unit, scaled by 1_000_000). 1 USDC = 1_000_000 micros.
--
-- `stage`:
--   new       — bonding curve, raised < graduateMcapCents
--   final     — virtual reserves AMM, raised >= graduateMcapCents
--   graduated — coin survived the launch (real liquidity exists)
--   dead      — rug or slow bleed completed; tombstone row exists
--
-- `hidden_arc` is the script the engine sampled on launch. It is
-- NEVER exposed to clients; only the engine and admin read it.
--   { outcome: 'rug'|'slow_bleed'|'sideways'|'moon', slopeBps,
--     drawdownBps, peakAtSec, noiseBps }
--
-- `seed` is the engine's RNG seed for this coin. The market-engine
-- test asserts the price path is deterministic for a fixed seed.
--
-- `ticker` is UNIQUE (case-insensitive). The launchpad checks the
-- uniqueness on insert; the engine never mutates the ticker.

-- Up Migration
CREATE TABLE coins (
  coin_id         uuid PRIMARY KEY,
  ticker          text NOT NULL UNIQUE,
  name            text NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('new', 'final', 'graduated', 'dead')),
  price_micros    bigint NOT NULL,
  mcap_cents      bigint NOT NULL,
  vol_5m_cents    bigint NOT NULL DEFAULT 0,
  change_5m_bps   integer NOT NULL DEFAULT 0,
  holders         integer NOT NULL DEFAULT 0,
  launched_at     timestamptz NOT NULL,
  hidden_arc      jsonb NOT NULL,
  seed            bigint NOT NULL
);

-- Down Migration
DROP TABLE IF EXISTS coins;
