-- Up Migration
-- Unlock WP-B B1: Builder. Consented roles, a project treasury, launch onto the
-- in-game launchpad, events, and the weekly game-paid payroll.
--
-- projects.cash_cents stays the column name; the API calls it `treasuryCents`.
-- (Renaming it would break the running API between migrate and deploy.)
--
-- project_members replaces project_hires as the source of truth: the founder
-- plus at most one player per role. project_hires is kept (no longer written)
-- so a rollback of the code still finds its table.
--
-- project_events: server-written lifecycle and risk events (GET /projects/{id}/events).
-- project_work_log: weeks a member did a project task that is not a ledger
--   row (the HQ shift, B3). Career shifts count from the ledger directly.
-- project_payroll_runs: one row per project and week, so the weekly payroll
--   is idempotent across replicas and retries.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS coin_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS launched_at timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS paused_at timestamptz;

CREATE TABLE IF NOT EXISTS project_members (
  project_id             uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id                uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                   text NOT NULL
                           CHECK (role IN ('founder', 'dev', 'mod', 'kol', 'auditor')),
  salary_cents_per_week  bigint NOT NULL DEFAULT 0 CHECK (salary_cents_per_week >= 0),
  offer_id               uuid,
  joined_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id),
  UNIQUE (project_id, role)
);

CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members (user_id);

-- Founders of existing projects (projects.owner_user_id has no FK, so only
-- owners that still exist).
INSERT INTO project_members (project_id, user_id, role, salary_cents_per_week, joined_at)
SELECT p.project_id, p.owner_user_id, 'founder', 0, p.created_at
  FROM projects p
  JOIN users u ON u.id = p.owner_user_id
ON CONFLICT DO NOTHING;

-- Existing direct hires become members: one per role, the earliest wins.
INSERT INTO project_members (project_id, user_id, role, salary_cents_per_week, joined_at)
SELECT DISTINCT ON (h.project_id, h.role)
       h.project_id, h.user_id, h.role, h.salary_cents_per_week, h.hired_at
  FROM project_hires h
  JOIN users u ON u.id = h.user_id
 ORDER BY h.project_id, h.role, h.hired_at
ON CONFLICT DO NOTHING;

-- One pending offer per (project, invitee).
CREATE UNIQUE INDEX IF NOT EXISTS project_offers_one_pending_idx
  ON project_offers (project_id, to_user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS project_events (
  id                uuid PRIMARY KEY,
  project_id        uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  event_id          text NOT NULL,
  cash_delta_cents  bigint NOT NULL DEFAULT 0,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key        text UNIQUE,
  at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_events_project_at_idx
  ON project_events (project_id, at DESC, id DESC);

CREATE TABLE IF NOT EXISTS project_work_log (
  project_id  uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  source      text NOT NULL CHECK (source IN ('hq_shift', 'project_task')),
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id, week_start)
);

CREATE TABLE IF NOT EXISTS project_payroll_runs (
  project_id            uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  week_start            date NOT NULL,
  wages_cents           bigint NOT NULL,
  operating_cost_cents  bigint NOT NULL,
  paid                  boolean NOT NULL,
  at                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, week_start)
);

-- Down Migration
DROP TABLE IF EXISTS project_payroll_runs;
DROP TABLE IF EXISTS project_work_log;
DROP TABLE IF EXISTS project_events;
DROP INDEX IF EXISTS project_offers_one_pending_idx;
DROP TABLE IF EXISTS project_members;
ALTER TABLE projects DROP COLUMN IF EXISTS paused_at;
ALTER TABLE projects DROP COLUMN IF EXISTS launched_at;
ALTER TABLE projects DROP COLUMN IF EXISTS coin_id;
