-- Migration: 086_casino
--
-- The Rug Room: a Cash-only, play-money casino (18+). Games: slots, crash,
-- coinflip against the house, and head-to-head coinflip.
--
-- Ledger reasons added (no schema change, the column is free text):
--   casino_stake   debit when a stake is placed or escrowed
--   casino_win     credit of a payout
--   casino_refund  credit when an escrowed stake is returned
--
-- casino_players     — one row per player who has touched the casino. Holds
--                      the self-exclusion. It is also the row every casino
--                      action locks (FOR UPDATE), so a player's bets are
--                      serialized and the daily caps cannot be raced.
-- casino_rounds      — one row per round per player: the audit log.
--                      `seed_hash` is published when the round opens. `seed`
--                      is stored from the start (the server needs it to find
--                      the crash point of an open round) but the API returns
--                      it only once the round has settled. Open rows exist
--                      only for crash (a round not cashed out of yet).
-- casino_challenges  — head-to-head coinflip. The challenger's stake is
--                      escrowed (ledger debit) at creation; the opponent
--                      accepts within 120 s or the stake is refunded.
--
-- Indexes:
--   casino_rounds (user_id, created_at DESC)  — "my rounds", session length
--   casino_rounds one open crash round per player (partial unique)
--   ledger_entries (user_id) WHERE reason is a casino kind — rich-list weighting
--   casino_challenges (opponent_id, status), (challenger_id, status)
--   casino_challenges (expires_at) WHERE open — the expiry sweep
--
-- Merge order: independent of 084 (daily streak) and 085 (events calendar).
-- If it is merged after them, node-pg-migrate may need --no-check-order.

-- Up Migration
-- The rich-list boards sum a player's casino ledger rows (boards.ts applies
-- the anti-grinding weight); this partial index keeps that cheap.
CREATE INDEX ledger_entries_casino_idx
  ON ledger_entries (user_id)
  WHERE reason IN ('casino_stake', 'casino_win', 'casino_refund');

CREATE TABLE casino_players (
  user_id              uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  self_excluded_until  timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE casino_challenges (
  challenge_id    uuid PRIMARY KEY,
  challenger_id   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  opponent_id     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stake_cents     bigint NOT NULL CHECK (stake_cents > 0),
  challenger_side text NOT NULL CHECK (challenger_side IN ('heads', 'tails')),
  status          text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'settled', 'expired', 'cancelled', 'declined')),
  seed            text NOT NULL,
  seed_hash       text NOT NULL,
  result          text CHECK (result IN ('heads', 'tails')),
  winner_id       uuid REFERENCES users(id) ON DELETE RESTRICT,
  pot_cents       bigint,
  house_cut_cents bigint,
  payout_cents    bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  settled_at      timestamptz,
  CHECK (challenger_id <> opponent_id)
);

CREATE INDEX casino_challenges_opponent_idx
  ON casino_challenges (opponent_id, status);
CREATE INDEX casino_challenges_challenger_idx
  ON casino_challenges (challenger_id, status);
CREATE INDEX casino_challenges_open_expiry_idx
  ON casino_challenges (expires_at) WHERE status = 'open';

CREATE TABLE casino_rounds (
  round_id      uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  game          text NOT NULL CHECK (game IN ('slots', 'crash', 'coinflip', 'coinflip_h2h')),
  status        text NOT NULL CHECK (status IN ('open', 'settled')),
  stake_cents   bigint NOT NULL CHECK (stake_cents > 0),
  payout_cents  bigint CHECK (payout_cents >= 0),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome       jsonb,
  seed_hash     text NOT NULL,
  seed          text,
  challenge_id  uuid REFERENCES casino_challenges(challenge_id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  CHECK ((status = 'open') = (payout_cents IS NULL))
);

CREATE INDEX casino_rounds_user_created_idx
  ON casino_rounds (user_id, created_at DESC);
CREATE UNIQUE INDEX casino_rounds_one_open_crash_idx
  ON casino_rounds (user_id) WHERE game = 'crash' AND status = 'open';
CREATE INDEX casino_rounds_open_idx
  ON casino_rounds (created_at) WHERE status = 'open';

-- Down Migration
DROP INDEX IF EXISTS ledger_entries_casino_idx;
DROP TABLE IF EXISTS casino_rounds;
DROP TABLE IF EXISTS casino_challenges;
DROP TABLE IF EXISTS casino_players;
