-- Up Migration
-- Businesses follow the contract catalog (contract/config/businesses.json):
-- kols_agency, audit_firm, memecoin_lab, lounge. A business is bought for
-- the catalog `costCents`, earns one payout per `payoutPeriodHours` (rolled
-- against the bad-day table), and the owner collects or sells it back.
--
-- businesses
--   kind CHECK dropped: the kind is a catalog id, validated by the service
--   against businesses.json, so adding a business is a config change.
--   Rows with the old kinds (lemonade_stand ... arcade) are left as they are.
--   rent_cents_per_week may be 0: catalog businesses have no weekly rent.
--   cost_cents       - price paid; the sell-back refund is a share of it.
--   accrued_until    - end of the last collected payout period. Pending
--                      payouts are the whole periods after it.
--
-- business_days
--   One row per collected payout period. period_index (0 = the first
--   period after purchase) replaces the one-row-per-date rule, so a
--   period shorter than a day cannot collide. reason_id is the bad-day
--   reason from businesses.json `badDays` (NULL on a normal day).

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_kind_check;
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_rent_cents_per_week_check;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_rent_cents_per_week_check CHECK (rent_cents_per_week >= 0);
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS cost_cents bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  ADD COLUMN IF NOT EXISTS accrued_until timestamptz;
UPDATE businesses SET accrued_until = created_at WHERE accrued_until IS NULL;
ALTER TABLE businesses ALTER COLUMN accrued_until SET DEFAULT now();
ALTER TABLE businesses ALTER COLUMN accrued_until SET NOT NULL;

ALTER TABLE business_days DROP CONSTRAINT IF EXISTS business_days_business_id_day_date_key;
ALTER TABLE business_days
  ADD COLUMN IF NOT EXISTS period_index integer CHECK (period_index >= 0),
  ADD COLUMN IF NOT EXISTS reason_id text;
CREATE UNIQUE INDEX IF NOT EXISTS business_days_business_period_uidx
  ON business_days (business_id, period_index);

-- Down Migration
DROP INDEX IF EXISTS business_days_business_period_uidx;
ALTER TABLE business_days DROP COLUMN IF EXISTS reason_id;
ALTER TABLE business_days DROP COLUMN IF EXISTS period_index;
ALTER TABLE business_days
  ADD CONSTRAINT business_days_business_id_day_date_key UNIQUE (business_id, day_date);
ALTER TABLE businesses DROP COLUMN IF EXISTS accrued_until;
ALTER TABLE businesses DROP COLUMN IF EXISTS cost_cents;
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_rent_cents_per_week_check;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_rent_cents_per_week_check CHECK (rent_cents_per_week > 0);
ALTER TABLE businesses
  ADD CONSTRAINT businesses_kind_check
  CHECK (kind IN ('lemonade_stand', 'laundromat', 'cafe', 'shop', 'arcade'));
