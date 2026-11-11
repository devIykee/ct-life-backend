-- Up Migration

-- Intentionally no cascading FK: issued media credentials outlive account deletion.
CREATE TABLE media_access_grants (
  room_name text NOT NULL CHECK (length(room_name) BETWEEN 1 AND 200),
  media_identity text NOT NULL CHECK (length(media_identity) BETWEEN 79 AND 88),
  user_id uuid NOT NULL,
  login_identity_id uuid NOT NULL,
  credential_version integer NOT NULL CHECK (credential_version >= 0),
  issued_expires_at timestamptz NOT NULL,
  retain_until timestamptz NOT NULL,
  last_seen_at timestamptz,
  cutoff_succeeded_at timestamptz,
  next_check_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT media_access_grants_identity_scope_check CHECK (media_identity = 'ct1:' || user_id::text || ':' || login_identity_id::text || ':' || credential_version::text),
  PRIMARY KEY (room_name, media_identity)
);
CREATE INDEX media_access_grants_credential_idx ON media_access_grants(login_identity_id, credential_version);
CREATE INDEX media_access_grants_due_idx ON media_access_grants(next_check_at);

-- Down Migration

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM media_access_grants) THEN
    RAISE EXCEPTION 'Cannot remove media revocation obligations while grants exist';
  END IF;
END $$;
DROP TABLE media_access_grants;
