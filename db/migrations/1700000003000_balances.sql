-- Migration: 003_balances
--
-- Per-user cash and debt cached for fast reads. Source of truth is the
-- append-only `ledger_entries` table. Reconciliation:
--
--   balances.cash_cents == sum(ledger_entries.delta_cents
--                              WHERE user_id = X AND account = 'cash')
--
-- The balances row is created the first time money is credited; the
-- ledger is the only writer that mutates it. The `UPDATE` in the ledger
-- UoW always sets the new value to the prior value plus delta and is
-- guarded by a CHECK that cash_cents >= 0.
--
-- debt_cents is the amount the player owes. It rises on the loan at
-- lottery roll (insider/exit-liquidity baby) and falls on weekly
-- repayments.

-- Up Migration
CREATE TABLE balances (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash_cents   bigint NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  debt_cents   bigint NOT NULL DEFAULT 0 CHECK (debt_cents >= 0),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS balances;
