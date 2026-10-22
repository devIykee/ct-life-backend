-- Migration: 081_player_entitlements
--
-- What a player owns that unlocks something in the game, keyed by a
-- stable item key ('vehicle.hovercar' first). Read by
-- GET /v1/me/entitlements and by the vehicles room, which refuses a
-- roadstar (hovercar) lease without 'vehicle.hovercar'.
--
-- `source` records how it was granted:
--   'nft'    - the player's wallet holds an asset in the item's Metaplex
--              Core collection (wallet sync via Helius DAS). Revoked when
--              the asset leaves the wallet.
--   'grant'  - ops / test grant (tools/scripts/entitlement-grant.ts).
-- There is no 'cash' source on purpose: game Cash can never buy an
-- on-chain-backed entitlement (product rule, 2026-10-22).
--
-- `reference` is the asset address for 'nft' rows, or a free-text note
-- for 'grant' rows. One live row per (user_id, item_key): the partial
-- unique index ignores revoked rows, so a re-grant after a sale works.

-- Up Migration
CREATE TABLE player_entitlements (
  entitlement_id  uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  item_key        text NOT NULL CHECK (item_key ~ '^[a-z]+\.[a-z0-9_]+$'),
  source          text NOT NULL CHECK (source IN ('nft', 'grant')),
  reference       text NOT NULL DEFAULT '',
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

CREATE UNIQUE INDEX player_entitlements_live_idx
  ON player_entitlements (user_id, item_key)
  WHERE revoked_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS player_entitlements;
