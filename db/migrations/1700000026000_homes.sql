-- Migration: 026_homes
--
-- One per player. The lottery grants a starter home; players can
-- upgrade by POST /v1-homes. We do not enforce one-home-per-user
-- with a UNIQUE on owner_user_id because Phase 6 introduces per-
-- tribe district homes that may live under a different owner. The
-- application enforces the per-user cap for now; the index helps
-- the "my homes" query.
--
-- `kind` is one of the homes.json IDs. The CHECK enforces the
-- allowed set.
--
-- `rent_cents_per_week` is the configured rent (Parents Basement
-- $20 = 2000 cents, etc.). The home_visits worker debits this on
-- Monday 00:00 UTC.
--
-- `decorated_at` is when the home was last decorated (M5).
-- `last_rent_paid_at` is when the rent worker last successfully
-- debited rent. Missed rent (insufficient cash) increases
-- balances.debt_cents (the exit-liquidity baby semantics).
--
-- Indexes:
--   (owner_user_id) — the player's home list
--   (kind)          — the kind filter for leaderboards

-- Up Migration
CREATE TABLE homes (
  home_id                text PRIMARY KEY,
  owner_user_id          uuid NOT NULL,
  kind                   text NOT NULL CHECK (kind IN
                           ('parents_basement', 'hacker_house', 'studio',
                            'penthouse', 'marina_villa')),
  rent_cents_per_week    bigint NOT NULL CHECK (rent_cents_per_week > 0),
  decorated_at           timestamptz,
  last_rent_paid_at      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX homes_owner_idx
  ON homes (owner_user_id);

CREATE INDEX homes_kind_idx
  ON homes (kind);

-- Down Migration
DROP TABLE IF EXISTS homes;