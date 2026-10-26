-- Migration: 097_onboarding
--
-- First-session onboarding and the starter quests.
--
-- onboarding_meta   one row: `epoch`, the moment this migration ran. An account created
--                   before it is an old account: its first session reads as done and it gets
--                   no starter quests. An account created at or after it is new.
-- onboarding_state  one row per NEW account, created the first time the account touches
--                   onboarding (lottery roll, character create, GET /me, GET /quests).
--                   first_session: active | skipped | done. beats: the beats reached
--                   (origin, character, home, moved, shift, trade, quest, chest).
--                   starter_seeded_at: when the starter quests were seeded; seeded once.
-- starter_quests    the starter quests a player was given. Their progress lives in
--                   quest_progress with period_key 'starter' and pool 'starter', so claims,
--                   Season XP and the ledger (quest_reward) are the existing ones.
--
-- quest_progress.pool allows 'starter'.

-- Up Migration
CREATE TABLE onboarding_meta (
  epoch timestamptz NOT NULL
);
INSERT INTO onboarding_meta (epoch) VALUES (now());

CREATE TABLE onboarding_state (
  user_id            uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  first_session      text NOT NULL DEFAULT 'active'
                     CHECK (first_session IN ('active', 'skipped', 'done')),
  started_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  beats              text[] NOT NULL DEFAULT '{}',
  starter_seeded_at  timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE starter_quests (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  quest_id   text NOT NULL,
  seeded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, quest_id)
);

ALTER TABLE quest_progress DROP CONSTRAINT IF EXISTS quest_progress_pool_check;
ALTER TABLE quest_progress
  ADD CONSTRAINT quest_progress_pool_check CHECK (pool IN ('daily', 'weekly', 'starter'));

-- Down Migration
DELETE FROM quest_progress WHERE pool = 'starter';
ALTER TABLE quest_progress DROP CONSTRAINT IF EXISTS quest_progress_pool_check;
ALTER TABLE quest_progress
  ADD CONSTRAINT quest_progress_pool_check CHECK (pool IN ('daily', 'weekly'));
DROP TABLE IF EXISTS starter_quests;
DROP TABLE IF EXISTS onboarding_state;
DROP TABLE IF EXISTS onboarding_meta;
