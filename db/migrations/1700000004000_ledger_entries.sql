-- Migration: 004_ledger_entries
--
-- The append-only Cash ledger. Every change to balances.cash_cents or
-- balances.debt_cents is recorded here. Reconciliation:
--
--   sum(ledger_entries.delta_cents WHERE user_id = X AND account = 'cash')
--     == balances.cash_cents
--
-- Append-only is enforced by a BEFORE UPDATE OR DELETE trigger that
-- raises an exception. The id is bigserial so insertions stay compact
-- and never reuse values.
--
-- `reason` is the kind of entry: topup, shift_pay, rent, tax, tip,
-- trade_buy, trade_sell, lottery_payout, loan_disburse, loan_repay,
-- fee, drain, etc. `ref_type` + `ref_id` point at the business object
-- (trade, shift, tip, tombstone) that produced the entry.
--
-- `idempotency_ref` is a server-side dedup key for replay protection.
-- The Idempotency-Key header from the client is the only writer; the
-- middleware sets it, the UoW checks the unique index, and concurrent
-- inserts collide cleanly.
--
-- Indexes:
--   (user_id, created_at DESC)  per-user history tail-reads
--   (ref_type, ref_id)          find a ledger entry for an entity
--   (idempotency_ref) UNIQUE    replay protection
--
-- The ledger is the ONLY writer to balances. The UoW is the only
-- caller of BEGIN/COMMIT/ROLLBACK. SERIALIZABLE isolation is set in
-- the application code, not here.

-- Up Migration
CREATE TABLE ledger_entries (
  id                bigserial PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delta_cents       bigint NOT NULL,
  account           text NOT NULL CHECK (account IN ('cash', 'debt')),
  reason            text NOT NULL,
  ref_type          text,
  ref_id            text,
  idempotency_ref   text UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_user_created_idx
  ON ledger_entries (user_id, created_at DESC);

CREATE INDEX ledger_entries_ref_idx
  ON ledger_entries (ref_type, ref_id);

-- Append-only enforcement. Any UPDATE or DELETE on the table raises an
-- exception. The trigger is created as a BEFORE trigger so it sees
-- row-level intent and can short-circuit the statement.
CREATE OR REPLACE FUNCTION ledger_entries_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only; UPDATE and DELETE are forbidden (op=%, id=%)',
    TG_OP, COALESCE(OLD.id::text, NEW.id::text)
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER ledger_entries_no_update_delete
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entries_append_only();

-- Down Migration
DROP TRIGGER IF EXISTS ledger_entries_no_update_delete ON ledger_entries;
DROP FUNCTION IF EXISTS ledger_entries_append_only();
DROP TABLE IF EXISTS ledger_entries;
