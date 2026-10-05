-- Migration: 028_tips
--
-- Tips in Cash (off-chain) or on-chain (USDC, SOL, SKR, ORE).
--
-- `kind='cash'`: the row is written synchronously with a 'tip' ledger
-- row that credits the recipient's cash. `amount_cents` is set,
-- `amount_lamports` and `signature` are NULL.
--
-- `kind='onchain'`: the client posts the wallet-to-wallet
-- transfer signature. The row is written as `pending` until the
-- Helius webhook confirms the credit, then flipped to `confirmed`
-- (M4 #53 webhook path). `amount_lamports` is set, `mint` is the
-- SPL mint address (null for SOL), `signature` is UNIQUE.
--
-- A tip is one of (amount_cents > 0) OR (amount_lamports > 0).
-- The CHECK enforces the invariant at the database level; the
-- application writes the matching field.
--
-- `message` is an optional 200-char note the sender attached.
--
-- Indexes:
--   (to_user_id, created_at DESC) — recent tips to a user
--   (from_user_id, created_at DESC) — recent tips from a user

-- Up Migration
CREATE TABLE tips (
  tip_id           uuid PRIMARY KEY,
  from_user_id     uuid NOT NULL,
  to_user_id       uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('cash', 'onchain')),
  amount_cents     bigint CHECK (amount_cents IS NULL OR amount_cents > 0),
  amount_lamports  bigint CHECK (amount_lamports IS NULL OR amount_lamports > 0),
  mint             text,
  signature        text UNIQUE,
  message          text CHECK (message IS NULL OR length(message) <= 200),
  status           text NOT NULL DEFAULT 'confirmed'
                     CHECK (status IN ('pending', 'confirmed', 'failed')),
  created_at       timestamptz NOT NULL DEFAULT now(),

  -- The amount + kind invariant. For cash, amount_cents is set and
  -- amount_lamports is NULL. For onchain, amount_lamports is set
  -- and amount_cents is NULL.
  CHECK (
    (kind = 'cash' AND amount_cents IS NOT NULL AND amount_cents > 0 AND amount_lamports IS NULL)
    OR
    (kind = 'onchain' AND amount_lamports IS NOT NULL AND amount_lamports > 0 AND amount_cents IS NULL)
  )
);

CREATE INDEX tips_to_created_idx
  ON tips (to_user_id, created_at DESC);

CREATE INDEX tips_from_created_idx
  ON tips (from_user_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS tips;