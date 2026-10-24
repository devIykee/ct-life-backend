-- Migration: 085_events_calendar
--
-- The real-world event calendar (Breakpoint, hackathons, meetups) and the
-- per-event quest chain. Independent of 084 (daily streak / quests / push).
--
-- events              — one real event. The API upserts contract/ids/
--                       calendar_events.json into it at startup; ops correct
--                       dates or the stream link with PUT /v1/admin/events/{slug}
--                       (sets admin_edited_at, after which the file no longer
--                       overwrites the row). starts_at / ends_at are UTC;
--                       the event is live while starts_at <= now < ends_at.
-- event_progress      — one row per (player, event, step, item): a booth or
--                       nod the server accepted, or a trivia question answered
--                       (ok says right or wrong; a question is answered once).
-- event_completions   — the chain is done and the reward paid. The primary key
--                       is what makes the reward happen once.
-- event_announcements — the event_live / event_ended world announcement was
--                       sent. The primary key makes the announcement once.
-- cosmetic_items.grant_only — a cosmetic that is only ever granted (event
--                       lanyard): not in the shop, not buyable.
--
-- Indexes:
--   events (starts_at)                           — current / upcoming
--   event_progress (user_id, event_id)           — the caller's chain

-- Up Migration
CREATE TABLE events (
  id               text PRIMARY KEY,
  slug             text NOT NULL UNIQUE,
  title            text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('conference', 'hackathon', 'meetup')),
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  city             text NOT NULL,
  real_venue       text NOT NULL,
  ingame_venue_id  text NOT NULL,
  skin_id          text NOT NULL,
  stream_url       text,
  source_url       text NOT NULL,
  quest_set        text NOT NULL,
  reward_cents     bigint NOT NULL DEFAULT 0 CHECK (reward_cents >= 0),
  reward_item_key  text,
  admin_edited_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX events_starts_at_idx ON events (starts_at);

CREATE TABLE event_progress (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  step        text NOT NULL,
  item_id     text NOT NULL,
  ok          boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id, step, item_id)
);

CREATE INDEX event_progress_user_event_idx ON event_progress (user_id, event_id);

CREATE TABLE event_completions (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id      text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  cash_cents    bigint NOT NULL,
  item_key      text,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_id)
);

CREATE TABLE event_announcements (
  event_id      text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('live', 'ended')),
  announced_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, kind)
);

ALTER TABLE cosmetic_items
  ADD COLUMN grant_only boolean NOT NULL DEFAULT false;

-- Down Migration
ALTER TABLE cosmetic_items DROP COLUMN IF EXISTS grant_only;
DROP TABLE IF EXISTS event_announcements;
DROP TABLE IF EXISTS event_completions;
DROP TABLE IF EXISTS event_progress;
DROP TABLE IF EXISTS events;
