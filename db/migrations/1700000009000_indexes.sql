-- Migration: 009_indexes
--
-- Composite and partial indexes that don't belong to a single table
-- migration. Kept last so earlier migrations can run independently.
--
-- This migration is idempotent (CREATE INDEX IF NOT EXISTS, DROP INDEX
-- IF EXISTS) so it can be re-run safely.

-- Up Migration

-- Blocked lookup: "is X blocked by Y?" is O(1) on the partial index.
CREATE INDEX IF NOT EXISTS blocks_blocker_blocked_idx
  ON blocks (blocker_user_id, blocked_user_id);

-- Character lookups by tribe for district control (M6).
CREATE INDEX IF NOT EXISTS characters_tribe_idx
  ON characters (tribe_id);

-- Balances updated_at helps find accounts that have not been written
-- to for a long time (the reconciliation job uses this to size its
-- work).
CREATE INDEX IF NOT EXISTS balances_updated_at_idx
  ON balances (updated_at);

-- Down Migration
DROP INDEX IF EXISTS blocks_blocker_blocked_idx;
DROP INDEX IF EXISTS characters_tribe_idx;
DROP INDEX IF EXISTS balances_updated_at_idx;
