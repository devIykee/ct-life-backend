-- Up Migration
-- Unlock WP-B B2: VC Row. NPC term sheets for live projects, accepted deals
-- with an unlock date, and the dump at unlock.
--
-- vc_offers: a VC NPC's offer of treasury Cash for equity (pending ->
--   accepted | declined | expired). The money is an NPC faucet into the
--   project TREASURY (never to a player; the treasury only feeds sinks).
-- vc_deals (migration 072, never written until now) gains the offer, the
--   unlock time and the dump time; status adds `unlocked` and `dumped`.

CREATE TABLE IF NOT EXISTS vc_offers (
  offer_id         uuid PRIMARY KEY,
  project_id       uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  vc_archetype_id  text NOT NULL,
  invest_cents     bigint NOT NULL CHECK (invest_cents > 0),
  equity_bps       int NOT NULL CHECK (equity_bps BETWEEN 1 AND 10000),
  unlock_days      int NOT NULL CHECK (unlock_days > 0),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vc_offers_project_idx ON vc_offers (project_id, created_at DESC);

-- At most one open term sheet per project.
CREATE UNIQUE INDEX IF NOT EXISTS vc_offers_one_pending_idx
  ON vc_offers (project_id) WHERE status = 'pending';

ALTER TABLE vc_deals ADD COLUMN IF NOT EXISTS offer_id uuid;
ALTER TABLE vc_deals ADD COLUMN IF NOT EXISTS unlock_at timestamptz;
ALTER TABLE vc_deals ADD COLUMN IF NOT EXISTS dumped_at timestamptz;
-- Anti front-running (security review H2): the dump starts at a hidden random
-- time after unlock and bleeds in small steps; none of this is ever sent.
ALTER TABLE vc_deals ADD COLUMN IF NOT EXISTS dump_start_at timestamptz;
ALTER TABLE vc_deals ADD COLUMN IF NOT EXISTS dump_shock_bps int NOT NULL DEFAULT 0;
ALTER TABLE vc_deals ADD COLUMN IF NOT EXISTS dump_steps int NOT NULL DEFAULT 0;
ALTER TABLE vc_deals ADD COLUMN IF NOT EXISTS dump_steps_done int NOT NULL DEFAULT 0;
ALTER TABLE vc_deals DROP CONSTRAINT IF EXISTS vc_deals_status_check;
ALTER TABLE vc_deals ADD CONSTRAINT vc_deals_status_check
  CHECK (status IN ('active', 'unlocked', 'dumped', 'exited', 'written_off'));

CREATE INDEX IF NOT EXISTS vc_deals_unlock_idx ON vc_deals (unlock_at) WHERE status IN ('active', 'unlocked');

-- Down Migration
DROP INDEX IF EXISTS vc_deals_unlock_idx;
UPDATE vc_deals SET status = 'exited' WHERE status IN ('unlocked', 'dumped');
ALTER TABLE vc_deals DROP CONSTRAINT IF EXISTS vc_deals_status_check;
ALTER TABLE vc_deals ADD CONSTRAINT vc_deals_status_check
  CHECK (status IN ('active', 'exited', 'written_off'));
ALTER TABLE vc_deals DROP COLUMN IF EXISTS dump_steps_done;
ALTER TABLE vc_deals DROP COLUMN IF EXISTS dump_steps;
ALTER TABLE vc_deals DROP COLUMN IF EXISTS dump_shock_bps;
ALTER TABLE vc_deals DROP COLUMN IF EXISTS dump_start_at;
ALTER TABLE vc_deals DROP COLUMN IF EXISTS dumped_at;
ALTER TABLE vc_deals DROP COLUMN IF EXISTS unlock_at;
ALTER TABLE vc_deals DROP COLUMN IF EXISTS offer_id;
DROP TABLE IF EXISTS vc_offers;
