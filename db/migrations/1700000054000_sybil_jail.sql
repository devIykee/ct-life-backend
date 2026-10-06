-- Migration: 054_sybil_jail
--
-- The M7 #6 Sybil jail flag on the users row. The admin tool
-- sets the flag (POST /v1/admin/users/{id}/sybil_jail); the
-- airdrop-farm + M7 #6 #7 venues consult the flag to refuse
-- features. UNIQUE NOT enforced at the row level (the flag
-- is per-user).
--
-- `is_sybil_jailed` defaults to false. CHECK is a sanity floor.
-- `sybil_jailed_at` is the timestamp the flag was last set;
-- null when the flag is false. CHECK (is_sybil_jailed OR
-- sybil_jailed_at IS NULL) — when jailed, the timestamp is
-- required.

-- Up Migration
ALTER TABLE users
  ADD COLUMN is_sybil_jailed boolean NOT NULL DEFAULT false
    CHECK (is_sybil_jailed IN (true, false)),
  ADD COLUMN sybil_jailed_at timestamptz,
  ADD CONSTRAINT users_sybil_jail_consistent
    CHECK (is_sybil_jailed OR sybil_jailed_at IS NULL);

-- Down Migration
ALTER TABLE users
  DROP CONSTRAINT users_sybil_jail_consistent,
  DROP COLUMN sybil_jailed_at,
  DROP COLUMN is_sybil_jailed;
