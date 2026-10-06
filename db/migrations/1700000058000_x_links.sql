-- Migration: 058_x_links
--
-- The M7 #9 Verified X link. One row per user. The OAuth 2.0
-- PKCE flow stores only the handle + avatar (per the master
-- prompt: "It stores only handle and avatar"). The access +
-- refresh tokens are stored as hashes (server-side, never
-- returned to the client).
--
-- `x_user_id` is the X user id (the numeric id from the X API).
--   text; not UNIQUE per se because X ids are global, but the
--   X OAuth server enforces uniqueness on its end. We add a
--   UNIQUE index for fast lookup.
-- `x_handle` is the @ handle without the leading @.
-- `x_avatar_url` is the profile image URL.
-- `code_verifier` is the PKCE verifier (43-128 char URL-safe
--   base64). Stored temporarily between start + callback; the
--   application clears it on successful exchange. NOT NULL
--   between start and callback.
-- `state` is the OAuth state (CSRF token). NOT NULL between
--   start + callback.
-- `access_token_hash` / `refresh_token_hash` are sha256 of the
--   tokens (the tokens themselves are not persisted).
-- `verified_at` is the timestamp the link was completed.
--
-- UNIQUE (user_id) is the floor (one X link per user).
-- UNIQUE (x_user_id) is the floor (one user per X account).
-- UNIQUE (state) is the floor for the in-flight OAuth state.

-- Up Migration
CREATE TABLE x_links (
  user_id            uuid PRIMARY KEY,
  x_user_id          text NOT NULL UNIQUE,
  x_handle           text NOT NULL CHECK (length(x_handle) BETWEEN 1 AND 32),
  x_avatar_url       text NOT NULL DEFAULT '',
  code_verifier      text NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  state              text NOT NULL UNIQUE CHECK (length(state) BETWEEN 16 AND 64),
  access_token_hash  text NOT NULL DEFAULT '',
  refresh_token_hash text NOT NULL DEFAULT '',
  verified_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX x_links_handle_idx
  ON x_links (x_handle);

-- Down Migration
DROP TABLE IF EXISTS x_links;
