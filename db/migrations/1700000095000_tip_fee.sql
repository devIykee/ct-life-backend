-- Migration: 095_tip_fee
--
-- A burned fee on Cash tips (default 3%, env TIP_FEE_BPS). The sender pays the
-- full amount; the recipient is credited amount - fee; the fee leaves the
-- economy (nobody is credited) and is recorded as its own ledger row on the
-- sender with reason 'tip_fee_burn', so the sender's ledger still adds up and the
-- burn is auditable (SELECT sum(-delta_cents) FROM ledger_entries WHERE reason = 'tip_fee_burn').
--
-- tips.fee_cents  the fee taken from this tip, stored so a later change of the
--                 rate does not rewrite history. Old tips have 0. The
--                 recipient's share is amount_cents - fee_cents.
--
-- ledger_entries.reason is free text (no CHECK), so no enum change is needed.

-- Up Migration
ALTER TABLE tips
  ADD COLUMN fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0);

-- Down Migration
ALTER TABLE tips DROP COLUMN IF EXISTS fee_cents;
