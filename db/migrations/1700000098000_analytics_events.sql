-- Migration: 098_analytics_events
--
-- Server-side product analytics (backlog item 40, server half). See
-- docs/ANALYTICS.md and server/application/analytics.ts.
--
-- analytics_events  one row per product event (signup, session_start,
--                   character_created, lottery_rolled, quest_claimed,
--                   daily_claimed, shift_paid, casino_round, shop_order,
--                   tip_sent), written in the same transaction as the
--                   action. The only identifier is user_id (internal uuid);
--                   props hold numbers, booleans and catalogue ids, never a
--                   wallet, alias, free text, IP or location. Rows go with
--                   the user (ON DELETE CASCADE) and are pruned after
--                   ANALYTICS_RETENTION_DAYS (default 180) by the workers.
--                   Not append-only on purpose: retention and erasure must
--                   be able to delete.
--
-- Views (daily, UTC):
--   analytics_daily               events, distinct users and amount per event name
--   analytics_funnel_daily        per signup cohort: how many reached each
--                                 first-session beat within 24 h, and came back D1/D7
--   analytics_economy_daily       Cash and debt ledger in/out/net per reason
--   analytics_economy_totals_daily faucets, sinks and net Cash supply change per
--                                 day; player-to-player transfers (tips, beef
--                                 stakes and payouts) are reported apart, so a
--                                 tip only shows its burned fee as a sink
--
-- Also a BRIN index on ledger_entries(created_at): the ledger is append-only
-- and time-ordered, so BRIN makes day-range scans cheap at a few KB of index.

-- Up Migration
CREATE TABLE analytics_events (
  id            bigserial PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  user_id       uuid REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (name IN (
                  'signup', 'session_start', 'character_created', 'lottery_rolled',
                  'quest_claimed', 'daily_claimed', 'shift_paid', 'casino_round',
                  'shop_order', 'tip_sent')),
  props         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(props) = 'object'),
  amount_cents  bigint
);

CREATE INDEX analytics_events_name_time_idx ON analytics_events (name, occurred_at);
CREATE INDEX analytics_events_user_time_idx ON analytics_events (user_id, occurred_at);
CREATE INDEX analytics_events_time_brin ON analytics_events USING brin (occurred_at);
CREATE INDEX ledger_entries_created_brin ON ledger_entries USING brin (created_at);

CREATE VIEW analytics_daily AS
SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
       name,
       count(*)                 AS events,
       count(DISTINCT user_id)  AS users,
       sum(amount_cents)        AS amount_cents
  FROM analytics_events
 GROUP BY 1, 2;

CREATE VIEW analytics_funnel_daily AS
WITH firsts AS (
  SELECT user_id,
         min(occurred_at) FILTER (WHERE name = 'signup')            AS signup_at,
         min(occurred_at) FILTER (WHERE name = 'character_created') AS character_at,
         min(occurred_at) FILTER (WHERE name = 'lottery_rolled')    AS lottery_at,
         min(occurred_at) FILTER (WHERE name = 'daily_claimed')     AS daily_at,
         min(occurred_at) FILTER (WHERE name = 'quest_claimed')     AS quest_at,
         min(occurred_at) FILTER (WHERE name = 'shift_paid')        AS shift_at,
         min(occurred_at) FILTER (WHERE name = 'casino_round')      AS casino_at,
         min(occurred_at) FILTER (WHERE name = 'shop_order')        AS shop_at,
         min(occurred_at) FILTER (WHERE name = 'tip_sent')          AS tip_at
    FROM analytics_events
   WHERE user_id IS NOT NULL
   GROUP BY user_id
),
session_days AS (
  SELECT DISTINCT user_id, (occurred_at AT TIME ZONE 'UTC')::date AS day
    FROM analytics_events
   WHERE name = 'session_start'
)
SELECT (f.signup_at AT TIME ZONE 'UTC')::date AS cohort_day,
       count(*) AS signups,
       count(*) FILTER (WHERE f.lottery_at   < f.signup_at + interval '24 hours') AS lottery_24h,
       count(*) FILTER (WHERE f.character_at < f.signup_at + interval '24 hours') AS character_24h,
       count(*) FILTER (WHERE f.daily_at     < f.signup_at + interval '24 hours') AS daily_claim_24h,
       count(*) FILTER (WHERE f.quest_at     < f.signup_at + interval '24 hours') AS quest_claim_24h,
       count(*) FILTER (WHERE f.shift_at     < f.signup_at + interval '24 hours') AS shift_24h,
       count(*) FILTER (WHERE f.casino_at    < f.signup_at + interval '24 hours') AS casino_24h,
       count(*) FILTER (WHERE f.shop_at      < f.signup_at + interval '24 hours') AS shop_order_24h,
       count(*) FILTER (WHERE f.tip_at       < f.signup_at + interval '24 hours') AS tip_24h,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM session_days s
          WHERE s.user_id = f.user_id
            AND s.day = (f.signup_at AT TIME ZONE 'UTC')::date + 1)) AS returned_d1,
       count(*) FILTER (WHERE EXISTS (
         SELECT 1 FROM session_days s
          WHERE s.user_id = f.user_id
            AND s.day = (f.signup_at AT TIME ZONE 'UTC')::date + 7)) AS returned_d7
  FROM firsts f
 WHERE f.signup_at IS NOT NULL
 GROUP BY 1;

CREATE VIEW analytics_economy_daily AS
SELECT (created_at AT TIME ZONE 'UTC')::date AS day,
       account,
       reason,
       COALESCE(sum(delta_cents) FILTER (WHERE delta_cents > 0), 0)  AS inflow_cents,
       COALESCE(-sum(delta_cents) FILTER (WHERE delta_cents < 0), 0) AS outflow_cents,
       sum(delta_cents)                                              AS net_cents,
       count(*)                                                      AS entries,
       count(DISTINCT user_id)                                       AS users
  FROM ledger_entries
 GROUP BY 1, 2, 3;

CREATE VIEW analytics_economy_totals_daily AS
SELECT day,
       sum(inflow_cents)  FILTER (WHERE NOT transfer) AS faucet_cents,
       sum(outflow_cents) FILTER (WHERE NOT transfer) AS sink_cents,
       sum(net_cents)                                 AS net_supply_change_cents,
       COALESCE(sum(inflow_cents) FILTER (WHERE transfer), 0) AS transferred_cents
  FROM (
    SELECT e.*,
           e.reason IN ('tip', 'tip_out', 'beef_stake', 'beef_payout', 'beef_stake_refund') AS transfer
      FROM analytics_economy_daily e
     WHERE e.account = 'cash'
  ) t
 GROUP BY day;

-- Down Migration
DROP VIEW IF EXISTS analytics_economy_totals_daily;
DROP VIEW IF EXISTS analytics_economy_daily;
DROP VIEW IF EXISTS analytics_funnel_daily;
DROP VIEW IF EXISTS analytics_daily;
DROP INDEX IF EXISTS ledger_entries_created_brin;
DROP TABLE IF EXISTS analytics_events;
