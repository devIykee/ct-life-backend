-- Migration: 055_advanced_orders
--
-- The M6 advanced order types (limit, stop_loss, take_profit,
-- OCO). One row per pending or filled order. The M6
-- advanced-orders worker (server/workers/advanced-orders.ts)
-- walks pending orders on a 5s tick, compares the engine's
-- price path to `trigger_micros`, and flips status to
-- 'filled' when the trigger fires. The M6 close route is
-- async via the worker; the POST route returns 'pending'
-- immediately.
--
-- `side` is 'buy' or 'sell'.
-- `order_kind` is one of:
--   'limit'        - fill at trigger_micros (buy <= trigger or
--                    sell >= trigger)
--   'stop_loss'    - fill at trigger_micros (sell <= trigger)
--   'take_profit'  - fill at trigger_micros (sell >= trigger)
--   'oco'          - one-cancels-the-other: trigger on either
--                    side; the worker fills the triggered side
--                    and cancels the other.
--
-- `trigger_micros` is the price at which the order fires.
-- `amount_cents` is the size of the order in cents. CHECK > 0.
--
-- `status` is 'pending', 'filled', 'cancelled', or 'expired'.
-- The CHECK keeps the enum honest at the schema level.
--
-- `created_at` is set on insert. `triggered_at` is set when
-- the worker fills the order. `expires_at` is optional
-- (null = no expiry).
--
-- Index:
--   (user_id, status) - the user's pending/filled list
--   (coin, status)    - the worker's hot-path: "all pending
--                       orders for this coin"

-- Up Migration
CREATE TABLE advanced_orders (
  order_id        uuid PRIMARY KEY,
  user_id         uuid NOT NULL,
  coin            text NOT NULL,
  side            text NOT NULL
                   CHECK (side IN ('buy', 'sell')),
  order_kind      text NOT NULL
                   CHECK (order_kind IN ('limit', 'stop_loss', 'take_profit', 'oco')),
  trigger_micros  bigint NOT NULL CHECK (trigger_micros > 0),
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  status          text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'filled', 'cancelled', 'expired')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  triggered_at    timestamptz,
  expires_at      timestamptz
);

CREATE INDEX advanced_orders_user_status_idx
  ON advanced_orders (user_id, status);

CREATE INDEX advanced_orders_coin_status_idx
  ON advanced_orders (coin, status);

-- Down Migration
DROP TABLE IF EXISTS advanced_orders;
