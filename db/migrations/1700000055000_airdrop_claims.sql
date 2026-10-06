-- Migration: 055_airdrop_claims
--
-- The M7 #6 Airdrop Farm daily-claim log. One row per
-- (user_id, day_date). The claim endpoint reads the existing
-- row to enforce the daily cap; a second claim on the same day
-- is idempotent (returns the existing row's amount).
--
-- `day_date` is the UTC date the claim applies to.
-- `claim_count` is the number of times the user claimed today
-- (the daily cap is 4 by default, configurable via
-- contract/config/economy.json). CHECK > 0.
-- `amount_cents` is the per-claim Cash credit. CHECK > 0.
-- `sgt_bonus` boolean — true if the user has a verified SGT
-- (the bonus is +50% on the base amount).
--
-- UNIQUE (user_id, day_date) is the floor for the idempotent
-- claim floor; a second claim on the same day is a no-op.

-- Up Migration
CREATE TABLE airdrop_claims (
  claim_id      uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  day_date      date NOT NULL,
  claim_count   int NOT NULL DEFAULT 1 CHECK (claim_count > 0),
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  sgt_bonus     boolean NOT NULL DEFAULT false,
  claimed_at    timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, day_date)
);

CREATE INDEX airdrop_claims_user_idx
  ON airdrop_claims (user_id);

-- Down Migration
DROP TABLE IF EXISTS airdrop_claims;
