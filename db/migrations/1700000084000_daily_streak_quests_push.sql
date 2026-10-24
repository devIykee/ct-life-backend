-- Migration: 084_daily_streak_quests_push
--
-- Retention layer: gm streak + daily chest, daily/weekly quests, Season XP,
-- and the bookkeeping for real push delivery.
--
-- login_streaks    one row per player: current streak, the UTC date of the last
--                  claim, and the streak freezes held (0..2, enforced here).
-- daily_claims     one row per (player, UTC date): the replay record that makes
--                  POST /v1/daily/claim idempotent per day, with what was paid.
-- quest_events     one row per server event that may advance a quest. The
--                  (user_id, verb, ref) key makes every source event count once,
--                  however often a hook fires.
-- quest_progress   progress per (player, period, quest). `period_key` is the UTC
--                  date for daily quests and the ISO week for weekly ones.
--                  `claimed_at` is set once, in the same transaction as the pay.
-- season_xp        append-only Season XP awards. The Season tracks (R4) read the
--                  sum; (user_id, source, ref) keeps an award from landing twice.
-- push_prefs       per-player quiet hours (local hours via a UTC offset) and the
--                  notification types the player turned off.
-- push_log         every push the server decided to send, for the daily cap and
--                  for de-duplication (user_id, dedupe_key).

-- Up Migration
CREATE TABLE login_streaks (
  user_id          uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  streak_day       integer NOT NULL DEFAULT 0 CHECK (streak_day >= 0),
  best_streak      integer NOT NULL DEFAULT 0 CHECK (best_streak >= 0),
  last_claim_date  date,
  freezes          integer NOT NULL DEFAULT 0 CHECK (freezes BETWEEN 0 AND 2),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX login_streaks_last_claim_idx ON login_streaks (last_claim_date)
  WHERE streak_day > 0;

CREATE TABLE daily_claims (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_date      date NOT NULL,
  streak_day    integer NOT NULL CHECK (streak_day >= 1),
  cash_cents    bigint NOT NULL CHECK (cash_cents >= 0),
  item_key      text,
  freezes_used  integer NOT NULL DEFAULT 0 CHECK (freezes_used >= 0),
  was_reset     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day_date)
);

CREATE TABLE quest_events (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verb        text NOT NULL,
  ref         text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, verb, ref)
);

CREATE TABLE quest_progress (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key    text NOT NULL,
  quest_id      text NOT NULL,
  pool          text NOT NULL CHECK (pool IN ('daily', 'weekly')),
  progress      integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  completed_at  timestamptz,
  claimed_at    timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_key, quest_id)
);

CREATE TABLE season_xp (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      integer NOT NULL CHECK (amount > 0),
  source      text NOT NULL,
  ref         text NOT NULL,
  season_iso  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, ref)
);

CREATE INDEX season_xp_user_season_idx ON season_xp (user_id, season_iso);

CREATE TABLE push_prefs (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quiet_enabled      boolean NOT NULL DEFAULT true,
  quiet_start_hour   smallint NOT NULL DEFAULT 22 CHECK (quiet_start_hour BETWEEN 0 AND 23),
  quiet_end_hour     smallint NOT NULL DEFAULT 8 CHECK (quiet_end_hour BETWEEN 0 AND 23),
  tz_offset_min      smallint NOT NULL DEFAULT 0 CHECK (tz_offset_min BETWEEN -840 AND 840),
  disabled_types     text[] NOT NULL DEFAULT '{}',
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_log (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  dedupe_key  text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);

CREATE INDEX push_log_user_created_idx ON push_log (user_id, created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS push_log;
DROP TABLE IF EXISTS push_prefs;
DROP TABLE IF EXISTS season_xp;
DROP TABLE IF EXISTS quest_progress;
DROP TABLE IF EXISTS quest_events;
DROP TABLE IF EXISTS daily_claims;
DROP TABLE IF EXISTS login_streaks;
