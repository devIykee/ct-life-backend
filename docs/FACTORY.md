> **2026-10-26: retired.** The Cash Factory below is replaced by real token launches on Meteora DBC; see
> [FACTORY-REAL.md](FACTORY-REAL.md). Launching and buying Cash player coins answer 410.

# Rugpull Factory

A parody coin-launch sandbox at the Launchpad Tower. **Game Cash only.** Every coin is a row in
`coins`, simulated by the server's market engine. There is no token mint, nothing on chain,
nothing withdrawable, and no leaderboard of real value. The brand is invented; it is not a copy
of any real launchpad.

Code: `server/application/factory.ts` (launch, lists, detail), `factory-rug.ts` (trade hook,
creator fee, rug detection, Sleuth post), `factory-filter.ts` (name filter), `player-heat.ts`
(heat). Routes: `server/api/routes/factory.ts`. Migration: `089_rugpull_factory`.

## Flow

1. `POST /v1/factory/coins {name, ticker, templateId, liquidityCents, devAllocationBps}`
   (needs an `Idempotency-Key`). In one transaction the server checks the cap, cooldown and Cash,
   inserts the coin (`player_launched = true`, `creator_id`), debits Cash and credits the creator
   their dev units.
2. The coin is on the Pulse board at once (the market room mirrors `coins` every 2 s,
   `CoinState.playerLaunched = true`). The market sim starts ticking it within 5 s. `evt_coin_launch`
   is broadcast with `{coinId, ticker, playerLaunched: "1", templateId, creatorAlias}`.
3. Anyone trades it with `POST /v1/market/trades` (same endpoint and AMM as house coins).
4. The hidden arc plays out: price drifts, and a coin that falls 95% (rug), 50% (bleed), 15%
   (sideways) or 20% (moon) below its peak dies and gets a tombstone like any coin.

## Arc odds (server side only)

Read from `contract/config/market.json` `outcomeMix`, the same as house coins, sampled at launch
with a server seed and committed to `coins.hidden_arc`:

| Outcome  | Odds |
| -------- | ---- |
| rug      | 25%  |
| bleed    | 40%  |
| sideways | 20%  |
| moon     | 15%  |

The client cannot choose or see the arc: the body is strict (`additionalProperties: false`), and
no response carries it. `GET /v1/factory/config` shows the odds as information only.

## Money (integer cents)

[Inference: the numbers below are starting values to tune from play data.]

| Item           | Value                                                                                                                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch fee     | 500 (ledger `factory_launch_fee`, a Cash sink)                                                                                                                                                                                                                                                                  |
| Liquidity      | 1,000 to 100,000 (ledger `factory_liquidity`, locked in the coin, a sink)                                                                                                                                                                                                                                       |
| Dev allocation | 0 to 5,000 bps of the units the liquidity buys at the launch price; credited to the creator as a position. The rest is float.                                                                                                                                                                                   |
| Launch price   | 1,000 micros per unit (0.001 USD), the house launchpad's price                                                                                                                                                                                                                                                  |
| Limits         | 3 launches per rolling 24 h, 10 minute cooldown (`LAUNCH_LIMIT_REACHED`, `LAUNCH_COOLDOWN`)                                                                                                                                                                                                                     |
| Creator fee    | Once a trade sees the price at 3x the launch price or more (`mooned_at`), the creator earns 50% of every other player's trade fee on the coin (ledger `factory_creator_fee`). It comes out of the fee the market already charges (1% each way), so it is never new Cash. The creator's own trades earn nothing. |

The creator's earnings show in `creatorFeesCents` for the creator only.

## Name and ticker

Name 2 to 24 characters (letters, digits, space, `. ' ! _ -`), ticker 2 to 6 letters or digits
(stored upper case, unique). Both go through `factory-filter.ts`: slurs and profanity on a
normalised form (case, accents, leetspeak, separators and repeated letters removed), links and
domains, e-mail, phone numbers, wallet-like strings, and a few impersonation words. It is blunt on
purpose: a few innocent names with a bad word inside (the Scunthorpe problem) are refused; the
player retries (`NAME_NOT_ALLOWED`). Art is a fixed id from `templates` (`rf_*`); the client maps
ids to art.

## Rug detection and the Sleuth

After a creator's sell commits, the coin is a rug when, within 60 minutes, the creator sold at
least 30% of the units that were in circulation, and other players bought at least 500 cents in that window.
It is flagged once per coin (`factory_coins.rug_flagged_at`). Then:

- **Heat:** `35 + up to 15` by the share sold, capped at 100, in `player_heat` with an event row
  in `player_heat_events`. Heat halves every 24 h (decayed on read). At `wanted` the police start a pursuit
  (see `docs/HEAT.md`). `GET /v1/factory/me` and `GET /v1/heat/me` return it.
- **Timeline:** one post by the Sleuth (author `npc:sleuth`, a parody original character) in
  `feed_posts` with `kind = 'sleuth'` and `meta {coinId, ticker, launcherUserId, launcherAlias,
sellSharePct, heat, deepLink: "venue:launchpad_tower"}`. Text is templated in our own words (six
  variants picked from the coin id). Rate limits: a unique index allows one post per coin, and one post
  per launcher per 30 minutes (a second rug in that window still flags and heats, but does not post).
- **City:** `evt_rug` with `{coinId, ticker, kind: "creator_dump", launcherAlias, heat}`.

## Endpoints

| Method and path                                         | Notes                                           |
| ------------------------------------------------------- | ----------------------------------------------- |
| `GET /v1/factory/config`                                | fee, limits, templates, odds, rug rule          |
| `GET /v1/factory/me`                                    | heat and launch allowance                       |
| `POST /v1/factory/coins`                                | launch (idempotent)                             |
| `GET /v1/factory/coins?view=trending\|new\|mine&limit=` | lists                                           |
| `GET /v1/factory/coins/{coinId}`                        | detail with `candles1m`, top holders, risk hint |
| `POST /v1/market/trades`                                | buy and sell (existing)                         |

There is no creator-only mutation, so there is nothing to IDOR: the session decides who the
launcher is, `view=mine` filters by the session, and earnings are hidden from everyone else.

## Frontend notes

- Launchpad Tower UI: read `/factory/config` for the form limits; call `/factory/me` before showing the
  button (cooldown and cap, `nextLaunchAt`).
- Pulse: `CoinState.playerLaunched` and `templateId` mark player coins; use the coin's `/factory/coins/{id}` for the card.
- Timeline: `GET /feed` posts now carry `kind` and `meta`; render `kind: "sleuth"` as a Sleuth
  card and deep-link with `meta.deepLink`.
- HeatPlate: `GET /factory/me` -> `heat` (0..100) and `heatLevel` (`cool | warm | hot | wanted`).
