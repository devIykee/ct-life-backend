-- Migration: 006_skills
--
-- Per-user skills (clout, coding, trading, writing, design, security).
-- Each is a 1-10 smallint. Trading drives the leverage cap; Security
-- drives the risk hint on the Terminal Café market detail. Skills rise
-- from shift XP and gigs.

-- Up Migration
CREATE TABLE skills (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  clout       smallint NOT NULL DEFAULT 1 CHECK (clout BETWEEN 1 AND 10),
  coding      smallint NOT NULL DEFAULT 1 CHECK (coding BETWEEN 1 AND 10),
  trading     smallint NOT NULL DEFAULT 1 CHECK (trading BETWEEN 1 AND 10),
  writing     smallint NOT NULL DEFAULT 1 CHECK (writing BETWEEN 1 AND 10),
  design      smallint NOT NULL DEFAULT 1 CHECK (design BETWEEN 1 AND 10),
  security    smallint NOT NULL DEFAULT 1 CHECK (security BETWEEN 1 AND 10),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS skills;
