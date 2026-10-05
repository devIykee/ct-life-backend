-- Migration: 038_gig_runs
--
-- Audit trail of every gig the player ran. The five side gigs
-- (food delivery, data entry, dog walking, ad clicks, social
-- media moderation) live in contract/config/gigs.json; the
-- formula runs server-side, never on the client.
--
-- `gig_id` is the BE-owned string ID (e.g. 'food_delivery').
-- We use text rather than a UUID because the catalog is small
-- and FE-friendly.
--
-- `pay_cents` is the Cash credit. The corresponding ledger
-- row is 'gig_pay'.
--
-- `outcome_id` is the formula's chosen outcome (e.g.
-- 'small_tip', 'big_tip', 'no_tip' for food delivery). Used
-- for debugging and for the daily-clue rotation.
--
-- `started_at` and `ended_at` bracket the run; gigs have a
-- short duration (30s - 2m) and the application uses the
-- span to throttle per-user frequency.
--
-- Index:
--   (user_id) — the player's gig history

-- Up Migration
CREATE TABLE gig_runs (
  run_id        uuid PRIMARY KEY,
  user_id       uuid NOT NULL,
  gig_id        text NOT NULL,
  pay_cents     bigint NOT NULL CHECK (pay_cents >= 0),
  outcome_id    text NOT NULL,
  started_at    timestamptz NOT NULL,
  ended_at      timestamptz NOT NULL CHECK (ended_at >= started_at)
);

CREATE INDEX gig_runs_user_idx
  ON gig_runs (user_id);

-- Down Migration
DROP TABLE IF EXISTS gig_runs;
