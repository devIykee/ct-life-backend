-- Migration: 113_sybil_jail_one_open (unlock A5 follow-up, review L8)
--
-- Two claims sent at the same moment could both roll a jail and insert two
-- stays; bail released only one, so the player stayed jailed and paid twice.
-- The service now inserts under the user row lock and closes timed-out stays
-- first; this index makes "one open stay per player" a database guarantee.
--
-- Before indexing: close stays whose timer already ran out (released_at =
-- release_at; release is lazy, so they were never closed) and, if a player has
-- more than one still active, keep the one that ends last.

-- Up Migration
UPDATE sybil_jail SET released_at = release_at
 WHERE released_at IS NULL AND release_at <= now();

UPDATE sybil_jail j SET released_at = now()
 WHERE j.released_at IS NULL
   AND EXISTS (
     SELECT 1 FROM sybil_jail k
      WHERE k.user_id = j.user_id AND k.released_at IS NULL AND k.jail_id <> j.jail_id
        AND (k.release_at, k.jail_id) > (j.release_at, j.jail_id)
   );

CREATE UNIQUE INDEX sybil_jail_one_open_idx ON sybil_jail (user_id) WHERE released_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS sybil_jail_one_open_idx;
