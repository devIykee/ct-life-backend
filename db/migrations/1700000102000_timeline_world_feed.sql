-- Migration: 102_timeline_world_feed
--
-- The Timeline as the city's front page (board timeline-36, approved
-- 2026-10-26: three tabs, server event cards, NPC callers, opt-in
-- check-ins). See docs/TIMELINE.md.
--
-- feed_posts.district_slug  the tribe district (districts.slug: a home turf,
--                           marina_villa or cabal_lounge) the author was in
--                           when they posted, from the server's position
--                           hash, never from the client. The district
--                           rollover worker already counted posts per
--                           district by this column, which did not exist, so
--                           the worker failed every day.
-- feed_posts.kind           new kinds: 'launch', 'rug', 'liquidation',
--                           'casino_win' (city event cards, author = the
--                           city system user), 'caller' (NPC caller posts),
--                           'checkin' (a player's opt-in "is at <venue>").
--                           Existing: NULL/'player', 'sleuth', 'career'.
-- feed_posts.event_key      dedup key for city event cards (one card per
--                           coin launch, per rug, per liquidation bucket).
-- npc_authors               display names and bios of non-player authors
--                           (the city, the Sleuth, the NPC callers), so the
--                           feed shows a name and an NPC badge without a
--                           characters row. All are original parody
--                           characters; no real person's name or likeness.

-- Up Migration
ALTER TABLE feed_posts
  ADD COLUMN district_slug text,
  ADD COLUMN event_key text;

CREATE UNIQUE INDEX feed_posts_event_key_uniq ON feed_posts (event_key) WHERE event_key IS NOT NULL;

-- City tab and For-you event lane: newest event cards, optionally by kind.
CREATE INDEX feed_posts_kind_created_idx ON feed_posts (kind, created_at DESC);
CREATE INDEX feed_posts_city_created_idx ON feed_posts (created_at DESC)
  WHERE kind IN ('launch', 'rug', 'liquidation', 'casino_win');
-- For-you social lane: everything that is not a city event card.
CREATE INDEX feed_posts_social_created_idx ON feed_posts (created_at DESC)
  WHERE kind IS NULL OR kind NOT IN ('launch', 'rug', 'liquidation', 'casino_win');
-- District rollover: posts per district per day.
CREATE INDEX feed_posts_district_created_idx ON feed_posts (district_slug, created_at)
  WHERE district_slug IS NOT NULL;

-- Holders per coin (launch cards, and the Pulse board's per-coin holder count,
-- which the market room runs every 2 s) had no index on coin_id.
CREATE INDEX positions_coin_live_idx ON positions (coin_id) WHERE units > 0;

CREATE TABLE npc_authors (
  user_id       uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slug          text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  bio           text NOT NULL DEFAULT '',
  role          text NOT NULL CHECK (role IN ('city', 'sleuth', 'caller'))
);

INSERT INTO users (id, wallet)
VALUES ('00000000-0000-4000-8000-00000000c17e', 'npc:city')
ON CONFLICT (id) DO NOTHING;
INSERT INTO users (id, wallet) VALUES
  ('00000000-0000-4000-8000-0000000ca101', 'npc:caller:candle_carla'),
  ('00000000-0000-4000-8000-0000000ca102', 'npc:caller:rugwatch_ray'),
  ('00000000-0000-4000-8000-0000000ca103', 'npc:caller:moonboy_milo'),
  ('00000000-0000-4000-8000-0000000ca104', 'npc:caller:auntie_ape')
ON CONFLICT (id) DO NOTHING;

INSERT INTO npc_authors (user_id, slug, display_name, bio, role) VALUES
  ('00000000-0000-4000-8000-00000000c17e', 'city', 'CT City', 'What just happened on the island.', 'city'),
  ('00000000-0000-4000-8000-0000000051e7', 'sleuth', 'The Sleuth', 'Reads the chain so you do not have to.', 'sleuth'),
  ('00000000-0000-4000-8000-0000000ca101', 'candle_carla', 'Candle Carla', 'Draws lines on charts. Some of them work.', 'caller'),
  ('00000000-0000-4000-8000-0000000ca102', 'rugwatch_ray', 'Rugwatch Ray', 'Paranoid, usually early, sometimes right.', 'caller'),
  ('00000000-0000-4000-8000-0000000ca103', 'moonboy_milo', 'Moonboy Milo', 'Every coin is going to the moon. Every single one.', 'caller'),
  ('00000000-0000-4000-8000-0000000ca104', 'auntie_ape', 'Auntie Ape', 'Apes first, reads the docs never. Loves you.', 'caller')
ON CONFLICT (user_id) DO NOTHING;

-- Down Migration
DELETE FROM npc_authors;
DROP TABLE IF EXISTS npc_authors;
DROP INDEX IF EXISTS positions_coin_live_idx;
DROP INDEX IF EXISTS feed_posts_district_created_idx;
DROP INDEX IF EXISTS feed_posts_social_created_idx;
DROP INDEX IF EXISTS feed_posts_city_created_idx;
DROP INDEX IF EXISTS feed_posts_kind_created_idx;
DROP INDEX IF EXISTS feed_posts_event_key_uniq;
ALTER TABLE feed_posts DROP COLUMN IF EXISTS event_key, DROP COLUMN IF EXISTS district_slug;
