-- Migration: 046_vc_trading_desks
--
-- The M6 VC Row. One row per VC trading desk. A desk is a
-- configured risk container: the owner puts up seed cash, picks a
-- kind (which determines the leverage cap), and the kind/seed
-- drive the desk's lifetime. The trader can open and close
-- long/short trades on whitelisted assets under the desk's
-- leverage cap.
--
-- `kind` is the desk family:
--   'seed'      - the founder tier; leverage cap 1 (no leverage)
--   'series_a'  - 2x
--   'series_b'  - 3x
--   'tier_1'    - 5x
-- The leverage cap is a CHECK floor for the desk; the application
-- derives the per-trade cap by reading the desk row.
--
-- `base_price_cents` is the seed cost the founder debits via a
-- 'vc_desk_seed' ledger row when founding the desk. CHECK > 0
-- is the floor; the application caps the upper end via the
-- player's balance.
--
-- `leverage_cap` is the maximum leverage allowed on trades
-- opened under this desk. CHECK in (1,2,3,5) mirrors the four
-- kinds. The application also refuses trades whose leverage
-- exceeds the desk's cap.
--
-- `cash_cents` is the desk's available cash for margin + PnL.
-- The application reads/writes this row inside a SERIALIZABLE
-- UoW with `SELECT ... FOR UPDATE` to avoid double-spend.
--
-- `created_at` is set on insert. `closed_at` is set when the
-- founder closes the desk (no open trades allowed after close).
--
-- Index:
--   (owner_user_id) - the player's desk list

-- Up Migration
CREATE TABLE vc_trading_desks (
  desk_id           uuid PRIMARY KEY,
  owner_user_id     uuid NOT NULL,
  kind              text NOT NULL
                     CHECK (kind IN ('seed', 'series_a', 'series_b', 'tier_1')),
  base_price_cents  bigint NOT NULL CHECK (base_price_cents > 0),
  leverage_cap      int NOT NULL
                     CHECK (leverage_cap IN (1, 2, 3, 5)),
  cash_cents        bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  closed_at         timestamptz
);

CREATE INDEX vc_trading_desks_owner_idx
  ON vc_trading_desks (owner_user_id);

-- Down Migration
DROP TABLE IF EXISTS vc_trading_desks;
