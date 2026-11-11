-- Explicit credential revocation and primary Solana enrolment; no payment ownership changes.
-- Up Migration
ALTER TABLE login_identities ADD COLUMN revoked_at timestamptz;
ALTER TABLE login_identities ADD COLUMN session_version integer NOT NULL DEFAULT 0 CHECK(session_version>=0);
ALTER TABLE login_identities ADD CONSTRAINT login_identities_owner_key UNIQUE(id,user_id);

-- Pre-cutover authenticated proofs lack an initiating credential; retire, never upgrade them.
UPDATE login_identity_challenges SET consumed_at=COALESCE(consumed_at,now()) WHERE purpose='enrolment';
ALTER TABLE login_identity_challenges ADD COLUMN initiator_identity_id uuid;
ALTER TABLE login_identity_challenges ADD COLUMN initiator_session_version integer CHECK(initiator_session_version>=0);
ALTER TABLE login_identity_challenges ADD CONSTRAINT login_challenge_initiator_owner
 FOREIGN KEY(initiator_identity_id,user_id) REFERENCES login_identities(id,user_id) ON DELETE CASCADE;
ALTER TABLE login_identity_challenges DROP CONSTRAINT login_identity_challenges_purpose_check;
ALTER TABLE login_identity_challenges DROP CONSTRAINT login_identity_challenges_network_check;
ALTER TABLE login_identity_challenges DROP CONSTRAINT login_identity_challenges_check;
ALTER TABLE login_identity_challenges ADD CONSTRAINT login_challenge_scope CHECK(
 (purpose='login' AND user_id IS NULL AND network IN ('eip155:4663','near:mainnet')) OR
 (purpose='enrolment' AND user_id IS NOT NULL AND network IN ('eip155:4663','near:mainnet')) OR
 (purpose='primary-solana-enrolment' AND user_id IS NOT NULL AND network='solana:mainnet'));
ALTER TABLE login_identity_challenges ADD CONSTRAINT login_challenge_initiator CHECK(
 (purpose='login' AND initiator_identity_id IS NULL AND initiator_session_version IS NULL) OR
 (purpose<>'login' AND (consumed_at IS NOT NULL OR (initiator_identity_id IS NOT NULL AND initiator_session_version IS NOT NULL))));

CREATE TABLE account_access_events (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 identity_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('identity_revoked','identity_reactivated','primary_solana_enrolled')),
 network text NOT NULL CHECK(network IN ('solana:mainnet','eip155:4663','near:mainnet')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_access_events_user_created ON account_access_events(user_id,created_at DESC,id DESC);

-- Down Migration
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM login_identities WHERE revoked_at IS NOT NULL OR session_version<>0)
   OR EXISTS(SELECT 1 FROM account_access_events) THEN
   RAISE EXCEPTION 'Cannot roll back used account-access lifecycle state';
 END IF;
END $$;
DROP TABLE account_access_events;
DELETE FROM login_identity_challenges WHERE purpose='primary-solana-enrolment';
ALTER TABLE login_identity_challenges DROP CONSTRAINT login_challenge_scope;
ALTER TABLE login_identity_challenges DROP CONSTRAINT login_challenge_initiator;
ALTER TABLE login_identity_challenges DROP CONSTRAINT login_challenge_initiator_owner;
ALTER TABLE login_identity_challenges DROP COLUMN initiator_identity_id;
ALTER TABLE login_identity_challenges DROP COLUMN initiator_session_version;
ALTER TABLE login_identity_challenges ADD CONSTRAINT login_identity_challenges_purpose_check CHECK(purpose IN ('login','enrolment'));
ALTER TABLE login_identity_challenges ADD CONSTRAINT login_identity_challenges_network_check CHECK(network IN ('eip155:4663','near:mainnet'));
ALTER TABLE login_identity_challenges ADD CONSTRAINT login_identity_challenges_check CHECK((purpose='login' AND user_id IS NULL) OR (purpose='enrolment' AND user_id IS NOT NULL));
ALTER TABLE login_identities DROP CONSTRAINT login_identities_owner_key;
ALTER TABLE login_identities DROP COLUMN revoked_at;
ALTER TABLE login_identities DROP COLUMN session_version;
