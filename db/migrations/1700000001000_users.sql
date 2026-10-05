-- Migration: 001_users
--
-- Creates the core `users` table. The server generates every user ID as a
-- UUIDv7. The wallet is the base58 Solana public key and is the natural
-- identity. A Seeker Genesis Token may be linked to at most one account;
-- this is enforced at the application layer by the SGT check in auth
-- (server/shared/auth/seeker.ts) and a UNIQUE partial index on sgt_mint.

-- Up Migration
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id          uuid PRIMARY KEY,
  wallet      text NOT NULL UNIQUE,
  is_seeker   boolean NOT NULL DEFAULT false,
  sgt_mint    text,
  skr_name    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- At most one user per Seeker Genesis Token mint. NULL mint means the
-- user has not linked an SGT, which is the common case. The UNIQUE
-- partial index enforces the "one phone, one account" rule.
CREATE UNIQUE INDEX users_sgt_mint_unique
  ON users (sgt_mint)
  WHERE sgt_mint IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS users;
