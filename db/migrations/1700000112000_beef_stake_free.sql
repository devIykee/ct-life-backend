-- Migration: 112_beef_stake_free (unlock A6)
--
-- CT Beef becomes stake-free (docs/ECONOMY.md: Cash never moves between
-- players). The winner gets a capped, house-paid reward instead of the
-- loser's stake. Matches gain a topic, an optional invited player, a phase
-- timer and the voting phase; spectators vote; an "arena crowd" of NPC votes
-- follows each participant's in-arena activity. Config:
-- contract/config/beef_topics.json.
--
--   stake_cents       now always 0 for new matches (CHECK relaxed to >= 0 so old
--                     staked rows stay valid). Old staked open challenges are
--                     expired here; old live ones end through the worker. Either
--                     way a player gets back only the stake the ledger shows
--                     they paid (beef_stake debits), never stake_cents blindly.
--   status            + 'voting', 'expired'; a 'closed' match may have no
--                     winner (draw)
--   topic_id          id from beef_topics.json (null on old rows)
--   invited_user_id   only this player may accept / decline (null = open)
--   phase_ends_at     when the current phase ends (open, active, voting)
--   reward_cents      the reward shown at open ("Winner earns $X")
--   reward_paid_cents what the winner was actually paid (0: draw or cap)
--   votes_*           player votes at close; crowd_* the NPC crowd split
--
-- beef_votes: one vote per voter per match.
-- beef_presence: each participant's in-arena activity during `active`
-- (written when the match moves to voting; the crowd split reads it).

-- Up Migration
ALTER TABLE beef_matches DROP CONSTRAINT IF EXISTS beef_matches_stake_cents_check;
ALTER TABLE beef_matches ADD CONSTRAINT beef_matches_stake_cents_check CHECK (stake_cents >= 0);
ALTER TABLE beef_matches DROP CONSTRAINT IF EXISTS beef_matches_status_check;
ALTER TABLE beef_matches ADD CONSTRAINT beef_matches_status_check
  CHECK (status IN ('open', 'active', 'voting', 'closed', 'declined', 'cancelled', 'expired'));
ALTER TABLE beef_matches DROP CONSTRAINT IF EXISTS beef_matches_check;

ALTER TABLE beef_matches
  ADD COLUMN topic_id text CHECK (topic_id IS NULL OR length(topic_id) BETWEEN 1 AND 64),
  ADD COLUMN invited_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN phase_ends_at timestamptz,
  ADD COLUMN reward_cents bigint NOT NULL DEFAULT 0 CHECK (reward_cents >= 0),
  ADD COLUMN reward_paid_cents bigint CHECK (reward_paid_cents IS NULL OR reward_paid_cents >= 0),
  ADD COLUMN votes_challenger int CHECK (votes_challenger IS NULL OR votes_challenger >= 0),
  ADD COLUMN votes_accepter int CHECK (votes_accepter IS NULL OR votes_accepter >= 0),
  ADD COLUMN crowd_challenger int CHECK (crowd_challenger IS NULL OR crowd_challenger >= 0),
  ADD COLUMN crowd_accepter int CHECK (crowd_accepter IS NULL OR crowd_accepter >= 0);

-- Old staked challenges that were never accepted end now: no staked match may
-- go live. Each player gets back exactly what the ledger shows they paid in for
-- that match (beef_stake debits minus any beef_stake_refund already made);
-- nothing is credited that was never debited.
CREATE TEMP TABLE beef_legacy_refunds ON COMMIT DROP AS
  SELECT l.user_id, m.match_id, (-SUM(l.delta_cents))::bigint AS owed
    FROM beef_matches m
    JOIN ledger_entries l
      ON l.ref_type = 'beef_match' AND l.ref_id = m.match_id::text
     AND l.reason IN ('beef_stake', 'beef_stake_refund')
   WHERE m.status = 'open' AND m.stake_cents > 0
   GROUP BY l.user_id, m.match_id
  HAVING -SUM(l.delta_cents) > 0;

INSERT INTO balances (user_id, cash_cents, debt_cents)
  SELECT DISTINCT user_id, 0, 0 FROM beef_legacy_refunds
  ON CONFLICT (user_id) DO NOTHING;

UPDATE balances b SET cash_cents = b.cash_cents + r.owed, updated_at = now()
  FROM (SELECT user_id, SUM(owed) AS owed FROM beef_legacy_refunds GROUP BY user_id) r
 WHERE b.user_id = r.user_id;

INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
  SELECT user_id, owed, 'cash', 'beef_stake_refund', 'beef_match', match_id::text,
         'beef-stake-refund:' || match_id::text || ':' || user_id::text
    FROM beef_legacy_refunds;

UPDATE beef_matches SET status = 'expired', settled_at = now()
 WHERE status = 'open' AND stake_cents > 0;

-- Old matches already live get a timer so the phase worker can end them; at
-- close each player is refunded only their own recorded stake debits.
UPDATE beef_matches SET phase_ends_at = now() + interval '10 minutes'
 WHERE status = 'active' AND phase_ends_at IS NULL;

CREATE INDEX beef_matches_phase_idx ON beef_matches (phase_ends_at)
  WHERE status IN ('open', 'active', 'voting');
CREATE INDEX beef_matches_invited_idx ON beef_matches (invited_user_id, opened_at DESC)
  WHERE invited_user_id IS NOT NULL;

CREATE TABLE beef_votes (
  match_id       uuid NOT NULL REFERENCES beef_matches(match_id) ON DELETE CASCADE,
  voter_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voted_user_id  uuid NOT NULL,
  at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, voter_user_id)
);

CREATE TABLE beef_presence (
  match_id      uuid NOT NULL REFERENCES beef_matches(match_id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  talk_seconds  int NOT NULL DEFAULT 0 CHECK (talk_seconds >= 0),
  emotes        int NOT NULL DEFAULT 0 CHECK (emotes >= 0),
  says          int NOT NULL DEFAULT 0 CHECK (says >= 0),
  PRIMARY KEY (match_id, user_id)
);

-- Down Migration
DROP TABLE IF EXISTS beef_presence;
DROP TABLE IF EXISTS beef_votes;
DROP INDEX IF EXISTS beef_matches_invited_idx;
DROP INDEX IF EXISTS beef_matches_phase_idx;
ALTER TABLE beef_matches
  DROP COLUMN IF EXISTS crowd_accepter,
  DROP COLUMN IF EXISTS crowd_challenger,
  DROP COLUMN IF EXISTS votes_accepter,
  DROP COLUMN IF EXISTS votes_challenger,
  DROP COLUMN IF EXISTS reward_paid_cents,
  DROP COLUMN IF EXISTS reward_cents,
  DROP COLUMN IF EXISTS phase_ends_at,
  DROP COLUMN IF EXISTS invited_user_id,
  DROP COLUMN IF EXISTS topic_id;
