-- Migration: 052_beef_matches
--
-- The M7 #5 CT Beef in the Ratio Arena. A match is a 1:1 duel
-- with a Cash stake on each side. The challenger opens the match
-- and posts their stake; the accepter joins and posts the same
-- stake. The match is settled by the admin (or a future
-- result-passing path); the winner takes both stakes minus a
-- 5% protocol fee. Elo updates per the standard formula with
-- K=32.
--
-- `status` is 'open' (challenger posted, waiting for accepter),
-- 'active' (both posted, in progress), 'closed' (settled with
-- a winner), 'declined' (challenger cancelled before accept),
-- or 'cancelled' (challenger cancelled after accept; both
-- stakes refunded). The CHECK keeps the enum honest.
--
-- `winner_user_id` is nullable until settlement; CHECK NULL
-- when status != 'closed', NOT NULL when status = 'closed'.
--
-- `stake_cents` is the per-side stake; CHECK > 0. Both sides
-- post the same amount.
--
-- `elo_challenger_pre`, `elo_accepter_pre`, `elo_challenger_post`,
-- `elo_accepter_post` are int4 (standard Elo range is 0..3000).
-- pre values are captured at accept; post values are written
-- at settlement. CHECK 0..3000 is the Elo floor/ceiling.
--
-- `opened_at`, `accepted_at`, `settled_at` are timestamptz.
-- accepted_at is null until the accepter joins; settled_at is
-- null until settlement.
--
-- Index:
--   (status, opened_at DESC) — the open-match hot path.
--   (challenger_user_id, opened_at DESC) — the challenger's
--     match history.
--   (accepter_user_id, opened_at DESC) — the accepter's
--     match history.

-- Up Migration
CREATE TABLE beef_matches (
  match_id              uuid PRIMARY KEY,
  challenger_user_id    uuid NOT NULL,
  accepter_user_id      uuid,
  stake_cents           bigint NOT NULL CHECK (stake_cents > 0),
  status                text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'active', 'closed', 'declined', 'cancelled')),
  winner_user_id        uuid,
  elo_challenger_pre    int CHECK (elo_challenger_pre IS NULL OR elo_challenger_pre BETWEEN 0 AND 3000),
  elo_accepter_pre      int CHECK (elo_accepter_pre IS NULL OR elo_accepter_pre BETWEEN 0 AND 3000),
  elo_challenger_post   int CHECK (elo_challenger_post IS NULL OR elo_challenger_post BETWEEN 0 AND 3000),
  elo_accepter_post     int CHECK (elo_accepter_post IS NULL OR elo_accepter_post BETWEEN 0 AND 3000),
  opened_at             timestamptz NOT NULL DEFAULT now(),
  accepted_at           timestamptz,
  settled_at            timestamptz,

  CHECK (
    (status = 'closed' AND winner_user_id IS NOT NULL)
    OR (status != 'closed')
  )
);

CREATE INDEX beef_matches_status_opened_idx
  ON beef_matches (status, opened_at DESC);

CREATE INDEX beef_matches_challenger_idx
  ON beef_matches (challenger_user_id, opened_at DESC);

CREATE INDEX beef_matches_accepter_idx
  ON beef_matches (accepter_user_id, opened_at DESC);

-- Down Migration
DROP TABLE IF EXISTS beef_matches;
