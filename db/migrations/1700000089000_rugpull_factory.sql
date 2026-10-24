-- Migration: 089_rugpull_factory
--
-- Rugpull Factory: player-launched, Cash-only, server-simulated parody coins.
--
-- MERGE ORDER: this number follows open PRs 084 (#9; 088 push_token_unique), 085 (#11), 086 (#12) and
-- 087 (season tracks). If it merges before them, run the migrator with
-- `--no-check-order`; it touches none of their tables.
--
--   coins.player_launched / creator_id   the market engine's own flag.
--   factory_coins                        launch parameters, fees earned, rug flag.
--   factory_trades                       every trade of a player coin (rug detection).
--   player_heat / player_heat_events     heat per player, exponential decay on read.
--   feed_posts.kind / meta               Timeline posts by NPCs (the Sleuth).
--   users row 'npc:sleuth'               the Sleuth's author id (fixed uuid).
--
-- Nothing here mints a token or is withdrawable: all amounts are game Cash cents.

-- Up Migration
ALTER TABLE coins
  ADD COLUMN player_launched boolean NOT NULL DEFAULT false,
  ADD COLUMN creator_id uuid REFERENCES users(id) ON DELETE RESTRICT;

CREATE INDEX coins_player_launched_idx ON coins (launched_at DESC) WHERE player_launched;

CREATE TABLE factory_coins (
  coin_id             uuid PRIMARY KEY REFERENCES coins(coin_id) ON DELETE CASCADE,
  creator_id          uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  template_id         text NOT NULL,
  liquidity_cents     bigint NOT NULL CHECK (liquidity_cents > 0),
  launch_fee_cents    bigint NOT NULL CHECK (launch_fee_cents >= 0),
  dev_allocation_bps  integer NOT NULL CHECK (dev_allocation_bps BETWEEN 0 AND 10000),
  launch_price_micros bigint NOT NULL CHECK (launch_price_micros > 0),
  creator_units       bigint NOT NULL CHECK (creator_units >= 0),
  creator_fees_cents  bigint NOT NULL DEFAULT 0 CHECK (creator_fees_cents >= 0),
  mooned_at           timestamptz,
  rug_flagged_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX factory_coins_creator_idx ON factory_coins (creator_id, created_at DESC);

CREATE TABLE factory_trades (
  id           bigserial PRIMARY KEY,
  coin_id      uuid NOT NULL REFERENCES coins(coin_id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  side         text NOT NULL CHECK (side IN ('buy', 'sell')),
  units        bigint NOT NULL CHECK (units > 0),
  cash_cents   bigint NOT NULL CHECK (cash_cents >= 0),
  fee_cents    bigint NOT NULL CHECK (fee_cents >= 0),
  price_micros bigint NOT NULL CHECK (price_micros > 0),
  at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX factory_trades_coin_at_idx ON factory_trades (coin_id, at DESC);

CREATE TABLE player_heat (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  heat        double precision NOT NULL DEFAULT 0 CHECK (heat >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE player_heat_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta       double precision NOT NULL,
  source      text NOT NULL,
  ref_id      text,
  heat_after  double precision NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX player_heat_events_user_idx ON player_heat_events (user_id, at DESC);

ALTER TABLE feed_posts
  ADD COLUMN kind text,
  ADD COLUMN meta jsonb;

-- One exposé per coin, enforced by the database.
CREATE UNIQUE INDEX feed_posts_sleuth_coin_uniq
  ON feed_posts ((meta ->> 'coinId'))
  WHERE kind = 'sleuth';

CREATE INDEX feed_posts_sleuth_user_idx
  ON feed_posts ((meta ->> 'launcherUserId'), created_at DESC)
  WHERE kind = 'sleuth';

INSERT INTO users (id, wallet)
VALUES ('00000000-0000-4000-8000-0000000051e7', 'npc:sleuth')
ON CONFLICT DO NOTHING;

-- Down Migration
DELETE FROM feed_posts WHERE kind = 'sleuth';
DELETE FROM users WHERE id = '00000000-0000-4000-8000-0000000051e7';
DROP INDEX IF EXISTS feed_posts_sleuth_user_idx;
DROP INDEX IF EXISTS feed_posts_sleuth_coin_uniq;
ALTER TABLE feed_posts DROP COLUMN IF EXISTS meta, DROP COLUMN IF EXISTS kind;
DROP TABLE IF EXISTS player_heat_events;
DROP TABLE IF EXISTS player_heat;
DROP TABLE IF EXISTS factory_trades;
DROP TABLE IF EXISTS factory_coins;
DROP INDEX IF EXISTS coins_player_launched_idx;
ALTER TABLE coins DROP COLUMN IF EXISTS creator_id, DROP COLUMN IF EXISTS player_launched;
