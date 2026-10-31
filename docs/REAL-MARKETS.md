# Real Markets (real-money predictions)

Status: **merged dark.** Both capabilities are off until the operator turns them on, and
they should stay off until the legal and provider clearances in [Rollout](#rollout) are done.

Real Markets is the real-money side of the Prediction Pit. A player browses live markets
from a provider, gets a quote, and buys YES or NO shares with **USDC from their own Solana
wallet**, signing in the wallet through Mobile Wallet Adapter (MWA). CT Life never holds the
money, never signs, and never broadcasts a transaction.

- **Panta first** (`panta.market`, binary USDC markets on Solana; partner REST API).
- **Jupiter's Prediction Market API second** (Polymarket liquidity on Solana; beta).
- **In-game Cash stays play money.** No Real Markets route takes, pays, shows or converts
  Cash, and no real-money result feeds Cash, XP or leaderboards. The Cash Prediction Pit
  (`/v1/predictions`, docs/PREDICTIONS.md) is a separate play-money game. Panta's terms
  forbid presenting simulated data as live Panta data, so the client must never show the two
  side by side in a way that could confuse them.

Research behind this design: `ct-life-evidence/research-20261030/REAL-MONEY-PREDICTIONS.md`
(not in this repo). Client contract: `REAL-MARKETS-CONTRACT.md` in the same folder.

## Mainnet isolation and the D0 guard

The game economy runs on **devnet**. `config.solana.cluster` comes from `APP_ENV`, and the D0
boot guard refuses `APP_ENV=prod` (mainnet) unless `ALLOW_MAINNET=1`. That guard protects the
devnet economy: payments, paid calls, Factory launches and drips.

Panta and Jupiter exist **only on mainnet** (neither has a devnet). Real Markets therefore
has its own, separate mainnet configuration:

|                        | Game economy                                              | Real Markets                                                                                                                        |
| ---------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Cluster                | `config.solana.cluster` (devnet unless `APP_ENV=prod`)    | always mainnet                                                                                                                      |
| RPC                    | `config.solana.rpcUrl`                                    | `config.realMarkets.mainnetRpcUrl` (`REAL_MARKETS_RPC_URL_MAINNET`, default `HELIUS_RPC_URL_MAINNET`)                               |
| Server signs or sends? | yes, for some features (devnet only, `assertDevnetChain`) | **never**                                                                                                                           |
| RPC methods used       | many                                                      | read-only: `getGenesisHash`, `getSignatureStatuses`, `getTransaction`, `getBlockHeight`, `getSignaturesForAddress` (reconciliation) |
| Guard                  | D0 (`ALLOW_MAINNET=1` for prod)                           | none needed: the server moves no funds                                                                                              |

- The Real Markets module never reads or writes `config.solana`. Turning it on does not
  switch the app to mainnet, does not need `ALLOW_MAINNET`, and does not trip the D0 guard.
- Before its first verification the module checks `getGenesisHash` equals mainnet-beta's
  (`5eykt4Us…`). A mis-set URL that points at devnet answers 503 `CAPABILITY_OFF {reason:
rpc_not_mainnet}` instead of "confirming" a trade that never happened.
- The client must use a **separate mainnet MWA authorization** for Real Markets, while the
  rest of the game keeps its devnet authorization. See the client contract.

## Non-custody guarantees

- The server builds **unsigned** v0 transactions. For Panta it compiles the instruction list
  the venue returns; for Jupiter it passes on the venue's transaction after checking it.
- In both cases the server refuses (502 `REAL_MARKETS_PROVIDER_ERROR {reason:
unexpected_signer | already_signed}`) any transaction whose fee payer is not the player's
  wallet, or that needs any other signer. CT Life can never be made a signer, a fee payer or
  a custodian.
- Orders are always built for the **SIWS wallet the player signed in with** (`users.wallet`).
  An optional `wallet` in the request that differs answers 403
  `REAL_MARKETS_WALLET_MISMATCH`. Positions are always read for that wallet.
- No Real Markets env var is a key that can sign. API keys stay server-side; Panta forbids
  shipping its key in an app.

## The gate (every route except `/config`)

1. **Location** → 451 `REAL_MARKETS_GEO_BLOCKED {country, reason}`.
   - The country comes from a request header set by the edge. The default is Cloudflare's
     `CF-IPCountry`, plus `cf-region-code` for regions.
   - **Fail closed: the country header is trusted only together with the edge secret.** A
     request counts its country only if it also carries `REAL_MARKETS_EDGE_AUTH_HEADER` with
     the value `REAL_MARKETS_EDGE_AUTH_SECRET` (timing-safe compare). With no secret
     configured, or a request without the right one, the country is ignored and the request
     reads as `unknown_country` (451). A player who sends their own `CF-IPCountry` straight
     to the Railway origin gets nothing.
   - **Boot guard.** With `realMarkets` in `CAPABILITIES_ON`, the API refuses to start unless
     both edge variables are set. Only `APP_ENV=local` and `NODE_ENV=test` are exempt; there,
     every request without the secret reads as `unknown_country`, or set
     `REAL_MARKETS_ALLOW_UNKNOWN_COUNTRY=true` for local UI work.
   - Cloudflare sends `XX` for "no country data" and `T1` for Tor. Both are refused.
   - IP geolocation is evaded by VPNs. It is a required control, not a guarantee.

### Edge: where the trusted country comes from

**Railway provides no country header.**

- Railway's public-networking docs list no geolocation header (read 2026-10-31).
- The community request for one ("Add request country header for incoming traffic", which
  proposes `x-railway-ip-country`) has been `under_review` since 2026-03-09, with no staff
  reply.
- Railway's `X-Forwarded-For` / `X-Real-IP` carry the client IP, not a country.
- Before this PR the backend had no IP-country source at all.

**The free option: a Cloudflare proxy in front of the API.**

1. Add the API's domain to Cloudflare (Free plan) and proxy it (orange cloud) to the Railway
   service's domain.
2. Turn on **Network → IP Geolocation**. It is available on all plans, Free included, and
   adds `CF-IPCountry`. Optionally turn on the **Add visitor location headers** managed
   transform for `cf-region-code`.
3. Add one **Transform Rule → Modify request header → Set static** for all requests to the
   API host: header `x-edge-auth` (any name not starting with `cf-` / `x-cf-`, which
   Cloudflare reserves) set to a long random secret. The Free plan allows 10 Transform Rules.
4. On Railway set `REAL_MARKETS_EDGE_AUTH_HEADER=x-edge-auth` and
   `REAL_MARKETS_EDGE_AUTH_SECRET=<the same secret>`. Point the client's API base URL at the
   Cloudflare-proxied hostname.
5. Check it:
   - a request through Cloudflare from an allowed country gives `GET
/v1/real-markets/config` → `country` set;
   - a request straight to the `*.up.railway.app` URL gives `unknown_country`.

[Unverified] that Cloudflare overwrites a `CF-IPCountry` value a client sends through the
proxy. The secret already stops direct-to-origin spoofing; confirm this with one request
during rollout. Rotate the secret by updating the Transform Rule and the Railway variable
together.

### The client's API host must be the Cloudflare-proxied host

Geo works only for requests that pass through Cloudflare, because only Cloudflare adds the
country and the edge secret. **The client's API base URL must be the Cloudflare-proxied
hostname, never the `*.up.railway.app` URL.** A client pointed at the Railway URL reads as
`unknown_country` for every player, and every Real Markets route answers 451.

`GET /real-markets/config` tells the client which case it is in:

| `geoTrusted` | `geoUntrustedReason`  | Meaning                                                                   | What the client shows                                                                          |
| ------------ | --------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `true`       | `null`                | The country came from the edge. `reasons` decides eligibility.            | The terminal, or the normal "not available in {country}"                                       |
| `false`      | `edge_not_configured` | This deployment has no edge secret yet (rollout step 3 not done).         | "Real Markets are not available yet."                                                          |
| `false`      | `not_via_edge`        | The secret is configured, but this request did not come through the edge. | A clear "connection not supported" error; log it as a client misconfiguration (wrong API host) |

2. **18+** → 403 `AGE_REQUIRED {feature: realMarkets}`. This uses the character's age
   confirmation (`characters.age_confirmed_at`, `GET /me` `ageConfirmed`). A player without
   it confirms with `POST /v1/me/age-confirm` (below).
3. **Wallet** → 403 `FORBIDDEN {reason: wallet_required}` when the account has no valid
   linked wallet.

`GET /real-markets/config` runs the same checks but **reports** them in `reasons`. The client
uses it to hide the terminal entirely when the player is not eligible.

### 18+ after character creation (`POST /v1/me/age-confirm`)

**How the age gate works.**

- Character creation (`POST /v1/characters`) requires `ageConfirmed: true` and sets
  `characters.age_confirmed_at = now()`. It has done so since M2.
- That column is the only 18+ flag. The casino, the Factory, the Prediction Pit and Real
  Markets read it. `GET /me` and `GET /casino/state` report it as `ageConfirmed`.
- Before this endpoint, nothing could set it after creation, so an account without it stayed
  at `AGE_REQUIRED` for good.

**Who is stuck.** [Inference] from the code: through the API alone a character always has the
flag. Accounts reach Real Markets without it in two ways:

- They have no character, so there is no flag. They must create one, because the flag lives on
  the character. The endpoint answers them 404.
- Their character row was written outside `POST /v1/characters` (seed or e2e scripts, manual
  SQL) with the column null.

The client round reported such accounts.

**The endpoint.** `POST /v1/me/age-confirm {confirmed: true}` with an Idempotency-Key and,
ideally, `X-Client-Version`.

- It sets the same column.
- On the first call it writes one row to `age_confirmations`: the time, the client version and
  `source: me_age_confirm`. No IP is stored.
- Calling it again changes nothing. It answers `alreadyConfirmed: true` with the original time.
- It is rate-limited per player: burst 5, then one call per 10 minutes, answering `429
{reason: age_confirm}`.
- No capability is needed: the casino and the Factory use it too.
- `GET /me` `ageConfirmed`, `GET /casino/state` and the Real Markets gate flip on the next
  request.

**Is there a legal reason the confirmation must happen at creation?**

- I found no source that requires an 18+ self-declaration to be made at account creation.
  [Inference] For an age-restricted feature, what matters is that the check happens before the
  feature is used. A later, explicit confirmation before entering Real Markets or the casino
  does that.
- I cannot verify this for Nigeria or any other target market. It joins the lawyer's existing
  question in [Rollout](#rollout), whether self-declared 18+ plus IP gating is enough.
- [Unverified] Some real-money gambling regulators require verified age, not self-declared
  age. If so, that applies equally to the creation checkbox and to this endpoint.
- The FTC's COPPA FAQ (read 2026-10-31) is about collecting personal information from children
  under 13, not about 18+ features. It says to:
  - ask age "in a neutral manner", for example by letting users enter their month and year of
    birth;
  - "avoid encouraging children to falsify age information" (an "I am over 12" checkbox is not
    neutral);
  - use "technical means, such as a cookie, to prevent children from back-buttoning to enter a
    different age".

**Client rules that follow:**

- Use a neutral screen such as a date of birth. Never use a pre-ticked or "tap to continue"
  18+ box.
- Call the endpoint only when the answer is 18 or over.
- When the answer is under 18, remember it on the device and do not offer the question again
  there.

### Deny-list

The built-in list is the union of the providers' published restrictions (research read
2026-10-30). The operator **adds** countries with `REAL_MARKETS_BLOCKED_COUNTRIES` (the
lawyer's list). Removing a built-in entry is a reviewed code change
(`server/shared/domain/real-markets.ts`).

| Codes                                                                     | Source                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| US, KR                                                                    | Jupiter Prediction API: "restricted United States and South Korea IPs"                                                                                                                     |
| US CN TW SG MM CI CU CD IR IQ LY ML NI KP SO SD SY YE ZW                  | Jupiter Terms, "Prohibited Localities". "The Republic of China" is Taiwan's formal name but may mean the PRC, so both are listed                                                           |
| RU BY                                                                     | [Inference] Jupiter's "subject to sanctions enforced by the US, UK or EU" catch-all                                                                                                        |
| Regions UA-43, UA-40, UA-14, UA-09 (Crimea, Sevastopol, Donetsk, Luhansk) | Jupiter Terms (Crimea and Sevastopol) and sanctions practice. [Unverified] that Cloudflare's `cf-region-code` uses these ISO 3166-2 codes; check against real traffic before relying on it |

Panta publishes no country list. Its terms make the integrator responsible for lawfulness in
each jurisdiction (Public API Terms §10). Nigeria, the UK and the EU are not on any provider
list today, but that is not a legal opinion.

## Endpoints

All routes are under `/v1/real-markets`, need auth and capability `realMarkets`.
`provider=jupiter` also needs `realMarketsJupiter`. POSTs need an `Idempotency-Key`.
Full schemas are in `contract/openapi.yaml` (tag `realMarkets`).

| Route                                         | Purpose                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /config`                                 | Eligibility (`eligible`, `reasons`), `chain: solana:mainnet`, providers with attribution and categories, risk warning, limits                   |
| `GET /markets?provider&category&cursor&limit` | Paginated board (30 s cache, `asOf`)                                                                                                            |
| `GET /markets/{marketId}?provider`            | One market with spot prices (5 s cache)                                                                                                         |
| `POST /quote`                                 | `{provider, marketId, side, amountUsdc}` → quote (Panta `quoteId` lives about 90 s)                                                             |
| `POST /order/build`                           | `{…, quoteId?, maxSlippageBps?, wallet?, riskAccepted, riskWarningVersion?}` → 201 `{orderId, txBase64, expiresAt, provider, chain, wallet, …}` |
| `POST /order/submitted`                       | `{orderId, signature}` → records it and verifies it on mainnet                                                                                  |
| `GET /orders?limit`                           | My order records; reconciles unsigned orders from chain first ([Reconciliation](#reconciliation-the-app-died-before-ordersubmitted))            |
| `GET /orders/{orderId}`                       | One order; reconciles while `built`, re-verifies while `submitted` (the client polls)                                                           |
| `GET /positions?provider`                     | My linked wallet's positions, each with `providerUrl` and (when claimable) `claimUrl`                                                           |

Outside `/real-markets`: `POST /v1/me/age-confirm {confirmed: true}` sets the 18+ flag after
character creation ([above](#18-after-character-creation-post-v1meage-confirm)).

### Provider pages (`providerUrl`, `claimUrl`)

Every market (board and detail) carries `providerUrl`. Every position carries `providerUrl`
and `claimUrl`, which is set only while the position is claimable and not yet claimed. CT
Life builds no claims or sells yet, so the client opens these pages instead.

| Provider | `providerUrl`                                   | `claimUrl`                          | Source                                                                                                                                                                                                                                                                                                                    |
| -------- | ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panta    | `https://panta.market/market/{marketId}/{slug}` | the market page                     | Panta's API docs publish **no** web URL format (docs.panta.market, `llms-full.txt`, read 2026-10-31). The format and the slug rule come from panta.market's own web bundle, which builds `/market/{eventPda}/{slug}`. The API's `marketId` is the event address. [Unverified] that the claim action is on the market page |
| Jupiter  | `https://jup.ag/prediction`                     | `https://jup.ag/prediction/profile` | Jupiter's user docs name `jup.ag/prediction` (Browse) and `jup.ag/prediction/profile` (claims are made from Profile). [Unverified] a per-event deep link, so the board links to Predict                                                                                                                                   |

The slug is the title, NFKD-normalised, with accents dropped, lower-cased, every run of
non-alphanumerics turned into `-`, trimmed and cut to 80 characters (`market` when empty)
(`pantaSlug`, `server/shared/domain/real-markets-links.ts`). Panta's terms (§6) let the attribution
link to panta.market, and these links are the same kind of outbound link. Show the
attribution next to them as usual.

### Order lifecycle

```
build (unsigned tx, ~60 s)  ->  MWA sign_and_send (mainnet)  ->  submitted  ->  confirmed | failed | mismatch
                                                                              (providerState: pending -> filled | failed)
```

- **confirmed**: the signature landed from the order's wallet (fee payer), invoked every
  program the built transaction invokes, and succeeded. Extra programs are allowed, for
  example a priority fee the wallet added.
- **failed**: it landed with an on-chain error, or it never landed before its
  `lastValidBlockHeight`.
- **mismatch**: it landed but is not this order (wrong fee payer or programs). The submit
  answers 422 `REAL_MARKETS_TX_MISMATCH`. Other 422 reasons are `signature_reused` (the
  signature already belongs to another order) and `order_already_submitted`.
- After confirmation the server tells the venue: Panta `POST /primaryordersubmit/` when the
  signature arrives and `POST /trades/` (attribution) once it is confirmed. Both calls are
  idempotent by signature at Panta. `providerState` is read from Panta
  `/primaryorderverify/` or Jupiter `/orders/status/{orderPubkey}`. Jupiter's keepers fill
  after the transaction lands, so a confirmed Jupiter order can be `pending` for a while.
- Each transition is a conditional `UPDATE … WHERE status = …`, so venue notifications fire
  once even when the client polls concurrently.

### Reconciliation: the app died before `/order/submitted`

MWA `sign_and_send_transactions` broadcasts from the wallet. If the app is killed after that
but before `POST /order/submitted`, the trade may have landed while the order still reads
`built`, then `expired`. The server now finds such trades itself.

- **When:** on demand, in `GET /orders` and in `GET /orders/{id}` for a `built` order. There is
  no background worker: a worker would scan every player's wallet on the paid RPC, while on
  demand costs nothing for players who never come back to the screen.
- **What it reads:** the player's `built` orders of the last 24 h that carry fingerprints (at
  most 20). With none, it makes no RPC call. Otherwise it reads `getSignaturesForAddress(wallet,
{limit: 25, commitment: confirmed})` on the isolated Real Markets RPC, after the same
  mainnet genesis check. It skips signatures already attached to an order, without a block
  time, or older than the oldest pending order. It fetches at most 8 transactions
  (`getTransaction`, base64).
- **The match:** the landed transaction must:
  - be paid by the order's wallet;
  - contain **every instruction of the built transaction** (program and exact data; the
    fingerprints are stored at build time);
  - have landed during the order's life (built-at minus 30 s to expires-at plus 150 s).

  Extra instructions are allowed, because wallets add priority fees or guard assertions.
  Compute-budget instructions are never part of the fingerprint, because wallets rewrite
  them. If two identical builds match, the one with the same recent blockhash wins, else the
  newest.

- **No memo or reference key is added.** The fingerprint is already unique to the order: Panta's
  instruction data is bound to the quote, and Jupiter's to its order account. Adding an
  instruction would change transactions the venues built and verify. Panta documents its
  verification as fail-closed for market creation, and [Unverified] whether an extra
  instruction trips its primary-order verification.
- **Then:** the order goes `built → submitted` (conditional; the signature stays unique) with
  `reconciled_at` set, and the venue is told (Panta submit). The normal verification
  (`verifyOrderSignature`) alone decides `confirmed` or `failed`. The order view shows
  `reconciled: true`.
- **Never a trade that did not land:** only signatures the RPC lists as landed at `confirmed`
  are considered, and confirmation still requires success on chain. An order whose transaction
  is not found stays `built` and shows `expired`. A client-reported signature is never
  overwritten.
- **Bounds:** one reconcile per player per 20 s (Redis `NX` key), and a deployment-wide token
  bucket of 120 burst and 2/s for reconcile RPC calls. Any RPC failure is logged and skipped:
  `GET /orders` still answers.
- Orders built before migration 143 have no fingerprints and are never reconciled.

### Limits and errors

| Limit                                    | Value                                                  | Error                                                    |
| ---------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| Reads (board, detail, orders, positions) | 60 burst, 1/s per player                               | 429 `{reason: real_markets_read}`                        |
| Quotes                                   | 20 burst, 20/min                                       | 429 `{reason: real_markets_quote}`                       |
| Builds                                   | 10 burst, 10/min                                       | 429 `{reason: real_markets_build}`                       |
| Submits                                  | 20 burst, 20/min                                       | 429 `{reason: real_markets_submit}`                      |
| Builds per rolling 24 h                  | `REAL_MARKETS_DAILY_ORDER_CAP` (30)                    | 429 `{reason: real_markets_daily_cap, cap}`              |
| Order size                               | `REAL_MARKETS_MAX_ORDER_USDC` (100); Jupiter minimum 5 | 400 `{reason: amount_above_cap \| amount_below_minimum}` |
| Venue 429                                | passed on with the venue's `Retry-After`               | 429 `{reason: provider_rate_limited, provider}`          |

| Code                                | HTTP | When                                                                                                                |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITY_OFF`                    | 503  | `realMarkets` / `realMarketsJupiter` off; `{reason: rpc_not_mainnet \| rpc_unreachable}` for a bad Real Markets RPC |
| `REAL_MARKETS_GEO_BLOCKED`          | 451  | `{country, reason: blocked_country \| blocked_region \| unknown_country}`                                           |
| `AGE_REQUIRED`                      | 403  | 18+ not confirmed                                                                                                   |
| `FORBIDDEN`                         | 403  | `{reason: wallet_required}`                                                                                         |
| `REAL_MARKETS_WALLET_MISMATCH`      | 403  | the body named a wallet other than the linked one                                                                   |
| `RISK_NOT_ACCEPTED`                 | 400  | `riskAccepted` false, or an outdated `riskWarningVersion`                                                           |
| `VALIDATION_FAILED`                 | 400  | bad body or amount; `unknown_category`                                                                              |
| `NOT_FOUND`                         | 404  | unknown market, or an order that is not the caller's                                                                |
| `REAL_MARKETS_QUOTE_EXPIRED`        | 409  | Panta `QUOTE_EXPIRED` / `QUOTE_STALE`: quote again                                                                  |
| `REAL_MARKETS_ORDER_REJECTED`       | 422  | the venue refused the order `{providerCode, providerMessage}`                                                       |
| `REAL_MARKETS_TX_MISMATCH`          | 422  | the signature is not this order                                                                                     |
| `REAL_MARKETS_PROVIDER_ERROR`       | 502  | unexpected venue answer, including `unexpected_signer`                                                              |
| `REAL_MARKETS_PROVIDER_UNAVAILABLE` | 503  | `{reason: not_configured \| provider_auth \| provider_forbidden \| timeout \| network \| upstream_5xx}`             |

Venue calls have an 8 s timeout. Reads and Panta's documented-idempotent writes (`submit`,
`trades`) retry up to 3 times with jittered backoff; quotes and builds never retry. Errors
and logs never contain API keys (a test asserts it).

## Data

Migration 142 adds `real_market_orders` (docs/DATA_MODEL.md). Migration 143 adds its
`recent_blockhash`, `ix_fingerprints` and `reconciled_at` columns (reconciliation), and the
`age_confirmations` audit table (`POST /v1/me/age-confirm`; deleted with the account). It holds one row per built
order: wallet, provider, market, side, amount in USDC base units, estimates, the venue's
order and quote ids, the programs the transaction invokes, its last valid block height,
status, venue state, signature (unique), the edge country code (no IP), the risk-warning
version accepted, and timestamps.

The table is for the player's history and for anti-abuse (daily cap, signature reuse). It
moves no money and touches no ledger. Account deletion (`DELETE /v1/me`) deletes the rows.
The trades themselves stay public on Solana.

## Provider notes

### Panta (capability `realMarkets`)

- Partner REST API at `https://live-api.panta.market/api/v1`, `X-Api-Key`, trailing slashes
  (docs.panta.market, re-read 2026-10-31). There is **no sandbox**: `pk_test_` and
  `pk_live_` keys both hit production, and the devnet program is abandoned.
- **Primary buys only** in this phase. A graduated (`secondary`) market is listed but has
  `tradable: false`. Secondary-book trading, win claims and disputes are later phases; until
  then send players to panta.market.
- No `userId` is sent to Panta, so attribution goes to our partner account and no CT Life
  user id leaves the server.
- **Attribution is mandatory**: "Powered by Panta", reasonably prominent, next to the
  feature, optionally linking to panta.market (Public API Terms §6). Every response carries
  `attribution`.
- Panta's default rate limits are per **partner account**, so all players share them (reads
  120/min, quotes 30/min, builds 20/min). The server caches catalog pages for 30 s and detail
  for 5 s.
- [Inference] Maturity risk: about 4.4k program transactions since June 2026, a single-key
  upgrade authority, and no audit found. Keep `REAL_MARKETS_MAX_ORDER_USDC` low, and the
  client should tell players the program is upgradeable by its operator.

### Jupiter Prediction Market API (capability `realMarketsJupiter`, OFF by default)

- **Jupiter's written OK is pending.** Its SDK and API licence §3.1(h) forbids content that
  "promotes … gambling". Do not turn `realMarketsJupiter` on until `legal@jup.ag` confirms in
  writing that a game routing players to Jupiter's prediction markets is allowed. §7.3 also
  puts licensing, KYC/AML and wallet screening duties on the licensee.
- BETA and "subject to breaking changes". Attribution: "Powered by Jupiter" (licence §8.4),
  and the specific API is named (§2.3).
- **Jupiter blocks US and South Korea IPs, and the server is the client here.** The backend
  calls Jupiter from its own IP, so the API service must run in a region Jupiter does not
  block. [Unverified] which Railway region the API runs in today.
- Minimum order 5 USDC. Settles in USDC (`depositMint`). Lists Polymarket events by default.
  The wallet broadcasts through MWA, so Jupiter's `POST /execute` is not used.

## Rollout

Every step before "flip" is a **blocker**. Ordered phases, each a submittable build:

1. **Legal and store clearance.**
   - A lawyer reviews real-money prediction routing for Nigeria first, then each target
     market. Topics: facilitation or "arranging" bets, whether self-declared 18+ plus IP
     gating is enough, any in-game reward tied to real bets, and consumer terms and risk
     disclosures.
   - **dApp Store build only.** Google Play bans apps that "direct users to" real-money
     gambling without a gambling licence for each country. Real Markets must be compiled
     out of any Play build. The Solana dApp Store Publisher Policy has no gambling clause
     but bans content that violates applicable law; ask Solana Mobile in writing.
   - Decide what happens to the Cash Prediction Pit: remove it, or relabel it "Practice Pit
     (no real money)".
2. **Accounts (the user, not CI).**
   - Create a Panta developer account and an API key. Email Panta about revenue share, geo
     stance, audits and rate limits.
   - For Jupiter: create a Developer Platform key and get the written OK from
     `legal@jup.ag`.
3. **Edge (required: the API will not boot with `realMarkets` on without it).** Set up the free
   Cloudflare proxy, IP Geolocation and the secret-header Transform Rule as described in
   [Edge](#edge-where-the-trusted-country-comes-from). Confirm with real requests that a
   proxied request gets a country and a direct-to-Railway request gets `unknown_country`.
   Check what `cf-region-code` looks like for a Ukrainian IP.
4. **Env (Iyke, on Railway).**
   - `PANTA_API_KEY` (secret).
   - `REAL_MARKETS_RPC_URL_MAINNET` (a paid mainnet RPC is recommended; the public one is
     rate-limited).
   - `REAL_MARKETS_EDGE_AUTH_HEADER` and `REAL_MARKETS_EDGE_AUTH_SECRET` (both required to
     boot with `realMarkets` on).
   - `REAL_MARKETS_BLOCKED_COUNTRIES` (the lawyer's additions).
   - Optionally `REAL_MARKETS_MAX_ORDER_USDC` and `REAL_MARKETS_DAILY_ORDER_CAP`.
   - Later: `JUPITER_API_KEY`.
   - Run the migration (142).
5. **Flip.** Add `realMarkets` to `CAPABILITIES_ON` and redeploy. Check `GET
/v1/real-markets/config` from an allowed and a blocked country. Do a small real buy from
   a test wallet with a test float (mainnet only; there is no devnet). Watch `submitted →
confirmed` and the position.
6. **Jupiter.** After the written OK and the region check, set `JUPITER_API_KEY` and add
   `realMarketsJupiter`. Test with the 5 USDC minimum.

To roll back, remove the capability from `CAPABILITIES_ON` and redeploy. Every route then
answers 503 at once. Positions stay in players' wallets at the venue.

## Unverified and open items

- [Unverified] That Cloudflare overwrites a client-sent `CF-IPCountry` on proxied requests (the
  edge secret already blocks direct-to-origin spoofing).
- [Unverified] `cf-region-code` format for the sanctioned-region list.
- [Unverified] Panta's `/market/{eventPda}/{slug}` page format is read from panta.market's web
  bundle, not from Panta's docs, and could change without notice. Ask Panta to confirm it, or
  to add a URL to the API. Also unverified: that panta.market shows the claim action on the
  market page, and Jupiter per-event deep links.
- [Unverified] Whether an extra (memo) instruction would trip Panta's order verification. Not
  needed: reconciliation matches on the built instructions.
- [Unverified] Jupiter `POST /orders` money fields are read as micro USD (the spec says so
  for `orderCostUsd` and fees; the quote's average price is derived as cost / contracts).
- [Unverified] Whether Panta offers partner revenue share today.
- Not built yet: claims, sells and secondary trading, disputes, wallet sanctions screening
  (Jupiter licence §7.3; needs a screening provider), Kalshi listing through Jupiter.
