-- Migration: 101_moderation
--
-- Admin review of reports and the sanctions a moderator can apply.
--
-- user_moderation   one row per sanctioned player: a mute (cannot send DMs, post to
--                   the feed or talk in rooms until muted_until) and/or a ban (no
--                   tokens are issued; live ones are cut by a Redis flag).
-- moderation_actions  append-only audit log of every action an admin took.
-- reports.action / resolution_note / status  how a report was closed.
-- reports_open_dedupe_idx  one open report per (reporter, target): reporting the
--                   same thing twice is a no-op, not a second row.

-- Up Migration
CREATE TABLE user_moderation (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  muted_until  timestamptz,
  banned_at    timestamptz,
  reason       text,
  set_by       uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE moderation_actions (
  id               bigserial PRIMARY KEY,
  admin_user_id    uuid NOT NULL,
  action           text NOT NULL CHECK (action IN
                     ('dismiss', 'remove_content', 'mute', 'unmute', 'ban', 'unban')),
  target_user_id   uuid,
  report_id        bigint,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_target_idx ON moderation_actions (target_user_id, created_at DESC);

ALTER TABLE reports
  ADD COLUMN action text CHECK (action IN ('dismiss', 'remove_content', 'mute', 'ban')),
  ADD COLUMN resolution_note text;

-- Old duplicates would block the unique index; keep the oldest open one.
DELETE FROM reports r USING reports d
 WHERE r.resolved_at IS NULL AND d.resolved_at IS NULL
   AND r.reporter_user_id = d.reporter_user_id
   AND r.target_type = d.target_type AND r.target_id = d.target_id
   AND r.report_id > d.report_id;
CREATE UNIQUE INDEX reports_open_dedupe_idx
  ON reports (reporter_user_id, target_type, target_id) WHERE resolved_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS reports_open_dedupe_idx;
ALTER TABLE reports DROP COLUMN IF EXISTS resolution_note, DROP COLUMN IF EXISTS action;
DROP TABLE IF EXISTS moderation_actions;
DROP TABLE IF EXISTS user_moderation;
