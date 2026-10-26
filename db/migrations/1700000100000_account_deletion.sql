-- Migration: 100_account_deletion
--
-- DELETE /v1/me (App Store 5.1.1(v) / Play account-deletion policy).
--
-- The users row is ANONYMISED IN PLACE, not removed: ~20 tables reference it
-- with ON DELETE RESTRICT (ledger, payments, casino, factory, ...) and those
-- financial rows must survive. users.deleted_at marks the row; wallet becomes
-- 'deleted:<id>' so the real wallet can sign up again as a brand new account.
--
-- storage_cleanup  object keys whose bytes must be erased from S3 / the private
--                  likeness store. Written in the same transaction as the
--                  deletion, drained by the account-purge worker, so a crash
--                  between "rows gone" and "files gone" cannot leave files behind.
-- account_deletions  PII-free audit trail (id + time only).

-- Up Migration
ALTER TABLE users ADD COLUMN deleted_at timestamptz;

CREATE TABLE storage_cleanup (
  id          bigserial PRIMARY KEY,
  store       text NOT NULL CHECK (store IN ('likeness', 'ads')),
  object_key  text NOT NULL,
  queued_at   timestamptz NOT NULL DEFAULT now(),
  done_at     timestamptz,
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text,
  UNIQUE (store, object_key)
);
CREATE INDEX storage_cleanup_pending_idx ON storage_cleanup (id) WHERE done_at IS NULL;

CREATE TABLE account_deletions (
  user_id     uuid PRIMARY KEY,
  deleted_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS account_deletions;
DROP TABLE IF EXISTS storage_cleanup;
ALTER TABLE users DROP COLUMN IF EXISTS deleted_at;
