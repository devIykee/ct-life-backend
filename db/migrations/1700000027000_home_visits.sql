-- Migration: 027_home_visits
--
-- Append-only log of visits. Every visit is a row; there is no
-- UPDATE. The visit UUIDv7 is the primary key.
--
-- The visit log powers the "recent visitors" list on the home room
-- (M5 UI; M4 stores the rows).
--
-- `visited_at` defaults to now(). The application may backdate it
-- for batch inserts; for live writes we accept the default.
--
-- Indexes:
--   (home_id, visited_at DESC) — recent visitors tail
--   (visitor_user_id, visited_at DESC) — "where I went" list

-- Up Migration
CREATE TABLE home_visits (
  visit_id         uuid PRIMARY KEY,
  home_id          text NOT NULL REFERENCES homes(home_id) ON DELETE CASCADE,
  visitor_user_id  uuid NOT NULL,
  visited_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX home_visits_home_visited_idx
  ON home_visits (home_id, visited_at DESC);

CREATE INDEX home_visits_visitor_visited_idx
  ON home_visits (visitor_user_id, visited_at DESC);

-- Down Migration
DROP TABLE IF EXISTS home_visits;