# Prediction Pit (unlock D3)

Play-money binary markets. Players bet in-game Cash, which cannot be bought out or withdrawn
([Economy](ECONOMY.md)). The house banks every market at fixed odds, so Cash never moves between
players: a win is a faucet, a loss is a sink.

App capability: `predict` (`GET /v1/config` `capabilities.apps.predict`). Contract: `contract/openapi.yaml`
(`/predictions/markets`, `/predictions/markets/{marketId}/bets`, `/predictions`), realtime
`prediction_settled` ([Realtime](REALTIME.md)). Tuning: `contract/config/predictions.json`.

## Markets

The workers process opens markets once a minute (`server/workers/prediction-markets.ts`):

| Kind     | Question key                           | Opens                                    | Bet window            | Resolves                             | Recorded at open                   | Decided from (at `resolvesAt`)                                  |
| -------- | -------------------------------------- | ---------------------------------------- | --------------------- | ------------------------------------ | ---------------------------------- | --------------------------------------------------------------- |
| `sim`    | `sim_higher`                           | top 3 coins by 5-min volume, per horizon | 60 s / 3 min / 10 min | 5m / 15m / 1h after the period start | the coin price (`strikeMicros`)    | the coin's minute snapshot; `yes` iff higher than the strike    |
| `event`  | `event_rug_1h`, `event_graduate_1h`    | every 10 min                             | 10 min                | 1 h after the period start           | the coin set (live / on the curve) | how many of those coins rugged / graduated; `yes` iff any       |
| `crypto` | `crypto_higher_24h` (BTCUSDT, SOLUSDT) | every hour, only with a source           | 1 h                   | 24 h after the hour                  | open of the hour's first 1m candle | close of the 1m candle ending at `resolvesAt`; `yes` iff higher |

**Why the windows are short.** The plan's draft closed bets 60 s before resolution. At fixed odds that
lets a player watch nearly the whole move and then bet on the side that is already winning, which
turns the 5% edge into a Cash faucet. Here every market records its strike when it opens and takes
bets only for its window right after that; a new market of each kind opens every `everySec`, so one
is usually taking bets.

**Outcomes are decided once.** The resolver stores `resolved_value_micros` and
`resolved_outcome_id` with one conditional update. Settlement only reads them, so a later price,
a retry or a second replica can never change an outcome.

**Void.** A `sim` market with no snapshot within `snapshotGraceSec` of `resolvesAt`, or a `crypto`
market whose source has not answered within `resolveGraceSec` (30 min), is `void`: every stake is
refunded (bet status `cancelled`, `payoutCents` = stake).

## Bets

`POST /v1/predictions/markets/{marketId}/bets {outcomeId, stakeCents}`:

- `outcomeId` must be one of the market's outcomes (`400 unknown_outcome`).
- `minStakeCents` to `maxStakeCents` ($1 to $500, `400 stake_out_of_range`).
- Daily stake cap per player per UTC day, $2,000 (`429 RATE_LIMITED {reason: daily_stake_cap, resetAt}`).
- 18+ confirmation, the same one the casino and the Factory use (`403 AGE_REQUIRED`).
- Only while `status` is `open` and before `closesAt` (`409 CONFLICT {reason: market_closed}`).
- Win: `stake x payoutBps / 10000` (1.9x, ledger `prediction_payout`). Loss: 0. Void: the stake
  (ledger `prediction_refund`). The player gets `prediction_settled`.

`POST /v1/predictions` (the old free-text route) answers `410 GONE {reason: use_market_bets}`. Open
legacy bets are refunded once their `closes_at` passes.

## Switches (fail closed)

- `PREDICTIONS_SETTLEMENT_ENABLED=1` (workers) schedules both the settlement sweep (5 s) and the
  market generator (1 min). Off: no market opens and nothing settles.
- `predict` in `CAPABILITIES_ON` opens the two routes (API) and lets the generator run (workers).
  Set it on both services.
- `PREDICTIONS_CRYPTO_SOURCE` (workers): `off` (default), `binance` (`api.binance.com`) or
  `binance_vision` (`data-api.binance.vision`). With `off`, or when the source fails, only `sim` and
  `event` markets open.

## Binance: what is verified and what is not

Read 2026-10-30 from primary pages:

- `GET /api/v3/klines` is keyless public market data, weight 2; rows are
  `[openTime, open, high, low, close, volume, closeTime, ...]`
  (https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints).
- `data-api.binance.vision` serves "only public market data" and needs no API key
  (https://developers.binance.com/docs/binance-spot-api-docs/faqs/market_data_only).
- A 429 must be respected; repeated calls after it get an IP ban (418) "from 2 minutes to 3 days"
  (https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits). The source stores a
  back-off in Redis for `Retry-After` (at least 60 s) and asks again at most every 30 s per market.
- **Terms blocker.** The Binance Vision Dataset Terms (v1.0, 2026-08-26) cover data "made available
  through data.binance.vision and associated endpoints", license it as CC BY-NC-SA 4.0, say
  "Commercial licensing is strictly excluded" (§3.4), and forbid using the name "Binance" to market
  consumer-facing software (§8.3) (https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf).
  [Inference] `data-api.binance.vision` is likely one of those "associated endpoints". CT Life sells
  Cash, so this is why the source defaults to `off`.
- [Unverified] The main Binance Terms of Use (which govern `api.binance.com`) could not be read: the
  page returned a bot challenge. Whether they allow this use is not known.
- [Unverified] `api.binance.com` answering HTTP 451 to US IPs is reported on forums only; Binance's API
  docs say nothing about it. Railway lets a service pick its region (US West, US East, EU West,
  Southeast Asia; https://docs.railway.com/reference/deployment-regions). Before turning a source on,
  run one klines GET from the deployed workers service.
- The client must not show the Binance name or logo as branding (§8.3); `source.ref` is for audits.

## Legal flag

Google Play's prediction-market policy covers apps that "accept assets of real-world value"
(https://support.google.com/googleplay/android-developer/answer/16902027). Today Cash is bought only
with devnet test USDC. [Inference] If mainnet top-ups of Cash ever go live, house-banked predictions on
purchasable Cash need a legal review first.
