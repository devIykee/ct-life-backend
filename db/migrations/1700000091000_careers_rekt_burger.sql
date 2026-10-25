-- Migration: 091_careers_rekt_burger
--
-- Career ladders (Builder, Trader, Caller, Farmer, Founder) layered on the
-- existing job/shift system, and the "Rekt Burger" fallback job.
--
-- ladder_membership   one row per player: the ladder they are on now. `auto`
--                     is true when the server enrolled them (first shift on a
--                     job of the ladder); an auto enrolment has no switch
--                     cooldown, so the first deliberate choice is free.
-- ladder_progress     XP and rank per (player, ladder). Switching away keeps
--                     it; only the ladder you are on pays out perks.
-- ladder_xp_events    append-only XP awards. (user_id, source, ref) is unique,
--                     so a replayed hook can never pay XP twice. The daily cap
--                     on action XP is a sum over this table.
-- rekt_burger_state   one row per player who has the job: how it unlocked, and
--                     the current employment stint (for the Timeline posts).
-- rekt_burger_shifts  server-held shifts. The pay is computed from the
--                     validated order timings at finish, never from the client.
--
-- Indexes:
--   ladder_xp_events (user_id, created_at)     daily-cap sum
--   rekt_burger_shifts (user_id, finished_at)  daily pay-cap sum
--   rekt_burger_shifts (user_id) WHERE open    one open shift per player

-- Up Migration
CREATE TABLE ladder_membership (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ladder_id    text NOT NULL,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  auto         boolean NOT NULL DEFAULT false
);

CREATE TABLE ladder_progress (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ladder_id   text NOT NULL,
  xp          integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  rank        integer NOT NULL DEFAULT 1 CHECK (rank >= 1),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, ladder_id)
);

CREATE TABLE ladder_xp_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ladder_id   text NOT NULL,
  source      text NOT NULL,
  ref         text NOT NULL,
  amount      integer NOT NULL CHECK (amount > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, ref)
);
CREATE INDEX ladder_xp_events_user_created_idx ON ladder_xp_events (user_id, created_at);

CREATE TABLE rekt_burger_state (
  user_id               uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  unlock_reason         text NOT NULL CHECK (unlock_reason IN ('trencher', 'broke', 'liquidated')),
  unlocked_at           timestamptz NOT NULL DEFAULT now(),
  employed              boolean NOT NULL DEFAULT false,
  stint_started_at      timestamptz,
  stint_networth_cents  bigint,
  stint_shifts          integer NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rekt_burger_shifts (
  shift_id      uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('open', 'done', 'expired')),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz,
  orders        integer,
  correct       integer,
  pay_cents     bigint CHECK (pay_cents IS NULL OR pay_cents >= 0)
);
CREATE INDEX rekt_burger_shifts_user_finished_idx ON rekt_burger_shifts (user_id, finished_at);
CREATE UNIQUE INDEX rekt_burger_shifts_one_open_idx ON rekt_burger_shifts (user_id) WHERE status = 'open';

-- Down Migration
DROP TABLE IF EXISTS rekt_burger_shifts;
DROP TABLE IF EXISTS rekt_burger_state;
DROP TABLE IF EXISTS ladder_xp_events;
DROP TABLE IF EXISTS ladder_progress;
DROP TABLE IF EXISTS ladder_membership;
