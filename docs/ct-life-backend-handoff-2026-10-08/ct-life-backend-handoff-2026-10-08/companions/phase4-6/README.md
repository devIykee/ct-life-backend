# Phase 4-6 contract proposal (FE → devIykee)

2026-10-08. Prepared by the frontend so the Unity client and devIykee's backend can build Phases 4-6 in
parallel. Read against **ct-life-backend `main` @ `9f3e5ef`** (fetched 2026-10-08, no newer commits) and the
synced `contract/` (rc1 + "Unreleased" registries). Nothing here is merged, and no backend file was edited.

**Verification status.** The validation results below come from running the tools. External facts (Metaplex
Core, X OAuth/policy/pricing, Helius DAS) were checked on their official pages on 2026-10-07/08. Statements
that rest on reading source code without running it are labelled [Inference]. Statements I could not
confirm are labelled [Unverified]. Prices, limits and thresholds in examples are placeholders for the economy
sheet, not decisions.

| File | What it is |
| --- | --- |
| `openapi-additions.yaml` | 88 operations, 112 schemas, 1 parameter and 4 responses, as an OpenAPI 3.1 fragment that `$ref`s rc1 components |
| `realtime-additions.ts` | 3 state classes, 21 server→client messages, enum values to append. Drop-in for `contract/realtime/` |
| `ids-additions.json` | Append-only registry entries: 17 error codes, 11 events, 24 toasts, 3 venues, boards, kick reasons, ad slots, and 8 new registries |
| `merge.mjs` | Reproducible merge into rc1, plus ref, operationId and error-code checks |

## Summary

"On main" means the route already exists in your server but not in the contract. Its shape here follows
your code, and any change I propose is spelled out in that operation's `description`. "New" means neither
the contract nor main has it. 29 of the 88 operations are on main and 59 are new.

| # | Feature | Ph | REST (on main / **new**) | Realtime (city unless noted) | IDs |
| --- | --- | --- | --- | --- | --- |
| 29 | Career progression, gigs | 4 | **`GET /careers/{careerId}`**, **`POST /gigs/{gigId}/start`**, **`POST /gig-runs/{runId}/complete`** | — | — |
| 30 | Businesses and bad days (buy/collect/sell) | 4 | `POST /businesses`, `GET /businesses/{id}`, `POST /businesses/{id}/run` (= collect); **`GET /me/businesses`**, **`POST /businesses/{id}/sell`** | `business_day` | `business_events.json` (new), toasts |
| 31 | Home visits, rent, furniture | 4 | **`GET /me/home`**, **`POST /me/home/rent-payments`**, **`PATCH /me/home/settings`**, **`PUT /me/home/layout`**, **`GET /furniture/catalog`**, **`POST /furniture/purchase`**, **`GET /me/furniture`** (visit = rc1 `POST /homes/{ownerId}/visit`) | `rent_update`, `home_visit`; `HomeDecorState` + `FurnitureState` (append `decor` to `HomeState`) | `furniture.json` (new), kick `home_closed` |
| 32 | Sunday Unlock share card | 4 | **`GET /me/weekly-recap`** | `sunday_unlock`; events `evt_sunday_unlock`, `evt_meta_rotated` | toasts |
| 34 | Cosmetic NFTs (Metaplex Core, real money only) | 4 | **`GET /nft/catalog`**, **`GET /nft/orders/{intentId}`** (buy = rc1 `POST /payments/intents {kind: cosmetic}`) | `nft_order_update` | toast |
| — | NFT gallery (images and moderation flag) | 4 | **`GET /nft/gallery`**, **`PUT /me/gallery`**, **`POST /me/gallery/refresh`** | gallery in `HomeDecorState` | — |
| 35 | Seasons and season pass | 4 | **`GET /seasons/current`**, **`GET /season-pass`**, `POST /season-pass/claim` (buy = rc1 intent `kind: season_pass`) | `pass_perk` | `season_pass_perks.json` (new) |
| 36 | Ads booking details | 5 | `GET /ads/bookings`; **`GET /ads/bookings/{id}`**, **`POST /ads/bookings/{id}/cancel`**, **`GET /ads/slots/{slotId}/availability`** | `ad_booking_update`, `ads_changed` | `ad_rejection_reasons.json` (new), booth/branded-venue slots, `conference_hall` |
| 37 | Player projects (create/hire/fund/launch), HQ | 5 | `POST /projects`, `GET /projects/{id}`, `POST /projects/{id}/launch`; **`GET /projects`**, **`POST /projects/{id}/fund`**, **`POST /projects/{id}/offers`**, **`GET /me/project-offers`**, **`POST /project-offers/{offerId}/accept`** and **`/decline`**, **`DELETE /projects/{id}/members/{userId}`**, **`GET /projects/{id}/launch-quote`**, **`GET /projects/{id}/events`**, **`POST /projects/{id}/hq/visit`**, **`PUT /projects/{id}/hq/layout`** | `hire_offer`, `project_event`; `project_hq` room with `HqState`; events `evt_project_*` | `project_events.json` (new), `hackathon_house` |
| 37 | VC Row | 5 | **`GET /projects/{id}/vc-offers`**, **`POST /vc-offers/{offerId}/accept`** and **`/decline`**, **`GET /vc-row/deals`** | `vc_offer`; event `evt_vc_dump` | — |
| 38 | Tribes and district control | 6 | `GET /tribes`, `GET /tribes/{id}`, `GET /districts`, `GET /districts/{id}`; **`GET /districts/{id}/standings`** | `district_flipped`; event `evt_district_flip` | `districts.json` (new) |
| 39 | Leagues and seasons | 6 | `GET /leagues`, `GET /leagues/{slug}`, `GET /me/league`; **`GET /me/season-results`** | `season_rollover`, `league_result` | toasts |
| 40 | CT Beef (challenge/accept/vote/Elo) | 6 | `POST /beef`, `POST /beef/{id}/accept`, `/decline`, `GET /beef/elo`; **`GET /beef`**, **`GET /beef/{id}`**, **`POST /beef/{id}/cancel`**, **`POST /beef/{id}/votes`** | `beef_challenge`, `beef_update` (also on `ratio_arena` venues), `beef_result` | `beef_topics.json` (new), board `beef_elo` |
| 41 | Airdrop Farm and Sybil Barn | 6 | `POST /airdrop/claim`, `GET /airdrop/claims`; **`GET /airdrop/farm`**, **`GET /me/sybil-status`**, **`POST /me/sybil-status/bail`**, **`GET /sybil-barn`** | `sybil_status`; event `evt_sybil_sweep`; kick `sybil_jailed` | `sybil_reasons.json` (new), `sybil_barn` venue |
| 42 | Dubai Marina, Cabal Lounge (invites, net-worth gates) | 6 | `GET /cabal/invites`, `POST /cabal/invites`, `POST /cabal/invites/{id}/accept`; **`GET /venues/{venueId}/access`**, **`GET /me/cabal`**, **`POST /cabal/invites/{id}/revoke`** | `cabal_invite`; join rejections `NET_WORTH_TOO_LOW`, `INVITE_REQUIRED`, `SYBIL_JAILED` | errors |
| 43 | LLM chat (AI Agent, Sleuth) | 6 | `POST /llm/chat`; **`GET /llm/quota`** | — | errors `LLM_DISABLED` |
| 44 | Verified X link | 6 | `GET /x/link`, `GET /x/link/start`, `GET /x/link/callback`; **`DELETE /x/link`** | `x_link_update` | errors `X_LINK_DISABLED`, `X_ACCOUNT_ALREADY_LINKED` |
| 21 | Smart Money copy trading | 2 | `POST /me/smart-money`; **`GET /smart-money/traders`**, **`GET/POST /copy-subscriptions`**, **`PATCH/DELETE /copy-subscriptions/{id}`**, **`GET /copy-subscriptions/{id}/trades`** | `copy_trade` | — |

Item 33 (cosmetics shop) is already in rc1 (`/shop`, `/shop/purchase`, `/inventory`, `PATCH /characters/me/look`)
and needs no new operations. Its drift from main is listed under "Server observations".

Conventions used everywhere: `x-phase`, `Idempotency-Key` on every POST/PUT/PATCH/DELETE, the rc1 error
envelope and codes, `Cursor` pagination with `nextCursor`, list bodies wrapped in an object (as your new routes
already return them, e.g. `{tribes}`), `201` only where a POST creates a resource (as main does), an example on
every response, every money field `integer/int64` in cents (token amounts are base-unit strings), named schemas
only (no anonymous codegen names), no `const: true`, and 3.1 nullables (`type: [x, 'null']`, or `anyOf` with
`{type: 'null'}` for refs). Nullable *enums* are written as nullable strings with the values listed in the
description, because openapi-generator 7.25.0 `csharp` turned a nullable enum into a non-nullable C# enum
(seen in generated `VenueAccess.cs`). [Inference] That property would fail to deserialize JSON `null`.

## Breaking changes

**None.** `merge.mjs` refuses any collision: no rc1 path+method, schema, parameter or response name is
redefined. Every registry entry is new, and the `ajv` check found no id reused. The changes below touch
existing rc1 items and are still additive by `contract/CHANGELOG.md`'s own rule (new optional field, new enum
value, new message, new code). They are not in the YAML because the merge only adds, so please apply them by
hand:

1. `POST /payments/intents`: `kind: cosmetic` also accepts NFT skus from `GET /nft/catalog`. It returns `409 CONFLICT {reason: 'sold_out'}` when an edition is exhausted. `PaymentIntent` gains an optional `cluster: devnet | mainnet` (FE feedback #20).
2. `POST /ads/bookings`: optional `startsAt` (defaults to `nextFreeAt`). An overlapping window returns `409 CONFLICT {reason: 'slot_unavailable'}`.
3. `POST /reports` `targetType`: add `nft`, `npc_reply`, `project`, `beef`.
4. `GET /leaderboards/{boardId}` `boardId`: add `beef_elo`.
5. `PublicProfile`: optional `xLink {xHandle, xAvatarUrl, verifiedAt}` and `leagueId`. `Me`: optional `sybil` (`SybilStatus`), replacing main's `isSybilJailed` and `sybilJailedAt` on `/me`.
6. `GET /careers` items: optional `phase`, `eligible` (see `CareerDetail`).
7. `ConfigResponse.degraded` documented values: add `nft_gallery_external`, `copy_trading`, `beef_voting`, `x_link`.
8. `AdSlot.kind`: add `booth`, `branded_venue`. `venues.json` entries: optional `gated` (see `_gatedExisting`).
9. Realtime: append `EVENT_ID_ADDITIONS` to `EventMessage.eventId`, append `REJECTED_CODE_ADDITIONS` to `RejectedMessage.code`, append `decor` to `HomeState`, add the `project_hq` room, and also send `toast` on `city` (FE feedback #17).

Some proposals change routes that exist **on main but not in the contract** (beef `decline` semantics, the
Cabal invite body, project hiring by offer, the LLM 429, unauthenticated X callback). They break nothing in the
contract, but they need server work. Each one says so in its `description`.

## Open design questions for devIykee

- **B1 Business model.** `config/businesses.json` sells `kols_agency | audit_firm | memecoin_lab | lounge` with `costCents` and income ranges. `businesses.ts` uses `lemonade_stand…arcade` with weekly rent and in-code tables. The YAML follows the config, so which do you want? Also: if a day is skipped, does its income accrue (worker) or is it lost (current)? And what resale share and ownership cap should apply?
- **B2 Gig pay.** `POST /gigs/{gigId}/run` pays from client-sent `distanceKm`, `clicks`, `hoursOnline`… and any client can send the maximum. I propose server-issued runs (start → complete with a capped score) like shifts. Keep `/run` for now?
- **B3 Rent paths.** rc1 `POST /homes/{homeId}/rent` = "sign a lease for home kind". Main uses it to pay rent on a home *instance*, and `POST /homes` to create a lease. Proposal: rc1 meaning for moving home, and the new `POST /me/home/rent-payments` for paying. Main's `POST /homes/{ownerId}/visit` takes a home id and returns a visit row, not rc1's `{roomId}`. There is no `home` room in `server/realtime/main.ts` yet.
- **B4 Season pass price.** The spec says 5 USDC (a revenue line). Main debits $5 **Cash** in `POST /season-pass/buy`. Proposal: buy only through `POST /payments/intents {kind: season_pass}`.
- **B5 One season clock.** Main uses ISO weeks for leagues and tribe changes, 90 days for the pass, and `leagues.json` says `seasonLengthDays: 30`. So "once per season" tribe change is currently once per week. Proposal: one `seasonId` from `GET /seasons/current` for all three.
- **B6 Projects.** `POST /projects/{id}/hire` adds a player and pays them without their consent, and payroll comes from the founder's Cash. Proposal: offers the invitee accepts, plus a project treasury (`/fund`). Also wanted: limits (projects per player) and the risk-roll odds per event.
- **B7 HQ access.** Should the HQ be open to visitors while a member is inside, or members only (needs a flag)?
- **B8 Ad refunds (real money).** Rejected after payment → refund in the paid currency, full amount, from the treasury? And a transfer that lands after `cancel`? This needs your on-chain refund path, and the FE only displays `refund.status`.
- **B9 NFT mint failure.** If the paid mint fails, the server retries, then refunds. Same refund question as B8. Which payer key mints on mainnet vs devnet?
- **B10 External NFTs in the gallery.** Showing arbitrary wallet NFTs needs image proxying and moderation (pending until approved; owner-only before). Ship `ct_life` assets only first, with external assets behind `nft_gallery_external`?
- **B11 Districts.** Main seeds one district per tribe home turf (incl. `anywhere`, `marina_villa`, `cabal_lounge`) and scores only in-game feed posts. That rewards spam and is not on the map. Proposal: the 5 map districts in `districts.json`, scored from venue presence-minutes, trades and shifts done there, and beef wins (capped per player per day). Do you want a different input mix?
- **B12 Beef voting.** Hide live tallies until close (proposed)? What eligibility do voters need (min account age or level), how long are the voting and live phases, and what is the draw rule? What about a timeout for an invited player who never answers (`expired`)? Settlement by votes replaces the manual `settle`.
- **B13 Sybil bail.** Bail is a spec Cash sink, but buying out of a real multi-account jail defeats it. Proposal: only game-rolled jail is bailable. Should the barn roster show aliases or only a count?
- **B14 X link.** X says the auth code is valid **30 s** and `redirect_uri` must exactly match a registered URL. [Unverified] X's docs do not say whether custom-scheme (app) redirects are accepted. Proposal: X redirects to the API callback (unauthenticated, bound by single-use `state`), and the API exchanges at once and then 302s to an https app link. Main stores only token *hashes*, so it can never refresh the handle or avatar. X's policy asks that stored data be kept current and deleted within 24 h of a deletion request. Store an encrypted refresh token (`offline.access`) or re-verify periodically? [Unverified for `/2/users/me` specifically] X's pricing page lists "User: Read" at $0.010 per resource, pay-per-use, so refresh cadence costs money.
- **B15 LLM chat.** Return 429 `RATE_LIMITED` instead of a 200 refusal string? Add a per-day cap for cost (50 in the example)? Should replies be visible to other players in the venue (an NPC speech bubble), or private as now?
- **B16 Copy trading.** Should the copied trader earn a Cash fee (a sink/faucet question)? Is the minimum delay before copying (anti front-running) the next tick?
- **B17 Status codes.** rc1 says 200 for creates. Main returns 201 (`POST /characters`, `/perps`, all new routes). I used 201 for new resources. Pick one rule for the contract.

## Server observations that affect the contract (main @ 9f3e5ef, read-only)

[Inference] These come from reading source. Nothing was executed against them unless stated.

1. **Security: `POST /v1/beef/:id/settle` has no admin check** (`server/api/routes/ratio-arena.ts`). Any signed-in player can settle an active match and name the winner, who is paid both stakes minus 5%.
2. **Security: Cabal invites.** `GET /v1/cabal/invites` with no filter returns every invite including its bearer `code`, and `POST /v1/cabal/invites/:id/accept` accepts for any caller who has the id. Anyone can create invites, and there is no net-worth gate for hosts.
3. **Spec compliance: `POST /v1/nft/mint`** mints for any `cosmetic_inventory` row, including Cash-bought (`source: 'shop'`) items. That would turn Cash into a transferable asset, against "Cash can never be converted into anything transferable" and "cosmetic NFTs can only be bought with real money". It is still synthetic (no chain call), so there is no live exposure yet.
4. **`x_links` placeholder collision.** `startXLink` inserts `x_user_id = '0'` for a pending link, and `x_user_id` is `UNIQUE`. A second player starting a link while another link is pending should hit a unique violation (500), because the upsert only handles conflicts on `user_id`.
5. **Your `openapi-vs-errors` check will reject new REST-only codes.** Its regex `code:\s*"?CODE"?` does not match single-quoted YAML (`code: 'X'`, which your prettier `singleQuote` produces). rc1 passes only because every rc1 code is also in the `RejectedMessage` enum. Suggested fix: `code:\s*['"]?CODE['"]?`. `merge.mjs` runs the corrected check.
6. **Codes emitted but not registered:** `CONFLICT`, `INTERNAL_ERROR`, `LLM_DISABLED`, `X_LINK_DISABLED` (REST) and `SPEED_EXCEEDED`, `OUT_OF_BOUNDS`, `SPOT_NOT_FOUND`, `NPC_NOT_FOUND`, `UNKNOWN_EMOTE` (realtime). All are in `ids-additions.json`. Phase 4-6 services also report insufficient Cash as `VALIDATION_FAILED` or `FORBIDDEN`, not `INSUFFICIENT_CASH`.
7. **61 of the 135 registered `/v1` routes have no matching rc1 operation** (method + path, counted from `server/api/routes/*.ts`), although `docs/PROGRESS.md` M8 says "No contract changes since rc1". Some are Phase 2-3 drift outside this proposal's scope (`POST /feed/posts` vs rc1 `POST /feed`, `POST /predictions`, `POST /market/launchpad…`, `POST /payments/intents/{id}/submitted`, `POST /ore/stake/submitted`, `POST /video-calls/{id}/end`, `POST /spaces/{id}/speakers/{userId}`, `POST /webhooks/helius-program`). The client-facing Phase 4-6 ones are in the YAML. Not proposed, because they are admin-only or superseded: `POST /homes`, `GET /homes/{id}` (exposes visitor ids), `POST /homes/{id}/marina/visit` (→ `GET /venues/{venueId}/access`), `POST /nft/mint` and `GET /nft/inventory` (→ catalog, orders, gallery), `POST /season-pass/buy` and `GET /season-pass/me` (→ `GET /season-pass`), `GET /tribes/{id}/districts`, `GET /districts/{id}/owner`, `POST /me/tribe` (rc1 has `PATCH /characters/me/tribe`), `POST /beef/{id}/settle`, `GET /creator/{handle}`, `PATCH /creator`, `GET /tips`, `GET /video-calls`, `GET /spaces/{id}/speakers`, `/v1/admin/meta`, `/v1/admin/ads/bookings/{id}/approve|reject` (rc1 has `/admin/ads/approve`), `/v1/admin/users/{id}/sybil_jail`.
8. Route headers list `GET /v1/beef` and `GET /v1/beef/:id`, but they are not registered. `POST /ads/bookings` on main creates no payment intent (rc1 returns `{bookingId, intent}`). `GET /ads/live` returns `imageKey`, not an image URL.

## Validation

Everything ran on 2026-10-08 in a scratch directory. No backend or client files were written.

| Check | Tool (version verified on its registry) | Result |
| --- | --- | --- |
| Merge into rc1 `contract/openapi.yaml` | `merge.mjs` with `yaml` 2.9.1 (npm latest, published 2026-09-11) | +88 operations, +117 components, 0 collisions. 178 unique operationIds. All refs resolve. Every error code used is registered, and every proposed code is referenced |
| OpenAPI 3.1 lint, merged | `@redocly/cli` **2.60.0** (npm latest, published 2026-10-07), built-in `recommended` ruleset | **0 errors and 0 warnings from the additions.** The merged file shows 11 errors and 60 warnings, identical to rc1 alone (baseline run first): all 11 errors are rc1's OpenAPI 3.0 `nullable: true` (`struct`) |
| Same, with rc1's 12 `nullable` converted to 3.1 (`--fix-nullable`, output only) | same | **Valid** ("Your API description is valid"), warnings only, all in rc1 |
| C# models from the merged spec | openapi-generator-cli 7.25.0 (the FE's pinned jar, sha1 checked), the FE's exact flags | 219 models (rc1: 107), no generator warnings, no anonymous models from the additions |
| Compile those models | Unity 6000.3.25f1 Roslyn `csc` against .NET Standard 2.1 + Newtonsoft (after the FE's `patch_rest_codegen.py`) | Compiles. The 26 patched files are all rc1's, and no addition needed a patch |
| `realtime-additions.ts` typecheck | TypeScript 5.9.3, `@colyseus/schema` 5.0.36, `zod` 4 from your `node_modules`, your `tsconfig.base.json` + `useDefineForClassFields: false` | `tsc` OK |
| Realtime runtime round trip | `tsx` + `@colyseus/schema` `Encoder` → `Reflection.decode` | `HqState` with players, decor, furniture and gallery encodes (194 bytes) and decodes intact |
| C# realtime states | `schema-codegen` 5.0.36 (the FE's `codegen_realtime.sh` toolchain) | `FurnitureState.cs`, `HomeDecorState.cs`, `HqState.cs` generated |
| Registries | `ajv` (your pinned version) against `contract/ids/ids.schema.json` | `ids-additions.json` and all 8 new registries valid. No new id reuses an existing one |

To reproduce from the backend repo root (it already depends on `yaml`):

```sh
P=../ct-life/docs/fe-contract-proposals/phase4-6
node $P/merge.mjs contract/openapi.yaml $P/openapi-additions.yaml /tmp/merged.yaml
npx -y @redocly/cli@2.60.0 lint /tmp/merged.yaml            # 11 errors, all rc1 nullable
node $P/merge.mjs contract/openapi.yaml $P/openapi-additions.yaml /tmp/merged-fixed.yaml --fix-nullable
npx -y @redocly/cli@2.60.0 lint /tmp/merged-fixed.yaml      # valid
```

[Unverified] How the Colyseus 0.18 Unity SDK surfaces an `onAuth` rejection reason to the client. The proposal
says the join fails with the contract code as its message, and the FE calls `GET /venues/{venueId}/access`
first either way.

## Sources (opened 2026-10-07/08)

- Metaplex Core, create asset (payer may mint to a different `owner`; ~0.0015 SOL rent + 0.0015 SOL protocol fee ≈ 0.003 SOL): https://metaplex.com/docs/core/create-asset. npm `@metaplex-foundation/mpl-core` latest is 1.10.0.
- X OAuth 2.0 PKCE (30 s auth code, exact callback match, 2 h access token unless `offline.access`): https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- X scope mapping (`GET /2/users/me` → `tweet.read users.read`): https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping
- X Developer Policy (identity display, current data, 24 h deletion, no compensation for X actions): https://docs.x.com/developer-terms/policy
- X API pricing (pay-per-use; "User: Read $0.010 per resource"): https://docs.x.com/x-api/getting-started/pricing
- Helius DAS `getAssetsByOwner` (interfaces incl. `MplCoreAsset`, `content.files[].cdn_uri`, `grouping` by collection): https://www.helius.dev/docs/api-reference/das/getassetsbyowner
- Spec: `docs/spec/build-spec.md` (Projects, Economy, Feature list Phases 4-6), `docs/spec/contract.md`; FE feedback `docs/progress/backend-dev-feedback.md`.
