-- Migration: 056_cabal_invites
--
-- The M7 #7 Cabal Lounge invite. The Cabal is invite-only; a
-- host user (typically a Marina resident) issues a single-use
-- invite code that the guest redeems via POST
-- /v1/cabal/invites/{id}/accept. The invite row's `used_at`
-- is set on accept; UNIQUE (code) is the floor; the
-- `expires_at` is enforced by the application.
--
-- `host_user_id` is the user who issued the invite. Required.
-- `guest_user_id` is the user who accepted (set on accept).
--   Nullable until accept.
-- `code` is the public code; UNIQUE; format: a 32-char URL-safe
--   base64 string.
-- `used_at` is null until accept.
-- `expires_at` is the soft expiry (default 7 days from issue).
-- `created_at` is set on insert.

-- Up Migration
CREATE TABLE cabal_invites (
  invite_id      uuid PRIMARY KEY,
  host_user_id   uuid NOT NULL,
  guest_user_id  uuid,
  code           text NOT NULL UNIQUE
                 CHECK (length(code) BETWEEN 16 AND 64),
  used_at        timestamptz,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (guest_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX cabal_invites_host_idx
  ON cabal_invites (host_user_id);

CREATE INDEX cabal_invites_guest_idx
  ON cabal_invites (guest_user_id);

-- Down Migration
DROP TABLE IF EXISTS cabal_invites;
