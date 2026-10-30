-- Migration: 140_home_visitor_policy (unlock D2, capability visitorPolicy)
--
-- Who may visit a player's home: `open` (default; the door rules alone
-- decide), `followers` (only players who follow the owner, and the owner's
-- guests) or `closed` (nobody but the owner).
--
-- Kept per player, not per lease, so the choice survives a move
-- (POST /homes/move) and can be set before the player has a home. A player
-- with no row is `open`, which is how every home behaved before this table.

-- Up Migration
CREATE TABLE home_settings (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  visitors    text NOT NULL DEFAULT 'open' CHECK (visitors IN ('open', 'followers', 'closed')),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS home_settings;
