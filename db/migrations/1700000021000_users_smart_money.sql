-- Migration: 021_users_smart_money
--
-- Adds the smart-money opt-in flag (M3 #44) and a miner_tier
-- snapshot column (M3 #41) to the users table. Both default off
-- / none. The opt-in defaults to false; the miner tier is set by
-- the ORE refinery worker after the ORE board sync.
--
-- We use ALTER TABLE … ADD COLUMN with a default so the column
-- is added to existing rows without a separate backfill.

-- Up Migration
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_opted_in_smart_money boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS miner_tier text NOT NULL DEFAULT 'none'
    CHECK (miner_tier IN ('none', 'prospector', 'miner', 'refiner'));

-- Down Migration
ALTER TABLE users
  DROP COLUMN IF EXISTS miner_tier,
  DROP COLUMN IF EXISTS is_opted_in_smart_money;
