-- Up Migration
-- Phase 5 project role offers, VC deals, and the project name/ticker the
-- spec adds to POST /v1/projects.
--
-- project_hires records an immediate hire with no offer step, so
-- GET /v1/me/project-offers had nothing to read and the route did not
-- exist. project_offers is the pending/accepted/declined flow the client
-- shows on the home screen. vc_deals backs the VC Row board.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ticker text;

-- Existing rows predate the column; name them after their kind so the
-- boards never render a blank card.
UPDATE projects SET name = initcap(replace(kind, '_', ' ')) WHERE name IS NULL;

CREATE TABLE IF NOT EXISTS project_offers (
  offer_id               uuid PRIMARY KEY,
  project_id             uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  from_user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                   text NOT NULL CHECK (role IN ('dev', 'mod', 'kol', 'auditor')),
  salary_cents_per_week  bigint NOT NULL CHECK (salary_cents_per_week > 0),
  status                 text NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'withdrawn')),
  expires_at             timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_offers_to_user_idx
  ON project_offers (to_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS project_offers_project_idx
  ON project_offers (project_id);

CREATE TABLE IF NOT EXISTS vc_deals (
  deal_id          uuid PRIMARY KEY,
  project_id       uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  vc_archetype_id  text NOT NULL,
  invest_cents     bigint NOT NULL CHECK (invest_cents > 0),
  equity_bps       int NOT NULL CHECK (equity_bps BETWEEN 1 AND 10000),
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'exited', 'written_off')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vc_deals_created_idx
  ON vc_deals (created_at DESC);

-- Down Migration
DROP TABLE IF EXISTS vc_deals;
DROP TABLE IF EXISTS project_offers;
ALTER TABLE projects DROP COLUMN IF EXISTS ticker;
ALTER TABLE projects DROP COLUMN IF EXISTS name;
