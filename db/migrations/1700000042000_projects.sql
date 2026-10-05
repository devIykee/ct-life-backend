-- Migration: 042_projects
--
-- Player-founded projects in Builder Hills. The state machine:
--
--   founded  ->  launching  ->  live  ->  paused  ->  rugged
--                            ↘ rugged
--
-- The transitions are server-driven:
--   founded  -> launching  : POST /v1/projects/{id}/launch
--   launching -> live      : the M3 launchpad flow (M3 #42)
--   live -> paused         : the projects worker flips this
--                            when the weekly payroll cannot
--                            debits the owner's cash
--   paused -> live         : POST /v1/projects/{id}/resume
--                            (out of M5 scope; reserved column)
--   any -> rugged          : the projects worker, when the
--                            launchpad outcome was a rug
--
-- `kind` is the project type. The CHECK matches the M3 launchpad
-- input set; the production path narrows it per the build-spec.
--
-- `cash_cents` is the cash the project has raised from the
-- owner. The seed (debit) is the owner's first deposit; later
-- deposits are out of M5 scope. The M5 #65 endpoint inserts
-- a 'project_seed' ledger row alongside the row insert.
--
-- Index:
--   (owner_user_id) — the player's project list

-- Up Migration
CREATE TABLE projects (
  project_id        uuid PRIMARY KEY,
  owner_user_id     uuid NOT NULL,
  kind              text NOT NULL
                     CHECK (kind IN ('memecoin', 'dex', 'nft_studio', 'perps_venue', 'l2')),
  status            text NOT NULL DEFAULT 'founded'
                     CHECK (status IN ('founded', 'launching', 'live', 'paused', 'rugged')),
  cash_cents        bigint NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX projects_owner_idx
  ON projects (owner_user_id);

-- Down Migration
DROP TABLE IF EXISTS projects;
