# Prediction Pit (unlock D3)

Play-money binary markets. Players bet in-game Cash, which cannot be bought out or withdrawn
([Economy](ECONOMY.md)). The house banks every market at fixed odds, so Cash never moves between
players: a win is a faucet, a loss is a sink.

App capability: `predict` (`GET /v1/config` `capabilities.apps.predict`). Contract: `contract/openapi.yaml`
(`/predictions/markets`, `/predictions/markets/{marketId}`, `/predictions/markets/{marketId}/bets`,
`/predictions`), realtime
`prediction_settled` ([Realtime](REALTIME.md)). Tuning: `contract/config/predictions.json`.

## Markets

The workers process opens markets once a minute (`server/workers/prediction-markets.ts`):

| Kind     | Question key                           | Opens                                               | Bet window           | Resolves                             | Decided by                                                                           |
| -------- | -------------------------------------- | --------------------------------------------------- | -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `sim`    | `sim_call`                             | per top-3 house coin (by 5-min volume), per horizon | 45 s / 2 min / 5 min | 5m / 15m / 1h after the period start | a sealed commit-reveal draw (below)                                                  |
| `event`  | `event_rug_1h`                         | every 10 min, **off by default**                    | 5 min                | 1 h after the period start           | a sealed commit-reveal draw                                                          |
| `crypto` | `crypto_higher_24h` (BTCUSDT, SOLUSDT) | every hour, only with a source                      | 30 min               | 24 h after the hour                  | close of the 1m candle ending at `resolvesAt` vs the open of the hour's first minute |

**Why sim and event markets are sealed draws.** Every house coin keeps a fixed hidden drift for its whole
life (`server/application/hidden-arc.ts`: moon +60 bps a tick, slow bleed -30, rug -200, sideways 0),
and the engine applies it every 2 s at every stage. The drift shows in public data (`change5mBps`, the
price history). An independent security review simulated the exact tick formula: on moon coins "price
higher at resolution" was true 100% of the time at 5m, 15m and 1h, and 0% on bleeding coins; rug
questions were just as predictable. No question about a house coin's own price or death is fair at
fixed odds, so these markets no longer ask one. The coin is only the theme.

**Commit-reveal** (the standard "provably fair" pattern):

1. At open the server draws a fresh 32-byte secret (`crypto.randomBytes`) and publishes only
   `fairness.commitment = sha256(secret)` (also in `params.commitment`).
2. At `resolvesAt` the outcome is `yes` iff the low bit of `HMAC-SHA256(secret, marketId)[0]` is 1, and the
   secret is published as `fairness.seed`.
3. Anyone can check `sha256(seed) == commitment` and recompute the outcome. Because the commitment is
   public before any bet, the server cannot pick the outcome after seeing the bets. Nothing public says
   anything about the secret.
4. A secret that does not match its commitment voids the market (refund).

Verifying an old bet: every `GET /v1/predictions` row carries its market's `fairness` (the same
`{commitment, seed}` as the market list; `seed` once resolved or void, null for crypto and legacy
bets), and `GET /v1/predictions/markets/{marketId}` returns one market of any status. Markets that
have bets are never pruned, so the proof stays available.

Both outcomes have probability 1/2, and 1.9x keeps a 5% house edge. A simulation test checks the yes-rate
is 50% ± 3.5 points over 2,000 markets per horizon and kind, and that a coin that only goes up still
resolves about half `no`. [Inference] This makes sim markets a house game of chance like the casino's coin
flip; they sit behind the same 18+ confirmation. `event_rug_1h` is off by default because its copy would
read as a real rug question.

[Unverified] Perps on house coins are probably predictable for the same reason (long the moon coins,
short the bleeders). They exist on `main`, outside this PR, and deserve their own review.

## Bets

`POST /v1/predictions/markets/{marketId}/bets {outcomeId, stakeCents}`:

- `outcomeId` must be one of the market's outcomes (`400 unknown_outcome`).
- `minStakeCents` to `maxStakeCents` ($1 to $500, `400 stake_out_of_range`).
- Daily stake cap per player per UTC day, $2,000 (`429 RATE_LIMITED {reason: daily_stake_cap, resetAt}`).
- 18+ confirmation, the same one the casino and the Factory use (`403 AGE_REQUIRED`).
- Only while `status` is `open` and before `closesAt` (`409 CONFLICT {reason: market_closed}`).
- Not in Jail (`403 JAILED`, like the other money routes).
- Win: `stake x payoutBps / 10000` (1.9x, ledger `prediction_payout`). Loss: 0. Void: the stake
  (ledger `prediction_refund`). The player gets `prediction_settled`.

`POST /v1/predictions` (the old free-text route) answers `410 GONE {reason: use_market_bets}`. Open
legacy bets are refunded once their `closes_at` passes.

## Switches (fail closed)

- `PREDICTIONS_SETTLEMENT_ENABLED=1` (workers) schedules both the settlement sweep (5 s) and the
  market generator (1 min). Off: no market opens and nothing settles.
- `predict` in `CAPABILITIES_ON` opens the three market routes (API) and lets the generator run (workers).
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
