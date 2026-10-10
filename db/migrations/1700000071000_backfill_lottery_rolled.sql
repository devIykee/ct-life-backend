-- Up Migration
-- Backfill users.lottery_rolled_at, added empty by 1700000070000.
--
-- GET /me derives flags.lotteryRolled from this column, so every user
-- that existed before that migration read as "not rolled" and was sent
-- back through the birth lottery. Re-rolling then hit the UNIQUE on
-- ledger_entries.idempotency_ref ('lottery:<user_id>') and answered 500,
-- leaving the account stuck on the origin-story screen.
--
-- A user has rolled if the ledger holds their lottery payout, or if they
-- already have a character (character creation comes after the roll).
-- Prefer the ledger timestamp and fall back to the account's own
-- created_at so the column is never left null for those users.

UPDATE users u
   SET lottery_rolled_at = COALESCE(
         (SELECT MIN(le.created_at)
            FROM ledger_entries le
           WHERE le.user_id = u.id
             AND (le.ref_type = 'lottery' OR le.reason = 'lottery_payout')),
         u.created_at
       )
 WHERE u.lottery_rolled_at IS NULL
   AND (
         EXISTS (SELECT 1 FROM characters c WHERE c.user_id = u.id)
         OR EXISTS (
              SELECT 1 FROM ledger_entries le
               WHERE le.user_id = u.id
                 AND (le.ref_type = 'lottery' OR le.reason = 'lottery_payout')
            )
       );

-- Down Migration
-- Only clears what the Up filled; a user who rolls after this migration
-- keeps their timestamp.
UPDATE users u
   SET lottery_rolled_at = NULL
 WHERE u.lottery_rolled_at IS NOT NULL
   AND (
         EXISTS (SELECT 1 FROM characters c WHERE c.user_id = u.id)
         OR EXISTS (
              SELECT 1 FROM ledger_entries le
               WHERE le.user_id = u.id
                 AND (le.ref_type = 'lottery' OR le.reason = 'lottery_payout')
            )
       );
