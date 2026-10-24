-- Migration: 087_season_tracks_nods
--
-- Season Pass tracks (free + paid) and the community-nods collection.
--
-- season_xp          append-only Season XP awards. SAME SHAPE as the table in
--                    migration 084 (PR #9, daily streak + quests), created here
--                    with IF NOT EXISTS so this migration works on main alone
--                    and in either merge order. Quests write source 'quest',
--                    nod finds write source 'nod'; (user_id, source, ref) keeps
--                    an award from landing twice. A player's XP in a season is
--                    the sum of the rows created inside [startsAt, endsAt).
-- season_tier_claims one row per (player, season, track, tier): the claim
--                    record. The primary key is what makes a claim pay once.
-- collected_nods     one row per (player, nod): a nod counts once.
-- nod_set_grants     one row per (player, set): a completed set pays once.
--
-- Indexes:
--   season_xp (user_id, season_iso)              — 084's index, same name
--   season_xp (user_id, created_at)              — the season-window sum
--   collected_nods (nod_id)                      — per-nod counts
--   collected_nods (collected_at)                — the Hunter board tie-break

-- Up Migration
CREATE TABLE IF NOT EXISTS season_xp (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount      integer NOT NULL CHECK (amount > 0),
  source      text NOT NULL,
  ref         text NOT NULL,
  season_iso  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, ref)
);

CREATE INDEX IF NOT EXISTS season_xp_user_season_idx ON season_xp (user_id, season_iso);
CREATE INDEX IF NOT EXISTS season_xp_user_created_idx ON season_xp (user_id, created_at);

CREATE TABLE season_tier_claims (
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id    text NOT NULL,
  track        text NOT NULL CHECK (track IN ('free', 'paid')),
  tier         integer NOT NULL CHECK (tier >= 1),
  reward_kind  text NOT NULL CHECK (reward_kind IN ('cash', 'cosmetic', 'furniture')),
  reward_ref   text NOT NULL,
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, season_id, track, tier)
);

CREATE TABLE collected_nods (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nod_id        text NOT NULL,
  collected_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, nod_id)
);

CREATE INDEX collected_nods_nod_idx ON collected_nods (nod_id);
CREATE INDEX collected_nods_at_idx ON collected_nods (collected_at);

CREATE TABLE nod_set_grants (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id      text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, set_id)
);

-- Down Migration
DROP TABLE IF EXISTS nod_set_grants;
DROP TABLE IF EXISTS collected_nods;
DROP TABLE IF EXISTS season_tier_claims;
-- season_xp is left in place: it may belong to migration 084.
DROP INDEX IF EXISTS season_xp_user_created_idx;
