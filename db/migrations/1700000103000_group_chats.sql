-- Migration: 103_group_chats
--
-- Group chats and alpha groups inside Messages (board groupchats-22,
-- approved 2026-10-26: free + invite-only, caps 12/50/200, booths,
-- no-reward invite links, voice later). See docs/GROUPS.md.
--
-- groups           kind friends | alpha | tribe. Friends and alpha groups are
--                  created by a player (the owner); a tribe chat is one per
--                  tribe, owned by nobody, joined automatically. member_cap
--                  is fixed at creation from the kind. No entry fee: Cash is
--                  non-transferable, groups are free and invite-only.
--                  slow_mode {topic: seconds} per topic; hidden_at set when
--                  enough distinct players report the group (server-side).
-- group_members    role owner | mod | member; muted_until (no banners);
--                  last_read_at for unread counts.
-- group_bans       removed players cannot rejoin by invite.
-- group_invites    a shareable code (link) or a direct invite to one player
--                  (invitee_user_id). Joining by invite never pays anyone.
-- group_messages   topic chat | calls | wins. Calls (alpha groups, owner
--                  only) are cards over an alpha_calls row, graded by the
--                  existing evaluator; wins are cards over a position with
--                  realized PnL; both checked by the server, never claimed.
-- group_reports    one per reporter per group.
-- venue_booths     an alpha group's booth in Cabal Lounge or door in Discord
--                  Heights; one group per booth, one booth per group.

-- Up Migration
CREATE TABLE groups (
  group_id       uuid PRIMARY KEY,
  kind           text NOT NULL CHECK (kind IN ('friends', 'alpha', 'tribe')),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  tribe_id       text UNIQUE,
  member_cap     integer NOT NULL CHECK (member_cap BETWEEN 2 AND 1000),
  rules          text NOT NULL DEFAULT '' CHECK (length(rules) <= 500),
  slow_mode      jsonb NOT NULL DEFAULT '{}'::jsonb,
  hidden_at      timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'tribe') = (tribe_id IS NOT NULL))
);
CREATE INDEX groups_owner_idx ON groups (owner_user_id) WHERE owner_user_id IS NOT NULL;

CREATE TABLE group_members (
  group_id      uuid NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'mod', 'member')),
  joined_at     timestamptz NOT NULL DEFAULT now(),
  muted_until   timestamptz,
  last_read_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_idx ON group_members (user_id);

CREATE TABLE group_bans (
  group_id    uuid NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE group_invites (
  code             text PRIMARY KEY CHECK (code ~ '^[A-Za-z0-9]{10}$'),
  group_id         uuid NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  max_uses         integer NOT NULL DEFAULT 1 CHECK (max_uses BETWEEN 1 AND 1000),
  uses             integer NOT NULL DEFAULT 0 CHECK (uses >= 0),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX group_invites_invitee_idx ON group_invites (invitee_user_id, created_at DESC)
  WHERE invitee_user_id IS NOT NULL AND revoked_at IS NULL;
CREATE INDEX group_invites_group_idx ON group_invites (group_id);

CREATE TABLE group_messages (
  message_id      uuid PRIMARY KEY,
  group_id        uuid NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  topic           text NOT NULL CHECK (topic IN ('chat', 'calls', 'wins')),
  author_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            text NOT NULL DEFAULT '' CHECK (length(text) <= 500),
  card            jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  CHECK (length(text) > 0 OR card IS NOT NULL)
);
CREATE INDEX group_messages_thread_idx ON group_messages (group_id, topic, created_at DESC);
CREATE INDEX group_messages_author_idx ON group_messages (group_id, author_user_id, topic, created_at DESC);

CREATE TABLE group_reports (
  group_id          uuid NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
  reporter_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason_id         text NOT NULL,
  note              text CHECK (length(note) <= 500),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, reporter_user_id)
);

CREATE TABLE venue_booths (
  venue_id    text NOT NULL,
  booth_id    text NOT NULL,
  group_id    uuid NOT NULL UNIQUE REFERENCES groups(group_id) ON DELETE CASCADE,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, booth_id)
);

-- Down Migration
DROP TABLE IF EXISTS venue_booths;
DROP TABLE IF EXISTS group_reports;
DROP TABLE IF EXISTS group_messages;
DROP TABLE IF EXISTS group_invites;
DROP TABLE IF EXISTS group_bans;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
