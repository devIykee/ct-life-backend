-- Migration: 033_season_pass
--
-- One row per user that holds (or held) a season pass. UNIQUE
-- user_id means a user can hold at most one active row at a
-- time; the application overwrites by updating `tier`,
-- `expires_at`, and `price_paid_cents`.
--
-- `tier='free'` is the default state for every user (the row is
-- lazily inserted on first GET /v1/season-pass/me call). The
-- `tier='season'` rows are created on POST /v1/season-pass/buy.
--
-- `price_paid_cents` is the amount the user actually paid
-- (typically 500 cents = $5 for a season pass). The Cash
-- equivalent is a topup ledger row that lands before the pass
-- row is inserted; we do not move real USDC at M5 dev path
-- (recorded in UNVERIFIED.md).
--
-- `expires_at` is the pass expiry (Sunday 23:59:59 UTC of the
-- last week in the season). The M5 dev path sets 90 days; the
-- production code reads from contract/config/season.json.

-- Up Migration
CREATE TABLE season_pass (
  pass_id            uuid PRIMARY KEY,
  user_id            uuid NOT NULL UNIQUE,
  tier               text NOT NULL CHECK (tier IN ('free', 'season')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  price_paid_cents   bigint NOT NULL DEFAULT 0 CHECK (price_paid_cents >= 0),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS season_pass;
