-- Migration: 110_cabal_invite_revoke (unlock A3)
--
-- A host can revoke a pending Cabal Lounge invite
-- (POST /v1/cabal/invites/{id}/revoke). `revoked_at` is set once and never
-- cleared; a revoked invite can no longer be accepted and no longer counts
-- against the host's outstanding-invite cap.
--
-- Targeted invites (POST /v1/cabal/invites {guestUserId}) reuse the existing
-- `guest_user_id` column: it is now set at creation for a targeted invite and
-- only that player can accept it. The partial index serves the guest's
-- "invites for me" list and the duplicate-pending check.

-- Up Migration
ALTER TABLE cabal_invites ADD COLUMN revoked_at timestamptz;

CREATE INDEX cabal_invites_guest_pending_idx
  ON cabal_invites (guest_user_id, host_user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS cabal_invites_guest_pending_idx;
ALTER TABLE cabal_invites DROP COLUMN IF EXISTS revoked_at;
