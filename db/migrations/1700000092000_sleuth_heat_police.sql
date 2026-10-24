-- Migration: 092_sleuth_heat_police
--
-- Sleuth heat, carjacking and police pursuit (parody; game Cash only).
--
--   heat_pursuits   one row per player: the current or last police pursuit. The server
--                   referee (worker) decides caught / escaped from the position hash and
--                   timers; the client never decides an outcome by itself.
--   player_jail     one row per player: the current or last stay in CT Jail
--                   (Compliance Jail venue, id `ct_jail`), with the bail in Cash cents.
--
-- Heat itself lives in player_heat / player_heat_events (migration 089). Bail is a
-- Cash sink in ledger_entries (reason `police_bail`); nothing here is withdrawable.

-- Up Migration
CREATE TABLE heat_pursuits (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pursuit_id     uuid NOT NULL,
  status         text NOT NULL CHECK (status IN ('active', 'caught', 'escaped')),
  units          integer NOT NULL CHECK (units BETWEEN 1 AND 4),
  heat_at_start  double precision NOT NULL,
  started_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  -- Last wanted position: where the player was when the pursuit began (island metres).
  anchor_x       double precision,
  anchor_z       double precision,
  -- Since when the player has continuously been farther than the escape radius.
  away_since     timestamptz,
  ended_at       timestamptz,
  end_reason     text
);

CREATE INDEX heat_pursuits_active_idx ON heat_pursuits (expires_at) WHERE status = 'active';

CREATE TABLE player_jail (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  jail_id        uuid NOT NULL,
  jailed_at      timestamptz NOT NULL,
  jailed_until   timestamptz NOT NULL,
  bail_cents     bigint NOT NULL CHECK (bail_cents >= 0),
  heat_at_arrest double precision NOT NULL,
  released_at    timestamptz,
  release_reason text CHECK (release_reason IN ('bail', 'timer'))
);

CREATE INDEX player_jail_active_idx ON player_jail (jailed_until) WHERE released_at IS NULL;

-- The Sleuth "busted" post (kind 'sleuth', meta.event 'busted') rate limit reads by subject.
CREATE INDEX feed_posts_busted_user_idx
  ON feed_posts ((meta ->> 'subjectUserId'), created_at DESC)
  WHERE kind = 'sleuth';

-- Down Migration
DROP INDEX IF EXISTS feed_posts_busted_user_idx;
DROP TABLE IF EXISTS player_jail;
DROP TABLE IF EXISTS heat_pursuits;
