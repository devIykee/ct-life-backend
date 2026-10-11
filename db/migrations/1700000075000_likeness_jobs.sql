-- Dedicated verified purchases and private uploads; neither a connected wallet
-- nor a generic cash top-up is proof of a likeness purchase. No public grant API.
-- Up Migration
CREATE TABLE likeness_entitlements (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  product_id text NOT NULL CHECK (product_id = 'likeness_3d_v1'),
  payment_source text NOT NULL,
  payment_reference text NOT NULL,
  amount_base_units text NOT NULL CHECK (amount_base_units ~ '^[1-9][0-9]*$'),
  currency text NOT NULL,
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  UNIQUE (payment_source, payment_reference),
  UNIQUE (id, user_id)
);

-- Only the future private upload validator may populate this table. It must
-- decode/re-encode the image, strip metadata, and enforce deletion/retention.
CREATE TABLE likeness_uploads (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  object_key text NOT NULL UNIQUE,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  deleted_at timestamptz,
  UNIQUE (id, user_id)
);

CREATE TABLE likeness_jobs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  entitlement_id uuid NOT NULL UNIQUE,
  upload_id uuid NOT NULL,
  model_id text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('human', 'stylized')),
  provider text NOT NULL,
  consent_version text NOT NULL,
  consent_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'succeeded', 'failed', 'cancelled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, idempotency_key),
  FOREIGN KEY (entitlement_id, user_id) REFERENCES likeness_entitlements (id, user_id),
  FOREIGN KEY (upload_id, user_id) REFERENCES likeness_uploads (id, user_id)
);
CREATE INDEX likeness_jobs_owner_created_idx ON likeness_jobs (user_id, created_at DESC);

-- Down Migration
DROP TABLE likeness_jobs;
DROP TABLE likeness_uploads;
DROP TABLE likeness_entitlements;
