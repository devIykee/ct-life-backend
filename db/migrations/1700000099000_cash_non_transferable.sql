-- Migration: 099_cash_non_transferable
--
-- Cash is purchasable but NON-transferable: it never moves between players and never goes
-- on-chain. Heads-up casino challenges therefore become stake-free bragging rights.
--
-- casino_challenges.stake_cents may be 0 (a Cash-free challenge).
-- Every challenge still open with an escrowed stake is cancelled and the stake is returned to
-- the challenger (ledger casino_refund, the same idempotency_ref the app uses), so no Cash is
-- left held by a feature that no longer exists.
--
-- Old settled challenges keep their stake, pot, house cut and payout columns as history.

-- Up Migration
ALTER TABLE casino_challenges DROP CONSTRAINT IF EXISTS casino_challenges_stake_cents_check;
ALTER TABLE casino_challenges
  ADD CONSTRAINT casino_challenges_stake_cents_check CHECK (stake_cents >= 0);

WITH open_stakes AS (
  UPDATE casino_challenges
     SET status = 'cancelled', settled_at = now()
   WHERE status = 'open' AND stake_cents > 0
  RETURNING challenge_id, challenger_id, stake_cents
),
credited AS (
  INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
  SELECT challenger_id, stake_cents, 'cash', 'casino_refund', 'casino_challenge',
         challenge_id::text, 'casino-refund:' || challenger_id || ':' || challenge_id
    FROM open_stakes
  ON CONFLICT (idempotency_ref) DO NOTHING
  RETURNING user_id, delta_cents
)
UPDATE balances b
   SET cash_cents = b.cash_cents + c.total, updated_at = now()
  FROM (SELECT user_id, SUM(delta_cents) AS total FROM credited GROUP BY user_id) c
 WHERE b.user_id = c.user_id;

-- Down Migration
-- The refunds above are not undone (the Cash is the players'). Challenges with stake 0 would
-- violate the old CHECK, so they are removed before it is restored.
DELETE FROM casino_challenges WHERE stake_cents = 0;
ALTER TABLE casino_challenges DROP CONSTRAINT IF EXISTS casino_challenges_stake_cents_check;
ALTER TABLE casino_challenges
  ADD CONSTRAINT casino_challenges_stake_cents_check CHECK (stake_cents > 0);
