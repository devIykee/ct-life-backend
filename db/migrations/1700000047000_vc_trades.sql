-- Migration: 047_vc_trades
--
-- The M6 VC trade. One row per open or closed position. The
-- market engine is the single writer of price_micros on coins;
-- vc_trades captures the per-trade entry and exit snapshots.
--
-- `asset` is the coin symbol (e.g. 'TOK-XYZ'). The M6 VC
-- service maintains an asset whitelist in
-- `contract/config/vc_assets.json`; the application refuses
-- trades on anything else.
--
-- `direction` is 'long' or 'short'. The CHECK keeps the enum
-- honest at the schema level.
--
-- `notional_cents` is the size of the position in cents. The
-- margin posted at open is `notional_cents / leverage`.
--
-- `leverage` is the trade's leverage. The application refuses
-- if `leverage > desk.leverage_cap`. CHECK in (1,2,3,5) mirrors
-- the desk's cap.
--
-- `entry_price_micros` is the price of the asset at open (in
-- micros per unit, matching coins.price_micros).
--
-- `exit_price_micros` is null while the trade is open; set
-- at close. The market engine's price path is the close price;
-- the application reads it inside a SERIALIZABLE UoW.
--
-- `pnl_cents` is the realised PnL at close. Negative on a loss.
-- Set to 0 while the trade is open.
--
-- `status` is 'open', 'closed', or 'liquidated'. The CHECK
-- keeps the enum honest. Index (desk_id, status) is the
-- hot-path for the desk's open-trade list; the
-- (owner_user_id, opened_at DESC) index supports the
-- "recent trades" view.
--
-- `opened_at` is set on insert. `closed_at` is set at close.
-- Both are timestamptz.

-- Up Migration
CREATE TABLE vc_trades (
  trade_id            uuid PRIMARY KEY,
  desk_id             uuid NOT NULL,
  owner_user_id       uuid NOT NULL,
  asset               text NOT NULL,
  direction           text NOT NULL
                       CHECK (direction IN ('long', 'short')),
  notional_cents      bigint NOT NULL CHECK (notional_cents > 0),
  leverage            int NOT NULL
                       CHECK (leverage IN (1, 2, 3, 5)),
  entry_price_micros  bigint NOT NULL CHECK (entry_price_micros > 0),
  exit_price_micros   bigint CHECK (exit_price_micros > 0),
  pnl_cents           bigint NOT NULL DEFAULT 0,
  status              text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'closed', 'liquidated')),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz,

  FOREIGN KEY (desk_id) REFERENCES vc_trading_desks(desk_id) ON DELETE CASCADE
);

CREATE INDEX vc_trades_desk_status_idx
  ON vc_trades (desk_id, status);

CREATE INDEX vc_trades_owner_opened_idx
  ON vc_trades (owner_user_id, opened_at DESC);

-- Down Migration
DROP TABLE IF EXISTS vc_trades;
