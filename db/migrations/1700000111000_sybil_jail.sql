-- Migration: 111_sybil_jail (unlock A5)
--
-- Game-rolled Sybil jail. Farming the Airdrop Fields too greedily (too many
-- claim attempts in an hour, thresholds in contract/config/sybil_reasons.json)
-- can put a player in the Sybil Barn for a few hours. They wait it out or pay
-- bail in Cash (a sink: the Cash leaves the economy, it never goes to another
-- player).
--
-- One row per stay. A stay is active while `released_at IS NULL AND
-- release_at > now()`; release is lazy (read time), so no worker is needed and
-- an expired row simply stops counting. `released_at` is only written on bail.
--
-- The admin jail for real multi-accounting stays on users.is_sybil_jailed
-- (admin routes) and is never bailable; it does not use this table.
--
--   reason_id         id from sybil_reasons.json
--   release_at        when the stay ends on its own
--   bail_cents_per_hour  bail per started hour still to serve (snapshot of the
--                     player's farm yield at jail time)
--   released_at       set when bail is paid
--   bail_paid_cents   what was paid (null unless bailed)

-- Up Migration
CREATE TABLE sybil_jail (
  jail_id              uuid PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason_id            text NOT NULL CHECK (length(reason_id) BETWEEN 1 AND 64),
  jailed_at            timestamptz NOT NULL DEFAULT now(),
  release_at           timestamptz NOT NULL,
  bail_cents_per_hour  bigint NOT NULL CHECK (bail_cents_per_hour > 0),
  released_at          timestamptz,
  bail_paid_cents      bigint CHECK (bail_paid_cents IS NULL OR bail_paid_cents > 0),
  CHECK (release_at > jailed_at)
);

-- At most one open stay per player (an expired one is closed lazily, so the
-- partial index covers rows not yet bailed; the service checks release_at).
CREATE INDEX sybil_jail_user_open_idx ON sybil_jail (user_id, release_at DESC)
  WHERE released_at IS NULL;

-- The Barn board: who is inside right now.
CREATE INDEX sybil_jail_open_release_idx ON sybil_jail (release_at)
  WHERE released_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS sybil_jail;
