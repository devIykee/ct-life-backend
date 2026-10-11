-- Owned delivery is separate from provider success and from accepting a preview.
-- Up Migration
ALTER TABLE likeness_jobs ADD COLUMN asset_manifest jsonb,
  ADD COLUMN asset_validated_at timestamptz;
CREATE TABLE likeness_selections (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES likeness_jobs(id) ON DELETE RESTRICT,
  accepted_at timestamptz NOT NULL
);
-- Operator evaluation is explicitly free; it must never masquerade as a purchase.
ALTER TABLE likeness_entitlements DROP CONSTRAINT likeness_entitlements_amount_base_units_check;
ALTER TABLE likeness_entitlements ADD CONSTRAINT likeness_entitlements_amount_base_units_check
  CHECK (amount_base_units ~ '^[1-9][0-9]*$' OR
    (amount_base_units = '0' AND payment_source = 'operator_evaluation' AND currency = 'TEST'));
ALTER TABLE likeness_entitlements ADD COLUMN credit_budget numeric NOT NULL DEFAULT 85 CHECK(credit_budget BETWEEN 0 AND 200);
ALTER TABLE likeness_provider_attempts ADD COLUMN reserved_credits numeric NOT NULL DEFAULT 0 CHECK(reserved_credits>=0);

-- Down Migration
DROP TABLE likeness_selections;
ALTER TABLE likeness_jobs DROP COLUMN asset_manifest, DROP COLUMN asset_validated_at;
ALTER TABLE likeness_entitlements DROP COLUMN credit_budget;
ALTER TABLE likeness_provider_attempts DROP COLUMN reserved_credits;
-- Keep the widened amount constraint on rollback: deleting free grants would lose audit evidence.
