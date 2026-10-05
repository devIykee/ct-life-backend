-- Migration: 043_project_hires
--
-- Player hires into a project. UNIQUE (project_id, user_id)
-- means a user can hold at most one role per project; the
-- application rejects a duplicate insert with a 409.
--
-- `role` is the four-role system from the build-spec:
--   dev    - the engineer who writes the contract
--   mod    - the community moderator
--   kol    - the influencer who shills the project
--   auditor - the security reviewer
--
-- `salary_cents_per_week` is the weekly Cash salary. The
-- projects worker debits this from the project owner's
-- `balances.cash_cents` every Monday 00:00 UTC via a
-- 'project_payroll' ledger row. CHECK > 0 is the floor.
--
-- `hired_at` is informational; the M5 weekly worker uses
-- `now()` and does not backfill missed weeks.
--
-- Indexes:
--   (project_id, user_id) UNIQUE — primary access pattern
--   (user_id)                   — the player's hires list

-- Up Migration
CREATE TABLE project_hires (
  hire_id                   uuid PRIMARY KEY,
  project_id                uuid NOT NULL REFERENCES projects(project_id),
  user_id                   uuid NOT NULL,
  role                      text NOT NULL
                             CHECK (role IN ('dev', 'mod', 'kol', 'auditor')),
  salary_cents_per_week     bigint NOT NULL CHECK (salary_cents_per_week > 0),
  hired_at                  timestamptz NOT NULL DEFAULT now(),

  UNIQUE (project_id, user_id)
);

CREATE INDEX project_hires_user_idx
  ON project_hires (user_id);

-- Down Migration
DROP TABLE IF EXISTS project_hires;
