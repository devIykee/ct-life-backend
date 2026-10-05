-- Migration: 002_characters
--
-- One character per user. The alias is the in-world display name and is
-- unique. Look is the seven-slot modular avatar (skin, head, hair, top,
-- bottom, shoes, accessory) encoded as a JSONB so the client can evolve
-- the schema without a migration. Traits, tribe and dream are
-- snake_case IDs from the contract registries.
--
-- One tribe change per season is enforced by tracking tribe_changed_at
-- and an application-layer check on Sunday Unlock (M5).

-- Up Migration
CREATE TABLE characters (
  id                 uuid PRIMARY KEY,
  user_id            uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  alias              text NOT NULL UNIQUE,
  look               jsonb NOT NULL,
  tribe_id           text NOT NULL,
  trait_ids          text[] NOT NULL,
  dream_id           text NOT NULL,
  age_confirmed_at   timestamptz,
  home_id            text NOT NULL,
  tribe_changed_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS characters;
