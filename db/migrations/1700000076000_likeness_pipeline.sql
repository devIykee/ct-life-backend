-- Durable private ingestion and per-stage generation journal. No purchase grants.
-- Up Migration
CREATE TABLE likeness_upload_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  object_key text NOT NULL UNIQUE,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('processing','ready','failed','deleting','deleted')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  lease_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  cleanup_checked_at timestamptz,
  UNIQUE(user_id,request_key)
);
CREATE UNIQUE INDEX likeness_upload_sessions_one_active_owner ON likeness_upload_sessions(user_id)
  WHERE state IN ('processing','ready');
CREATE INDEX likeness_upload_sessions_cleanup_idx ON likeness_upload_sessions (expires_at,state);

ALTER TABLE likeness_jobs
  ADD COLUMN phase text NOT NULL DEFAULT 'sources'
    CHECK (phase IN ('sources','reference_ready','reference_submitting','reference_polling',
      'awaiting_reference_approval','mesh_ready','mesh_submitting','mesh_polling',
      'prerig_ready','prerig_submitting','prerig_polling','rig_ready','rig_submitting','rig_polling',
      'awaiting_asset_validation','completed','reconciliation_required','failed','cancelled')),
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN deadline_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  ADD COLUMN source_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN poll_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN provider_face_token text,
  ADD COLUMN provider_character_token text,
  ADD COLUMN approved_reference_token text,
  ADD COLUMN reference_key text,
  ADD COLUMN reference_sha256 text,
  ADD COLUMN reference_approved_at timestamptz,
  ADD COLUMN asset_key text,
  ADD COLUMN asset_sha256 text,
  ADD COLUMN failure_reason text,
  ADD COLUMN seed integer,
  ADD COLUMN reference_revision text,
  ADD COLUMN prompt_version text,
  ADD COLUMN artifact_cleanup_at timestamptz;
CREATE INDEX likeness_jobs_work_idx ON likeness_jobs (next_run_at,lease_until)
  WHERE status IN ('queued','processing');

CREATE TABLE likeness_provider_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES likeness_jobs(id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN ('reference','mesh','prerig','rig')),
  state text NOT NULL CHECK (state IN ('reserved','submitted','succeeded','failed','ambiguous')),
  provider_task_id text,
  submitted_at timestamptz,
  completed_at timestamptz,
  reserved_at timestamptz NOT NULL,
  consumed_credits numeric,
  UNIQUE(job_id,stage),
  UNIQUE(provider_task_id)
);

CREATE TABLE likeness_action_receipts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,request_key)
);

-- Down Migration
DROP TABLE likeness_action_receipts;
DROP TABLE likeness_provider_attempts;
DROP INDEX likeness_jobs_work_idx;
ALTER TABLE likeness_jobs
  DROP COLUMN phase, DROP COLUMN lease_token, DROP COLUMN lease_until,
  DROP COLUMN next_run_at, DROP COLUMN deadline_at, DROP COLUMN source_failures,
  DROP COLUMN poll_failures, DROP COLUMN provider_face_token,
  DROP COLUMN provider_character_token, DROP COLUMN approved_reference_token,
  DROP COLUMN reference_key, DROP COLUMN reference_sha256,
  DROP COLUMN reference_approved_at, DROP COLUMN asset_key, DROP COLUMN asset_sha256,
  DROP COLUMN failure_reason, DROP COLUMN seed, DROP COLUMN reference_revision,
  DROP COLUMN prompt_version, DROP COLUMN artifact_cleanup_at;
DROP TABLE likeness_upload_sessions;
