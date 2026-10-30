## 2026-10-30 - VC Row: NPC term sheets, deals, dump at unlock (unlock WP-B B2, migration 1700000121000)

Behind the `vc` capability (`503 CAPABILITY_OFF {capability: 'vc'}` until it is in `CAPABILITIES_ON`). No VC Cash ever reaches a player.

- New: `GET /projects/{id}/vc-offers` (founder) → `{offers: [VcOffer]}`, `POST /vc-offers/{offerId}/accept|decline` → `VcOffer`. `VcOffer = {offerId, projectId, vcArchetypeId, investCents, equityBps, unlockAt, status, expiresAt}`. Errors: 403 `not_owner`; 409 `not_pending` | `expired` | `wrong_status`.
- Changed: `GET /vc-row/deals` is now behind `vc`, takes `cursor` and `limit` (default 20), and pages with `nextCursor`; `status` is `active | unlocked | dumped`.
- `GET /projects/{id}` `vcStakes` is filled: `[{vcArchetypeId, equityBps, investedCents, unlockAt}]` for deals not yet dumped.
- Worker: a daily generator gives live projects under a $5,000 treasury 1-3 term sheets a week (value = 50% of the coin market cap, 8-18% equity, $200-$5,000, 24 h to answer). Accepting puts the money in the project treasury (an NPC faucet that only feeds sinks) and opens a deal that unlocks in 7 days. After unlock the VC dumps 1.5x its stake (capped at -30%) without being front-runnable (security review H2): only the unlock day is published (`unlockAt` is 00:00 UTC), the dump starts at a hidden random time within 72 h, bleeds out in 24 small steps over up to 12 h, and `proj_vc_dump` and world event `evt_vc_dump {projectId, name, coinId}` (new id in `ids/events.json`) go out only when it ends. `POST /perps` answers `409 CONFLICT {reason: 'perp_entry_frozen'}` on that coin from 24 h before unlock until the bleed ends. New event ids `proj_vc_invested`, `proj_vc_unlocked`, `proj_vc_dump`.
- Realtime (city): `vc_offer` (founder).

## 2026-10-30 - Paid calls on the ct_escrow program and creator mode (unlock C2)

Migration 131 (`paid_calls`, `creator_profiles` mode columns). Dark until the operator adds `paidCalls` and `creatorMode` to `CAPABILITIES_ON`; devnet only; needs the escrow upgraded and initialized (docs/ONCHAIN.md "Paid-call escrow on devnet").

- `PUT /creator {enabled, ratePerMinUsdc: '250000'..'50000000', maxMinutes: 1..60}` now works and answers `{enabled, ratePerMinUsdc, maxMinutes}` (was documented, not served). `400 VALIDATION_FAILED {reason: rate_out_of_range | max_minutes}`. Capability `creatorMode`.
- `GET /users/{id}` gains `creator: {enabled, ratePerMinUsdc, maxMinutes} | null`.
- `POST /paid-calls {creatorId, minutes}` answers `201 {callId, sessionPda, tx, amount, feeBps, ratePerMinUsdc, minutes, expiresAt}`: `tx` is the server-built unsigned v0 `open_session` (fan pays). Was `{payeeUserId, pricePerMinuteCents, maxMinutes}` with no transaction. New error `CREATOR_UNAVAILABLE` (403); `409 CONFLICT {reason: call_in_progress}`; `400 {reason: minutes_over_max | cannot_call_self}`; `403 BLOCKED`.
- `POST /paid-calls/{id}/submitted {signature}` verifies the Session account and the reported transaction on chain (confirmed, successful, fan-signed `open_session` of this PDA) before storing it (`409 {reason: not_found_yet}`, `400 {reason: tx_mismatch}`, `409 {reason: call_in_progress, who: creator}` with the call refunded) and rings the creator: `call_invite` gains optional `kind: 'paid'`, `ratePerMinUsdc`, `maxMinutes`, `acceptBy`.
- `accept` sends the escrow `accept` with the settle authority; then `POST /rtc/token {kind: 'paid_call'}` works for both players. `decline` answers `refunding` (the refund lands after the accept window). `POST /paid-calls/{id}/end` takes **no body**: the server times the call and settles on chain. `PaidCall` gains `settling`, `refunding`, `expired`, `closed_unknown` statuses, the terms, the split, `acceptBy`, `endReason` and the signatures.
- New `POST /webhooks/livekit` (LiveKit signed webhook): a participant leaving or the room finishing ends a live paid call.
- A 15-second worker refunds unanswered/declined calls, ends calls at their booked minutes and retries settles.

## 2026-10-30 - Farm: Sybil jail, bail and the Sybil Barn (unlock A5)

Migration 111 (`sybil_jail`). New config `config/sybil_reasons.json`. Capabilities `sybilBail` (bail, and the game roll itself) and `sybilBarn`.

- Game-rolled jail: while `sybilBail` is on, every `POST /airdrop/claim` attempt that reaches the server is counted per player for an hour. At 5 / 10 / 20 attempts a CSPRNG roll at 20% / 50% / 100% jails for 2 / 6 / 12 h (`sybil_claim_spam`, `sybil_bot_pattern`, `sybil_clone_farm`). The attempt that is jailed is refused. Release is lazy (on read).
- `POST /airdrop/claim` while jailed (admin or game) now answers `403 SYBIL_JAILED {releaseAt, reasonId}` (new error code; it was `403 FORBIDDEN {reason: sybil_jailed}`, which clients already map).
- `GET /me/sybil-status` fills `releaseAt`, `reasonId`, `bailCents`, `bailable` and adds `source: game | admin | null`. Admin jails stay unbailable with `reasonId: sybil_admin_review`.
- New `POST /me/sybil-status/bail` -> the status (`jailed: false`). Bail = farm yield per started hour still to serve, clamped to $5-$150; ledger `sybil_bail`, a sink (Cash never moves to another player). `402 INSUFFICIENT_CASH {have, need}`, `409 CONFLICT {reason: not_jailed | not_bailable}`.
- New `GET /sybil-barn` -> `{count, inmates: [{userId, alias, reasonId, jailedAt, releaseAt}] (game stays, <= 50, no anon), nextCursor: null}`.
- `GET /venues/sybil_barn/access` also admits game-jailed players.
- New user message `sybil_status` (the status with `jailedAt`/`releaseAt` as epoch ms, plus `at`; `bailPaidCents` after a bail).

## 2026-10-30 - Prediction Pit: real markets and a recorded-source resolver (unlock D3, app `predict`)

Migration 141. Contract and rules in `docs/PREDICTIONS.md`. Routes dark until `predict` is in `CAPABILITIES_ON`; markets open and settle only with `PREDICTIONS_SETTLEMENT_ENABLED=1` (workers).

- New `GET /predictions/markets?status=open|closed|resolved|void&cursor=` -> `{markets: [PredictionMarket], nextCursor}` and `POST /predictions/markets/{marketId}/bets {outcomeId, stakeCents}` (Idempotency-Key) -> `201 PredictionBet {predictionId, marketId, outcomeId, stakeCents, potentialPayoutCents, status, closesAt, createdAt}`. Errors: `400 VALIDATION_FAILED {reason: unknown_outcome | stake_out_of_range}`, `402 INSUFFICIENT_CASH`, `403 AGE_REQUIRED`, `404 NOT_FOUND`, `409 CONFLICT {reason: market_closed}`, `429 RATE_LIMITED {reason: daily_stake_cap, resetAt}`, `403 JAILED`.
- `GET /predictions` (unwrapped array) gains `marketId, questionKey, params, resolvedOutcomeId, payoutCents`. `POST /predictions` -> `410 GONE {reason: use_market_bets}`; open legacy bets are refunded once their `closes_at` passes.
- Markets: `sim` (`sim_call`, 5m/15m/1h) and `event` (off by default) are sealed commit-reveal draws (`fairness {commitment, seed}`: sha256 public at open, secret at resolution, each outcome 1/2) because house-coin trends are public; `crypto` (BTCUSDT/SOLUSDT 24 h, only with `PREDICTIONS_CRYPTO_SOURCE` = `binance` or `binance_vision`; default `off`). Strike recorded at open, short bet window, outcome decided once from a value recorded at `resolvesAt`; void (refund) when the source is missing past the grace period.
- House-banked fixed odds: win = stake x `payoutBps` / 10000 (1.9x), daily stake cap per player. The coin-flip `resolveOutcome` stub is gone.
- Realtime `prediction_settled {predictionId, marketId, status, payoutCents}` to the player.
- New config `contract/config/predictions.json`; new env `PREDICTIONS_CRYPTO_SOURCE`.

## 2026-10-30 - Builder: role offers, treasury, launch, game-paid payroll (unlock WP-B B1, migration 1700000120000)

Behind the `builder` capability (`503 CAPABILITY_OFF` until it is in `CAPABILITIES_ON`). Keeps the rule that Cash never moves between players.

- New: `POST /projects/{id}/offers`, `POST /project-offers/{offerId}/accept|decline`, `POST /projects/{id}/fund` (`{project}`), `DELETE /projects/{id}/members/{userId}` (204), `GET /projects/{id}/launch-quote`, `GET /projects/{id}/events?cursor&limit`, `POST /projects/{id}/tasks` and `POST /projects/{id}/tasks/{taskId}/complete` (a 10-minute project task; the only work that earns a wage). Shapes and every `details.reason` in `openapi.yaml` (tag `projects`).
- Changed: `POST /projects/{id}/launch` now takes `{ticker, quotedCostCents}`, debits the treasury, lists a coin on the in-game launchpad and returns `ProjectSummary` with `status: live` and `coinId` (was a `founded -> launching` flip). Broadcasts `evt_project_launch` (new id in `ids/events.json`).
- Removed: `POST /projects/{id}/hire` answers `410 GONE {reason: 'use_offers'}` (it paid the hire from the founder without consent). Not gated: the old route breaks the Cash rule.
- Additive: `ProjectSummary` (POST/GET `/projects`) gains `name`, `ticker`, `ownerAlias`, `memberCount`, `treasuryCents`, `coinId`, `openRoles`; `cashCents` stays. `GET /projects/{id}` gains `members`, `payrollCentsPerWeek`, `nextPayrollAt`, `vcStakes`, `recentEvents`; `hires` stays.
- Wages: fixed weekly bands per role (`contract/config/projects.json`: dev/auditor $150-$300, kol $100-$200, mod $80-$150), paid by the game every Monday 00:00 UTC only for a week the member finished a project task for that project (generic career shifts do not count), prorated for a mid-week join, one paid role per player per week, capped at $600 a project and $900 a founder a week. Wages never depend on the treasury, so founder deposits cannot become anyone's wage. The treasury pays an operating cost equal to the wages (a pure sink); if it is short it pays what it has and the project is `paused` (funding resumes it). Per-account limit: 2 projects, founder roles included (`409 CONFLICT {reason: 'project_limit'}` on `POST /projects` and on accept). Legacy direct hires become pending offers the player must accept. Daily risk roll for live projects (exploit, rug accusation, audit passed) with a treasury loss and a launchpad price shock.
- Realtime (city): `hire_offer` (invitee) and `project_event` (every member).
- `GET /config` gains `projects` (null while `builder` is off): `{version, wages: {role: {minCentsPerWeek, maxCentsPerWeek}}, taskMinutes, maxRolesPerPlayer, maxProjectsPerPlayer, offerTtlHours, builderDiscountBps, minProjectAgeMinutes}`.
- `GET /projects/{id}` gains `myTask: {taskId, startedAt, endsAt} | null` and `workedThisWeek` for the caller.
- Reasons: a founder starting a task gets `403 {reason: 'founder_no_wage'}`; removing the founder gets `409 {reason: 'cannot_remove_founder'}`. `POST /projects/{id}/launch` answers `403 JAILED` for a jailed founder.

## 2026-10-30 - Devnet test tokens: daily SOL drip and the "Get test tokens" card (unlock WP-C)

Migration 130 (`devnet_drips`). Dark until the operator adds `devnetDrip` to `CAPABILITIES_ON` and sets `DEVNET_DRIP_KEYPAIR`; devnet only.

- `GET /config` `capabilities.features` gains `devnetDrip` (appended).
- New `GET /devnet/test-tokens` → `{cluster: 'devnet', wallet, usdc {faucetUrl: 'https://faucet.circle.com/', mint, perRequestBaseUnits: '20000000', everyHours: 2}, sol {dripLamports, available, reason: unconfigured | claimed_today | budget_spent | null, nextAt}}`.
- New `POST /devnet/drip` (Idempotency-Key) → `{dripId, signature, lamports, wallet, nextAt}`: 0.02 SOL from the ops treasury, once per wallet and account per UTC day, never while the wallet holds 0.05 SOL, inside a global daily budget. `409 CONFLICT {reason: balance_sufficient}`, `429 RATE_LIMITED {reason: daily_drip | drip_budget, nextAt}`, `503 CAPABILITY_OFF {reason: drip_unconfigured | treasury_low | rpc_not_devnet | devnet_only}`, `503 SERVER_BUSY {reason: drip_send_failed}`.
- New env: `DEVNET_DRIP_KEYPAIR`, `DEVNET_DRIP_LAMPORTS`, `DEVNET_DRIP_DAILY_CAP_LAMPORTS`.

## 2026-10-30 - X: unlink (unlock A4)

No migration. Capability `xUnlink` (`503 CAPABILITY_OFF` until it is in `CAPABILITIES_ON`).

- New `DELETE /x/link` -> `204`: deletes the verified X link with its handle, avatar and token hashes (and any in-flight start). `404 NOT_FOUND` when nothing is linked. Works with X linking disabled. The X account can then be linked by another player.
- New user message `x_link_update {status: 'unlinked', linked: false, at}` (city room) after an unlink; `status` is what the competition client parses.

## 2026-10-30 - Cabal: targeted invites and revoke (unlock A3)

Migration 110 (`cabal_invites.revoked_at`). Capabilities `cabalInvites` (targeted invites; also turns on `competitionCapabilities.targetedCabalInvites`) and `cabalRevoke`.

- `POST /cabal/invites` takes an optional `{guestUserId}`: the invite is for that player only and the server echoes `guestUserId` (it used to ignore it). `404` unknown player, `400` yourself, `403 BLOCKED` block pair, `409 CONFLICT {reason: already_member | invite_pending}`. `503 CAPABILITY_OFF` while `cabalInvites` is off; open invites keep working.
- Every new invite now checks the host: net worth at the Marina gate (`403 NET_WORTH_TOO_LOW {netWorthCents, requiredNetWorthCents}`, new error code) and at most 3 pending (`409 CONFLICT {reason: invites_exhausted}`). `GET /me/cabal` `invitesRemaining` and `hostGateCents` already described both; neither was enforced.
- New `POST /cabal/invites/{id}/revoke` -> the invite with `status: revoked`. `403 FORBIDDEN {reason: not_host}`, `409 CONFLICT {reason: not_pending}`. `503 CAPABILITY_OFF` while `cabalRevoke` is off.
- `CabalInvite` gains `status` (`pending | accepted | revoked | expired`) and `revokedAt`. `code` is only returned to the host (guests could see it in `GET /cabal/invites`).
- New user message `cabal_invite {inviteId, fromUserId, expiresAt, at}` (epoch ms) to the guest of a targeted invite.
- Fix: accepting checks that a targeted invite is yours (`403 FORBIDDEN {reason: not_guest}`) and refuses revoked invites and block pairs.

## 2026-10-30 - Season pass bought with a payment intent (unlock C1)

No migration. Dark until the operator adds `seasonPassPurchase` to `CAPABILITIES_ON`; devnet only.

- `GET /config` gains `seasonPass {sku: 'season_pass', priceUsdc: '5000000', currency: 'USDC', seasonId, endsAt}`, present only while the capability is on, the deployment is on devnet and a season is running.
- `POST /payments/intents {kind: 'season_pass', sku: 'season_pass', currency: 'USDC'}` returns the usual `PaymentIntent` for 5 USDC (`cashCents: 0`). The `sku` enum gains `season_pass`, valid only with that kind (`400 VALIDATION_FAILED {reason: 'sku_kind_mismatch'}`). `409 CONFLICT` with `reason` `already_active` (live pass), `intent_pending` (an earlier signed pass intent is still being reconciled; `intentId`) or `no_active_season`. `503 CAPABILITY_OFF` while off.
- Settlement verifies the finalized transfer exactly like a top-up, then grants (or extends) the pass until the season's `endsAt`. No Cash moves; `payment_confirmed` carries `kind: 'season_pass'` and `cashCents: 0`.
- `POST /season-pass/buy` (it debited $5 of Cash) now answers `410 GONE {reason: 'buy_with_intent'}`. `GET /season-pass/me` is unchanged.
- Fix: payment reconciliation reads the deployment's own cluster RPC (`HELIUS_RPC_URL_DEVNET` on devnet) instead of the mainnet client.

## 2026-10-30 - Home visitor policy (unlock D2, capability `visitorPolicy`)

Migration 140 (`home_settings`). The settings routes are dark until `visitorPolicy` is in `CAPABILITIES_ON`.

- New `GET /homes/me/settings` -> `{visitors: 'open'|'followers'|'closed'}` (default `open`) and `PUT /homes/me/settings {visitors}` (Idempotency-Key) -> same.
- Enforced in `POST /homes/{ownerId}/visit` and on `home` room join (and the room's re-check): `closed` -> `403 HOME_CLOSED` (everyone but the owner); `followers` -> `403 FORBIDDEN {reason: followers_only}` unless the visitor and the owner follow each other (mutual; a one-way follow is not enough) or the visitor is a guest. Under every policy, `open` included, a visitor the owner blocked or who blocked the owner gets `403 BLOCKED`. The policy only narrows access; the door rule still applies after it. Reading another player's home placements follows the same rule.
- New error code `HOME_CLOSED` (403).

## 2026-10-30 - League: district standings and season results (unlock A2)

No migration. Capabilities `districtStandings` and `seasonResults` (`503 CAPABILITY_OFF` until each is in `CAPABILITIES_ON`).

- New `GET /districts/{id}/standings` -> `{districtId, dayDate, rolloverAt, standings: [{tribeId, score}] (highest first), myTribeId, myContribution}`. Live for today with the rollover's own formula (default holder's base score + player posts/check-ins, at most 3 per player). `myContribution` is null for `anon`. `404 NOT_FOUND` for an unknown district.
- New `GET /me/season-results?seasonId=` -> `{seasonId, leagueId, finalRank, outcome: promoted|relegated|stayed, toLeagueId, rewards: []}`. Latest finished season when `seasonId` is omitted. `404 NOT_FOUND` when there is none, `400` for a malformed id. `rewards` are read from the ledger (`season_reward`); nothing pays one yet.
- Fix: the daily district rollover (00:05 UTC) now rolls the day that just ended. It used to roll the new day, which had five minutes of activity, so every district went back to its default holder.

## 2026-10-30 - Move home in one step (unlock D1, capability `homeMove`)

No migration. Dark until `homeMove` is in `CAPABILITIES_ON` (`503 CAPABILITY_OFF` before that).

- New `POST /homes/move {kind}` (Idempotency-Key) -> `200 {home: LeasedHome, movedOutHomeId: string|null}`. Atomic: the caller's live lease(s) end (`moved_out`, unit freed, guests removed), a unit of the new tier is taken, the first week of the new rent is debited, the new lease starts. Upgrade and downsize work the same way; no refund of the old week; debt stays.
- Errors: `402 INSUFFICIENT_CASH {have, need, shortfallCents}`, `409 CONFLICT {reason: same_home}`, `409 CONFLICT {reason: no_unit_free, tier}`, `403 FORBIDDEN {reason: phase_locked}` (LIVE_PHASE < 4), `400 VALIDATION_FAILED`.
- `POST /homes` (lease without moving) and `POST /homes/{homeId}/rent` are unchanged.

## 2026-10-30 - Recent world events: GET /events/active (unlock A1)

No migration. Capability `worldEvents` (off until the operator adds it to `CAPABILITIES_ON`; `503 CAPABILITY_OFF` until then).

- `GET /events/active` now answers `{events: [{eventId, at, params}]}`: the `evt_*` world events broadcast in the last 2 hours, newest first, at most 50; `at` is epoch ms (the same value as the realtime `event` message). It used to fall into `GET /events/{slug}` and answer 404. `401` without a token.
- Every world event the server broadcasts is also kept in Redis (`world:events`, trimmed to 2 h and 50 on each write). Market-mood events are kept once per refresh even with several city shards.

## 2026-10-30 - Capabilities in GET /config, CAPABILITY_OFF, mainnet boot guard

Phase 0 of the unlock plan: the switchboard every hidden feature turns on through. No migration. Nothing changes for players until the operator sets `CAPABILITIES_ON`.

- `GET /config` gains `capabilities {version: 2, apps: {beef, builder, vc, predict}, features: {beefVoting, districtStandings, seasonResults, sybilBail, sybilBarn, cabalRevoke, xUnlink, worldEvents, homeMove, visitorPolicy, nftGallery, paidCalls, creatorMode, seasonPassPurchase, factory, projectHq}}` and `competitionCapabilities {version: 1, beefChallenges, targetedCabalInvites}`. Every key is always sent. Values come only from the env `CAPABILITIES_ON` (comma list of names): no code defaults, unknown names ignored and logged at boot, names case-sensitive, empty = all `false`. `beefChallenges` = `apps.beef`; `targetedCabalInvites` is on when `cabalInvites` is listed. Clients treat a missing block or key as off. The ETag follows the list.
- New error code `CAPABILITY_OFF` (503, `details.capability`): a feature route answers it while its capability is off (`assertCapabilityOn` in `server/application/capabilities.ts`, preHandler `requireCapability` in `server/api/middleware/capability.ts`).
- Mainnet boot guard: with `APP_ENV=prod` (Solana mainnet) the API, realtime and workers refuse to start unless `ALLOW_MAINNET=1`.
- `ids/report_reasons.json`: new reason `voice` (the client sends it for voice-chat reports).
- Migration number blocks for the parallel unlock packages (README, Database Migrations): A `1700000110000-1700000119000`, B `…120…129`, C `…130…139`, D `…140…149`.



## 2026-10-30 - Report an AI NPC chat reply

Migration 106.

- `POST /llm/chat` now returns `replyId` (the stored interaction id) and `archetype` alongside `response`. The client already reads `replyId` and shows its Report button only when it is set.
- `POST /reports` accepts `targetType: "npc_reply"` with `targetId` = that `replyId`. Only the player the reply was written for may report it; otherwise `400 VALIDATION_FAILED` with `details.reason: unknown_reply`. The admin queue shows the reply text as the preview, and `remove_content` blanks it.

## 2026-10-30 - Venue voice tokens need presence in the venue

- `POST /rtc/token {kind: "venue", id: <instanceId>}` now mints a token only while the caller has a session in that venue room (the realtime venue room counts sessions in Redis `ctl:venue:members:<instanceId>` on join and leave). Otherwise `403 NOT_IN_VENUE` (`details.instanceId`). The unused `proximity` kind gets the same check. Venue/proximity tokens now last 10 minutes (was 1 h), and when a user's last session leaves the venue room (including a ban kick) the realtime server removes them from `venue:<instanceId>` and `proximity:<instanceId>` in LiveKit. A venue id carrying another kind's prefix is now `400 VALIDATION_FAILED` instead of a 500.
- New error code `NOT_IN_VENUE` (403).
## 2026-10-30 - Alpha calls use the server price; background sweeps start

- `POST /alpha-calls`: the stored `entryMicros` is now the coin's server price at placement (the body's value must still be positive but is ignored), and the call is refused unless `stopMicros < price < targetMicros`: `400 VALIDATION_FAILED` with `details.reason` `price_outside_band` (plus `details.priceMicros`), `unknown_coin` or `coin_dead`. The response's `entryMicros` is the stored server price.
- Perp liquidation (5 s), alpha grading (30 s), the payment poller (30 s) and weekly rent (Monday 00:00 UTC) now run in the workers process. Prediction settlement runs only with `PREDICTIONS_SETTLEMENT_ENABLED=1` (off by default; the resolver is still a dev stub).

## 2026-10-26 - Approved display names (migration 105)

The user approved real, relatable names for everything players see (ct-life-evidence/names/NAMES.md; the client table is `contract/ids/names.json`). Ids, slugs, codes and routes do not change; only display text the server writes or stores.

- **Authors** (migration 105 UPDATEs the rows migration 102 seeded): `city` "CT City" -> "City News"; `sleuth` "The Sleuth" -> "Police" (`SLEUTH_ALIAS` too); callers "Candle Carla" -> "Chart Caller", "Rugwatch Ray" -> "Rug Watcher", "Moonboy Milo" -> "Moon Boy", "Auntie Ape" -> "Ape Auntie". Cosmetics `reward_rekt_burger_uniform` -> "McDonald's Uniform", `reward_s1_airdrop_tee` -> "S1 Season Tee". Old posts that mention a renamed place are rewritten the same way.
- **Generated text:** city cards "liquidated in the Perp Pit" -> "liquidated on Hyperliquid", "in the Rug Room" -> "in the Casino"; venue card name "The Rug Room" -> "Casino"; career posts "Rekt Burger" -> "McDonald's" (and "see you on Hyperliquid"); busted post "CT Jail" -> "Jail"; the six rug exposes are now written as the Police ("Police report on ...", "wanted level" instead of "heat"); `npc_lines.json` "Sleuth ..." -> "Police ...", "Ratio Arena" -> "Debate Arena"; NPC persona "You are Sleuth" -> "You are a Police detective"; tribes "Cabal Lounge" -> "VIP Lounge".
- **Error messages:** "The Rug Room is 18+" -> "The Casino is 18+"; "CT Jail" -> "Jail" (JAILED, NOT_JAILED); the position message "Rekt Burger counter" -> "McDonald's counter".
- **Config display names:** careers "Rug Sleuth" -> "Fraud Investigator", "Rekt Burger" -> "McDonald's", uniform -> "McDonald's Uniform"; season "Airdrop Season" -> "Season 1", "S1 Airdrop Season Tee" -> "S1 Season Tee"; gig "Doot the Feed" -> "Like Posts"; casino note "The Rug Room" -> "Casino"; ledger labels "Duo Shop order/refund" -> "Amazon order/refund"; archetypes "Sleuth" -> "Police", "Town Crier" -> "News Reader".
- **Venue names** in `venues.json` now equal the client's `venue.*` names: Times Square, X Spaces Studio, Starbucks, Hyperliquid, Hospital, ORE Mine, Polymarket, Pump.fun Tower, Debate Arena, VIP Lounge, Discord HQ, Nightclub, Convention Centre, Jail, Barn, Downtown (venue ids unchanged).
- **Trait text the client matches on:** `traits.json` effect "Sleuth NPC pays you for tips" -> "The police pay for your tips" (client already shows this wording; both sides change together).

## 2026-10-26 - Rugpull Factory launches real tokens (Meteora DBC); the Cash Factory is retired

Migration 104. Client contract and setup in `docs/FACTORY-REAL.md`.

- New `POST /factory/launch/prepare` (18+, risk warning accepted, moderated name/ticker/description, re-encoded image; returns a legacy DBC create-pool transaction with the priority fee included and the mint already signed), `POST /factory/launch/confirm` (verifies on chain, registers the token, broadcasts `evt_coin_launch` with `params.real = "1"`), `POST /factory/launch/submit` (fallback: the wallet only signs, the server co-signs the same launch last), `GET /factory/launch/{launchId}`, `GET /factory/tokens`, `GET /factory/tokens/{mint}`, `GET /factory/tokens/{mint}/trades`, public `GET /factory/metadata/{id}`, and the server-to-server `POST /webhooks/helius/factory`.
- `GET /factory/config` now describes real launches (`enabled`, `cluster`, on-chain partner config, `riskWarning`, `ageGate`, limits).
- Retired: `POST /factory/coins` and buying a Cash player coin answer `410 FACTORY_CASH_RETIRED`; selling an old Cash position still works.
- Creator-wallet sells of a launched mint add heat and, for 30%+ of their holding, one exposé post (penalties only).
- New error codes: `FACTORY_CASH_RETIRED` (410), `FACTORY_UNAVAILABLE` (503), `LAUNCH_EXPIRED` (409), `LAUNCH_TX_MISMATCH` (422), `LAUNCH_NOT_CONFIRMED` (409), `RISK_NOT_ACCEPTED` (400).
## 2026-10-26 - Group chats and alpha groups

Migration 103. Full client contract in `docs/GROUPS.md`.

- New `/groups` routes: list (joins your tribe chat), create (`friends` cap 12, `alpha` cap 50; `tribe` chats are automatic, cap 200), info, settings (rules, slow mode), members, remove (bans), roles, leave, mute, read, report (3 reporters hide a group), invite links (`ctlife://invite/<code>`, max uses, expiry) and direct invites, `/invites/{code}` preview, accept (atomic cap) and decline, messages per topic, delete, booths (`/venues/{venueId}/booths`, claim, release).
- Free and invite-only: no entry fee, nothing paid for inviting or posting a link.
- Alpha groups: topics `calls` (owner only; a structured call that becomes a real alpha call with the server price as entry, graded by the existing evaluator, so the Trust score is earned), `chat`, `wins` (needs realized profit on the coin).
- Realtime `group_msg` and `group_invite` (city room, like `dm`); never sent to someone who blocked the author.
- Messages, rules and notes mask links, e-mails, phone numbers and wallet addresses; slow mode per topic; a per-player burst of 10 messages, then one a second.
## 2026-10-26 - Timeline: tabs, action cards, city event cards, NPC callers, check-ins

Migration 102. Full client contract in `docs/TIMELINE.md`.

- `GET /feed` now takes `tab=foryou|following|city`, `type` (City filter: `launch`, `rug`, `liquidation`, `casino_win`) and `before` (cursor), and answers `{posts, nextBefore, quiet}` instead of a bare array. `scope=global|following` still works. For you mixes city cards in at most 1 in every 4 rows; `quiet: true` means nobody posted and the posts are recent city cards. Blocked authors are left out (they were not before).
- `FeedPost` gains `kind` values `caller`, `checkin`, `launch`, `rug`, `liquidation`, `casino_win`, and `isNpc`, `district`, `card` (one action card: `CoinCard` live at read time, `VenueCard`, `ProfileCard`), `secondaryCard`, `verdict` (the Sleuth's box under a coin card) and `social` (launch cards: holders and followed buyers). The timestamp field is `createdAt` (the contract said `at`; the server always sent `createdAt`).
- `POST /feed/posts` (the contract said `POST /feed`) answers 201, takes optional `withPlace`, and builds the card server-side (a real coin's `$TICKER`, or the venue the server places you at).
- `POST /feed/posts` has its own per-player limit: a burst of 3, then one every 20 s (`429 RATE_LIMITED`).
- New `POST /feed/checkins {venueId}`: opt-in, verified against the server's position (60 m from the door), once per 15 minutes (atomic).
- District rollover: each player counts at most 3 posts per district per day.
- New deep links for the client router: `ctlife://coin/<coinId>`, `ctlife://venue/<venueId>`, `ctlife://profile/<userId>`.
- Server: city cards are written after launches, rugs and house-coin deaths, perp liquidations (one per 10 minutes) and 10x+ casino wins (one per 2 minutes); four NPC callers post calls on house coins; the daily district rollover works again (it read a column that did not exist).
## 2026-10-26 - Log privacy: client IPs truncated in request logs

No API change. HTTP request logs now carry only `method`, `path` (no query string) and a truncated client IP (IPv4 /24, IPv6 /48) instead of the full address Fastify logged by default (`trustProxy: true` made it the real client). See `docs/LOGS.md` for what is kept where; the hosting platform's own access-log retention is not controlled by this repo and is still to be checked.
## 2026-10-26 - Moderation: filter, admin report queue, mute and ban, block-aware chat

Migration 101. From POLICY-CHECK.md (user-generated content rules of both stores).

- **Text filter.** `POST /dms/{userId}`, `POST /feed/posts` and `POST /characters` (alias) now answer `400 CONTENT_NOT_ALLOWED` (`details.field`: `dm`, `post` or `alias`) when a word is a slur or strong profanity (leetspeak, repeated letters and spaced-out letters are caught; the check is per word, so "this hit" is fine). Show "That text contains words that are not allowed." and let the player edit. The list is the one the Rugpull Factory already uses, kept in the repo, no new package. Room `say` is not rejected: offending words arrive as asterisks (`****`) and a message that can only be caught as a whole is sent as `[message hidden]`.
- **Block-aware room chat.** `say` in street and venue rooms is no longer sent to players who blocked the speaker or were blocked by them. Checked per message, so a block applies at once.
- **Report limits.** `POST /reports`: 10 an hour per player (burst 5) else `429 RATE_LIMITED` with `Retry-After`; reporting the same target again while your report is open is a silent 204; reporting yourself is `400`.
- **Admin queue** (admin wallet): `GET /admin/reports?status=open|resolved|all&limit&after` (rows have `preview`, `targetUserId`, `openOnTarget`, paging `next`); `POST /admin/reports/{reportId}/resolve {action: dismiss|remove_content|mute|ban, hours?, note?}`; `POST /admin/users/{userId}/sanction {action: mute|unmute|ban|unban, hours?, reason?}`. The two old stubs `/admin/moderation/queue` and `/admin/bans` (never built) are gone from the spec. Every action is written to `moderation_actions`.
- **Mute** (1 to 720 hours): `403 ACCOUNT_MUTED` (`details.until`) on DM, feed post and room chat (`rejected {type:'say', code:'ACCOUNT_MUTED'}`); the player can still read. **Ban:** every request is `403 ACCOUNT_BANNED`, sign-in and refresh are refused (403) until unbanned. FE: on `ACCOUNT_BANNED` show a banned screen and clear tokens.
- **Ban reaches realtime.** A banned player is refused at the door of every room (street, venue, home, city, market, space, video call, vehicles): the join fails with `ACCOUNT_BANNED` even with a still-valid access token (Redis flag first, database as fallback). On ban, live sessions in every room type (street, venue, home, city, market, space, video call, vehicles) are closed with code `4003` and reason `ACCOUNT_BANNED` (FE: show the banned screen, do not auto-reconnect). A ban that lands while a join is still in progress cannot slip through (the join is re-checked just before it completes). A banned player's `say` is dropped like a muted one. Refresh is refused (`403 ACCOUNT_BANNED`), so no new access token can be minted.
- New error codes: `CONTENT_NOT_ALLOWED` (400), `ACCOUNT_MUTED` (403), `ACCOUNT_BANNED` (403).
## 2026-10-25 - Real nod positions

- `contract/ids/nods.json` is the frontend's confirmed export (ct-life 0d2713066, version 1.0.0, no longer provisional): the 80 nods now have the placed props' real island positions instead of placeholder grid points. No id, name, set, tier or district changed (checked against the previous file: 0 added, 0 removed, 6 sets identical). `POST /nods/{id}/collect` still checks the server's own fresh position against `x`/`z` within `radiusM` (default 15 m), so collects now work where the props actually stand. Every nod is on island land and at least 16 m from the next.
## 2026-10-25 - Starter quests and the first session (onboarding)

Stacked on #21 (clock-in) and #22 (`LIVE_PHASE`); merge those first. Migration 097.

- **Starter quests.** `GET /quests` gets a `starter: {quests}` group, listed first (the response is `{starter, daily, weekly}`), and every quest now has `pool: starter|daily|weekly`. A NEW account (created after migration 097) is given them once, at character creation or on its first `GET /quests`, and they are never reseeded; older accounts get none (`starter.quests` is `[]`). `q_starter_shift` First shift (verb `shift_start`, 1000 cents + 20 Season XP, `ctlife://jobs`), `q_starter_trade` First trade (verb `trade_open`, 500 + 20, `ctlife://pulse`), `q_starter_chest` GM (verb `chest_open`, 500 + 20, `ctlife://chest`). The trade quest is only given while markets are live for the deployment (`livePhase` 2 or more); if markets open later it is added to accounts already seeded. They claim like any quest: `POST /quests/{id}/claim`, ledger `quest_reward`, Season XP.
- **New verbs.** `shift_start` (a Rekt Burger clock-in that opens a shift, or `POST /shifts`), `trade_open` (a market buy, or a perp open), `chest_open` (the daily chest claim, first claim of the day). Each fires from the real server action after it commits.
- **`GET /me` `flags.firstSession`** = `{state: active|skipped|done, startedAt, completedAt, beats}`, `beats` a subset of `origin, character, home, moved, shift, trade, quest, chest`. A new account starts `active`; an older account reads `{state: 'done', startedAt: null, completedAt: null, beats: []}`.
- **`POST /me/first-session`** (auth, Idempotency-Key, 20 a minute): exactly one of `{beat}`, `{skip: true}`, `{replay: true}`; the reply is the new object. An unknown beat or any other body is `400 VALIDATION_FAILED`. It becomes `done` when every applicable beat is in (`trade` applies only while markets are live). `skip` sets `skipped`. `replay` sets `active`, clears `moved, shift, trade, quest, chest`, keeps `origin, character, home`, restarts `startedAt`.
- **Server-set beats.** `origin` on `POST /lottery/roll`, `character` on `POST /characters`, `shift`, `trade` and `chest` from the same events as the starter quests. The client reports `home`, `moved`, `quest`.
- Migration 097 adds `onboarding_meta` (the epoch: when it ran), `onboarding_state`, `starter_quests` and lets `quest_progress.pool` be `starter`.

## 2026-10-25 - Rekt Burger is a clock-in job (replaces the per-ticket minigame)

Migration 096. Changes what #16 shipped.

- `POST /jobs/rekt-burger/shift/start` now needs the player at the counter: the server's own fresh position (30 s) within `counter.radiusM` of `counter` (both in `GET /jobs/rekt-burger`), else `409 POSITION_UNKNOWN` or the new `409 COUNTER_TOO_FAR` (`details: {radiusM, distanceM}`). Still one open shift per player and idempotent while open (`resumed: true`, no position needed). Reply: `{shiftId, startedAt, ratePerMinuteCents, capRemainingCents, maxEndsAt, accruedCents, serverNow, resumed, postId}`; `minFinishAt`, `expiresAt` and `rules` are gone.
- New `POST /jobs/rekt-burger/shift/end` (no body) -> `{shiftId, paidCents, durationSec, minutes, careerXp, cappedCents, capRemainingCents, uniformGranted, endReason}` (`durationSec` is the total seconds on the clock, `minutes` is `floor(durationSec / 60)`, not a remainder; `GET /shift/current` `lastShift` has the same two fields). Pay = `floor(seconds x rate / 60)`, at most 3,600 s counted, trimmed to the 4,500 cent UTC-day cap; ledger reason `job_rekt_burger`. `endReason` is `clock_out`, `auto` or `left`. `404` with no open shift; racing ends pay once.
- New `GET /jobs/rekt-burger/shift/current` -> `{shift, lastShift}` for restore after a relaunch (an expired shift is closed and paid first).
- The server closes and pays a shift left running at `maxEndsAt` (a per-minute worker, and on the next read), so the player may leave the app. `POST /leave` now clocks an open shift out and pays it (`endedShift`) instead of voiding it.
- `POST /jobs/rekt-burger/shift/finish` (per-ticket minigame) is removed: it answers `410 GONE` with `details.use`. The error code `SHIFT_RESULT_IMPLAUSIBLE` is removed with it. New codes `GONE` (410), `COUNTER_TOO_FAR` (409).
- `GET /jobs/rekt-burger` `pay` is now `{ratePerMinuteCents, maxShiftCents, maxShiftSec, dailyCapCents, earnedTodayCents, remainingTodayCents, resetsAt}` (no `baseCents`/`perCorrectOrderCents`) and adds `counter: {x, z, radiusM}`; its `shift` is the new shift object.
- Economics (config `careers.json` `rektBurger`): 50 cents/minute, longest shift 3,600 s (3,000 cents), daily cap unchanged at 4,500 cents (90 minutes on the clock); the per-ticket design paid up to 1,500 cents per 3-minute shift and the same 4,500 cap.
- Career XP is time-based (1 per minute), only for a player on a ladder, under the shared daily action cap; a shift under 120 s is paid but earns no XP, quest progress or uniform. Unlock rules (Trencher, broke, liquidated) are unchanged.
- Migration 096 adds `rekt_burger_shifts.seconds, end_reason, career_xp` and an index for the sweep.
## 2026-10-25 - GET /config sends `livePhase`

- `GET /config` has a new top-level `livePhase` (integer 1 to 6), from the server env `LIVE_PHASE` (default 1, so nothing changes until it is set; a value outside 1 to 6 or not a number makes the API fail to start). The client reads it (it also accepts `phase` or `meta.livePhase`) to open the apps of every phase up to it and show "Coming soon" for the rest, instead of falling back to its build default. The payload (and so its ETag) changes only when `LIVE_PHASE` does.
- Ops: set `LIVE_PHASE=6` on the api service to open all apps for private testers.

## 2026-10-25 - Cash tips burn a 3% fee

Migration 095. The goal is that tip and quest farming between alt accounts is a net loss.

- `POST /tips` (Cash): the sender still pays `amountCents` in full; a fee of `ceil(3% of amount)` cents (at least 1) is BURNED, nobody is credited it, and the recipient gets `amountCents - feeCents`. The reply (201) now carries `feeCents` and `receivedCents` next to `amountCents`; the same fields are on `GET /tips` rows (cash tips; `feeCents` is 0 for tips sent before this change). The openapi entry for `/tips` described an old shape (`cashCents`); it now matches the real request (`amountCents`, optional `message`) and the reply (`CashTip`).
- A 1 cent tip is refused with `VALIDATION_FAILED` (the fee would take all of it), so the smallest tip is 2 cents. Maximum is unchanged (1,000,000).
- Ledger: the sender has `tip_out` (-received) and a new `tip_fee_burn` (-fee) that add up to the amount; the recipient has `tip` (+received). `GET /me/ledger`-style history labels `tip_fee_burn` "Tip fee (burned)". New `tips.fee_cents` column stores the fee per tip.
- Rate: env `TIP_FEE_BPS`, default 300, allowed 0 to 2000 (0 turns the fee off).
- Quests and careers count the tip event exactly as before, by the amount the sender sent. The ping-pong and per-recipient rules are unchanged. On-chain tips are not affected.
- FE tip sheet: show "3% fee, they get $X" with X = amount - ceil(amount * 0.03).

## 2026-10-25 - Breakpoint follow-ups: trivia retry, restore state, admin geofence, attendee handle, equip

Stacked on #15 (it also carries c55f22e, the crash-round settle fix that was pushed after #15 merged). Migration 093.

- **Trivia retry.** A wrong answer no longer locks the question for good (two wrong out of four made the step impossible). A wrong choice is stored in the new `event_trivia_attempts` and can not be tried again on that question (`EVENT_STEP_INVALID`, `reason: already_tried`). The question then cools down: 60 s after the 1st wrong choice, 10 min after the 2nd, 60 min after the 3rd. The wrong-answer error now carries `details.retryAfterSeconds` and `details.triedChoices`. Trying inside the cooldown answers `429 TRIVIA_COOLDOWN` (`details.retryAt`, `retryAfterSeconds`). Other questions are not affected. A right answer is final (`already_answered`). The reward is still paid once per player, so retrying can not farm it; guessing one question through every choice costs more than 70 minutes of waiting. Migration 093 moves old wrong rows from `event_progress` into the attempts table (as one try each).
- **`GET /events/{slug}` restore state.** `quest.steps[]` of an interaction step (booths, nods) gets `doneIds` (the ids already done). Each trivia `questions[]` gets `triedChoices` and `retryAt` (`answered` now means answered right). The event gets `irl: {available, checkedIn, checkedInAt, visible}`.
- **Admin geofence.** `PUT /admin/events/{slug}` accepts `geofence: {lat, lng, radiusM, source}` or `null` (check-in off). Bounds: `lat` -90..90, `lng` -180..180, `radiusM` an integer 20..5000, `source` required, all four together; omit the field to leave it alone. Out of range is `VALIDATION_FAILED`.
- **Attendee handle.** Each row of `GET /events/{slug}/irl` gets `handle` (22 base64url characters, an HMAC of the event and the user under a server key, no user id, different at each event) and `self`. New `POST /events/{slug}/irl/{handle}/dm {text}` (201 `{slug, sent, messageId, at}`) sends an ordinary DM to that attendee; the caller must have checked in (403 otherwise); an unknown, hidden, own or blocked handle is `404`; 10 messages an hour per player. Block filtering of the board is unchanged. The DM itself shows the sender to the recipient like every DM.
- **Reward unit.** `rewardCents` 20000 is in-game Cash cents, that is $200 of play Cash (about two mid-level shifts; a daily chest is $10 to $25). The unit was already cents everywhere; the amount is a placeholder to tune, now stated in `calendar_events.json` and in the `reward.cashCents` field description. No value changed.
- **`PATCH /characters/me/look`** (it was in the contract but not built). Body: any of `skinTone, headId, hairId, topId, bottomId, shoesId, accId` (at least one, no extras). Every id that is a cosmetic in the catalogue must be owned by the caller (`403 ITEM_NOT_OWNED`) and fit the slot (`400 look_item_wrong_slot`); the Breakpoint lanyard is `accId: "lanyard_breakpoint_2026"`. Palettes still apply; a character with a personal avatar keeps its head. Returns the character.
- New error code `TRIVIA_COOLDOWN` (429).

## 2026-10-24 - Sleuth heat, carjacking and police pursuit

Merge after #15 (the retention batch) and #16 (careers and the fallback job); migration `1700000092000` follows 091. Parody, game Cash only. Rules, numbers (all marked [Inference], to tune) and the client contract are in `docs/HEAT.md`.

- **Heat** (the `player_heat` value from the Rugpull Factory) is now fed by carjacking (+8 for an NPC traffic car, +15 for a player's vehicle), hitting a player with a vehicle (+3, at most once per 10 s per driver) and the rug exposé (35 to 50, unchanged). A `drainer_job` hook (+20) exists for a job that does not exist yet. Levels: `cool` under 10, `warm` 10, `hot` 35, `wanted` 70. Added `GET /heat/me` -> `{heat, level, decayAt, wantedUntil, levels, pursuit, jail}`.
- **Carjacking.** `vehicle_enter` takes `steal: true`. It is required for an NPC traffic car (id `traffic_*`) or another player's parked vehicle (`STEAL_REQUIRED` otherwise). Server-side: within 4 m, 2 messages a second, one steal per player per 15 s. It never transfers ownership: a player's vehicle returns to the pose its owner left it on exit, or after 3 minutes. The hovercar (`roadstar`) is never stealable (`VEHICLE_NOT_STEALABLE`), nor is a vehicle someone is driving (`VEHICLE_TAKEN`). New realtime `vehicle_stolen` (to the owner) and `vehicle_returned` (owner and thief). **Behaviour change:** entering a vehicle another player parked now needs `steal: true`; it used to work silently.
- **Police pursuit.** At `wanted` the server starts a pursuit for an online player (a worker loop every 2 s): `police_pursuit {pursuitId, targetUserId, units 1..4, ...}` to the player and to the street room holding them, `police_pursuit_end {outcome, reason}` when it ends. The client drives the AI cruisers; the **server decides** the outcome from its own position hash and timers: escape = more than 200 m from the last wanted position for 60 s in a row (an unknown position resets the clock), or reaching your own home door; otherwise the 180 s timer catches you. `POST /heat/caught {pursuitId, x, z}` lets the client end it sooner, verified against the server position (`NO_PURSUIT`, `CATCH_NOT_VERIFIED`); there is no way to report an escape.
- **CT Jail.** Caught: heat drops to 40%, a stay in the `ct_jail` venue (90 s plus 3 s per heat point) with a bail of heat times 50 cents (at least 1,000), realtime `jailed` / `released`, and the Sleuth posts a "busted" Timeline post (`kind: "sleuth"`, `meta.event: "busted"`; one per player per 30 minutes, at most 10 overall per 10 minutes). `POST /heat/bail` pays it (ledger `police_bail`, a sink; `INSUFFICIENT_CASH`, `NOT_JAILED`). Escaped: heat drops to 50%.
- **Jail restrictions** (`403 JAILED`): coin launches (factory and house launchpad), buying coins, opening perps, casino bets, entering vehicles, and joining any venue but `ct_jail` (`GET /venues/{id}/access` answers `allowed: false, reasonCode: "JAILED"`). Selling and closing positions stay open.
- **Sleuth.** `The Sleuth` is an original parody character, the same alias as the factory exposés; no real person's name or likeness.
- New error codes `JAILED` (403), `NOT_JAILED` (409), `NO_PURSUIT` (409), `CATCH_NOT_VERIFIED` (422); realtime `rejected` codes `JAILED`, `VEHICLE_NOT_STEALABLE`, `STEAL_REQUIRED`.
- Migration 092 adds `heat_pursuits`, `player_jail` and an index for the busted-post rate limit.

## 2026-10-24 - Career ladders and the Rekt Burger fallback job

Merge after #15 (the retention batch); migration `1700000091000` follows 090. Rules, numbers and the client contract are in `docs/CAREERS.md`.

- **Career ladders** (Builder, Trader, Caller, Farmer, Founder) sit on the existing jobs: each names the `careers` entries whose shifts earn its XP and the tribes it suits. Seven ranks each, Intern to Legend. A rank grants a title, a pay bonus on shifts of the ladder's jobs (`payBonusBps`, whole cents, rounded down), venue-area flags (`venueId:area`) and, at ranks 3, 5 and 7, a `reward_career_*` cosmetic. Definitions are in `contract/config/careers.json` (`ladders`, `ladderJoinCooldownHours`, `ladderActionXpDailyCap`, `cosmetics`), with the schema extended and checked by `contract:check`.
- Added `GET /careers?view=ladders` -> `{myLadderId, suggestedLadderId, joinCooldownHours, canSwitchAt, venueAccess, ladders: [{id, name, tribeIds, jobIds, active, suggested, xp, rank, title, payBonusBps, nextRank, xpToNext, ranks: [{rank, id, title, xpRequired, payBonusBps, venueAccess, cosmeticId, status}]}]}`. **The default `GET /careers` is unchanged** (the job array), so clients written against it keep working; the ladders are on `view=ladders` rather than replacing it.
- Added `POST /careers/{ladderId}/join` -> `{ladderId, alreadyMember, rank, title, xp, joinedAt, nextSwitchAt}`. The first deliberate join is free; switching waits 72 hours (`409 CAREER_SWITCH_COOLDOWN`, `details.retryAt`). XP and rank are kept per ladder. A player who never chose is enrolled by their first paid shift on a ladder job (no cooldown started).
- XP is server-side only: a paid shift on a ladder job adds that shift's XP (up to 100), and related actions add a little: perp open/close, prediction, alpha call, paid call, tip, home visit, airdrop claim, project founded/launched. Action XP is capped at 120 per ladder per UTC day; every award is keyed by its source event, so a replay never pays twice. Promotion is automatic, in the same transaction as the XP.
- `POST /shifts/{id}/complete` now adds the rank bonus to `payCents` and, only when the job is on the player's ladder, a `ladder: {ladderId, rank, title, bonusCents, xpAdded, promoted}` object. The existing fields are unchanged.
- Realtime `career_promoted` (to the player): `{ladderId, ladderName, fromRank, toRank, title, payBonusBps, venueAccess, cosmeticIds, xp, at}`; `venueAccess` and `cosmeticIds` list only what this promotion newly gave. Realtime `job_unlocked`: `{jobId, name, reason, venueId, at}`.
- `GET /venues/{id}/access` adds `careerAreas` (the areas of that venue my rank unlocks, usually `[]`).
- **Rekt Burger**, the "blew my port" fallback job (our own parody brand; no real chain's name, logo or likeness). Added `GET /jobs/rekt-burger`, `POST /jobs/rekt-burger/shift/start`, `POST /jobs/rekt-burger/shift/finish {shiftId?, result: {orders: [{i, startedMs, servedMs, correct}]}}` and `POST /jobs/rekt-burger/leave`. Trenchers have it from the start; others unlock it for good when Cash is 0 or less while in debt, or when a perp liquidation leaves Cash under 2,000 cents.
- Pay is decided by the server from the validated order timings: 300 cents plus 60 per correct order (at most 20 count), so 1,500 at most a shift, capped at 4,500 a UTC day; ledger reason `job_rekt_burger`. There is no amount in the request and unknown fields are `400`. An implausible report is `422 SHIFT_RESULT_IMPLAUSIBLE` and burns the shift. Shifts are stored in Postgres (`rekt_burger_shifts`), not in memory.
- Timeline: starting after being out writes a "Back to the trenches" post; leaving after net worth recovered above 100,000 cents writes a "Glow-up" post. `GET /feed` posts gain `kind: "career"` (author = the player) with `meta {event, jobId, deepLink}`.
- Completion counts for the `shift_complete` quests, so for the Season XP they pay. The first finish grants the `reward_rekt_burger_uniform` cosmetic.
- New error codes `CAREER_SWITCH_COOLDOWN` (409), `JOB_LOCKED` (403), `JOB_DAILY_CAP` (409) and `SHIFT_RESULT_IMPLAUSIBLE` (422).
- Migration 091 adds `ladder_membership`, `ladder_progress`, `ladder_xp_events`, `rekt_burger_state` and `rekt_burger_shifts`.

## 2026-10-24 - Security review fixes: APNs unregister, opaque IRL board cursor

- `DELETE /push/register` now takes exactly one of `{fcmToken}` or `{apnsToken}` (400 otherwise); still caller-only, `204` for unknown tokens. Sign-out on iOS can now unbind the APNs token.
- The IRL attendee board `next` cursor is now opaque and HMAC-signed over `(checkedInAt, checkinId)`, a random surrogate id added to `event_checkins` in migration 090. It no longer contains a user id; a tampered cursor is `400`. Cursors issued before this change are rejected as invalid (the feature has not shipped).

## 2026-10-24 - Retention batch: season furniture rewards remapped to the real Duo Shop catalogue

Combining #10 (the frontend's real 18-item catalogue) with #13 (Season Pass tracks) left six season furniture rewards pointing at placeholder ids that no longer exist (a tier claim would 500). `contract/config/season_tracks.json` now uses catalogue ids: `plant_pothos` -> `plant_zebra`, `poster_wagmi` -> `vase_stoneware`, `lamp_floor` -> `lamp_architect`, `rug_round` -> `ottoman_leather`, `neon_sign_gm` -> `lamp_pipe`, `coffee_machine` -> `boombox_retro`. FE-owned file: swap these for the items you want. A new test fails if a season reward ever names an item outside `shop_items.json`.

## 2026-10-24 - Rugpull Factory: player coin launches, creator fee, rug heat and the Sleuth

Parody, game-Cash-only and server-simulated: no token, no chain, nothing withdrawable. Rules, fees and odds are in `docs/FACTORY.md`.

Merge order: migration 089 follows open PRs 084 (#9, which also adds 088 push_token_unique), 085 (#11), 086 (#12) and 087 (season tracks). If it merges first, run the migrator with `--no-check-order`; it touches none of their tables.

- Added `POST /factory/coins {name, ticker, templateId, liquidityCents, devAllocationBps}` -> `201 FactoryCoin`. Debits the launch fee (500 cents, ledger `factory_launch_fee`, a sink) plus the liquidity (1,000 to 100,000, `factory_liquidity`) in one transaction and creates a coin flagged `playerLaunched` with the caller as creator. The creator is credited `devAllocationBps` (0 to 5,000) of the units the liquidity buys. The hidden arc is sampled by the server from `market.json` `outcomeMix` (rug 25, bleed 40, sideways 20, moon 15); the body is strict, so a client-sent arc is a `400`. Name and ticker are filtered. Limits: 3 per rolling 24 hours and a 10 minute cooldown. Idempotent: a replayed `Idempotency-Key` returns the same coin and charges once.
- Added `GET /factory/coins?view=trending|new|mine&limit=`, `GET /factory/coins/{coinId}` (the coin, `candles1m`, `topHolders`, `riskHint`; `creatorFeesCents` only for the creator), `GET /factory/config` and `GET /factory/me` (`heat`, `heatLevel`, `launchesToday`, `nextLaunchAt`). Art is a fixed id `templateId` (`rf_*`, listed in `/factory/config` and the openapi enum).
- Trading a player coin uses the existing `POST /market/trades`. Once a coin has traded at 3x its launch price, the creator earns 50% of every other player's trade fee on it (ledger `factory_creator_fee`), taken out of the fee the market already charges.
- Rug detection: a creator who sells at least 30% of the circulating units within 60 minutes of other players buying 500 cents or more is flagged once per coin. They gain heat (35 to 50, capped at 100, halving every 24 hours; stored in `player_heat` for the future police loop, nothing punishes it yet). The Sleuth, an original parody NPC, posts one exposé naming the launcher on the Timeline (one per coin, one per launcher per 30 minutes), and `evt_rug` is broadcast with params `{coinId, ticker, kind: "creator_dump", launcherAlias, heat}`.
- `GET /feed` posts add `kind` (`player | sleuth`) and `meta` (null for player posts; for `sleuth`: `{coinId, ticker, launcherUserId, launcherAlias, sellSharePct, heat, deepLink}` with `deepLink` `venue:launchpad_tower`). A Sleuth post's `alias` is `The Sleuth`.
- `evt_coin_launch` now also fires for player coins, with params `{coinId, ticker, playerLaunched: "1", templateId, creatorAlias}`.
- Realtime `CoinState` (market room) adds `playerLaunched: boolean` and `templateId: string` at the end of the schema. The market room lists a player coin from its first 30 minutes ahead of the market-cap ordering so it always shows on Pulse. `holders` is now counted from positions at read time.
- The market sim looks for new player coins every 5 seconds (was 30), so a coin ticks within 5 seconds of its launch. The engine's Redis snapshot now carries `priceHistory`, which fills the `candles1m` of `GET /market/coins/{coinId}` (it was always empty).
- New error codes `NAME_NOT_ALLOWED` (400), `TICKER_TAKEN` (409), `LAUNCH_LIMIT_REACHED` (429) and `LAUNCH_COOLDOWN` (429, `details.retryAfterMs`).
- Migration 089 adds `coins.player_launched, creator_id`, `factory_coins`, `factory_trades`, `player_heat`, `player_heat_events`, `feed_posts.kind, meta` and the Sleuth's user row (`npc:sleuth`).

## 2026-10-24 - Season Pass tracks and the community-nods collection

Merge notes: migration `1700000087000` (after 084 #9, 085 #11, 086 #12; apply with `--no-check-order` if it lands before them). It creates `season_xp` with `IF NOT EXISTS` in the same shape as 084, so it is safe in either order with #9 (see `docs/SEASON_AND_NODS.md`).

- New FE-owned `contract/config/season_tracks.json` (+ schema, checked by `contract:check`): `seasons: [{seasonId, name, startsAt, endsAt, xpPerTier, nodXp, tracks: {free, paid}}]`, each track at least 10 tiers `{tier, reward}`; a reward is exactly one of `cashCents`, `cosmeticId` (a `reward_*` id from the file's `cosmetics`) or `furnitureItemId` (a `shop_items` id). Tier `n` unlocks at `n * xpPerTier` Season XP earned in `[startsAt, endsAt)`. Ships one placeholder season (`s1_airdrop_season`, 12 tiers per track, 250 XP a tier); rewards and dates are to tune. Rewards are off-chain, never tradable, never NFTs.
- New FE-owned `contract/ids/nods.json` (+ `nods.schema.json`): `sets`, reward `cosmetics` and `nods: [{nodId, name, setId, tier, district, x, z, radiusM?}]`. It lists the 80 community nods (ids = the community-eggs ids) in six sets. PLACEHOLDER: `x`/`z` (island metres, the `ctl:pos` frame) are provisional grid points inside each nod's district, not the real prop positions; the frontend replaces the file with its placed positions.
- Added `GET /season` -> `{season, xp, tier, xpToNext, hasPass, tracks: {free, paid}}`, each track a list of `{tier, xpRequired, reward, status}` with `status` `locked | claimable | claimed | pass_required`. `404 NOT_FOUND` when no season runs.
- Added `POST /season/tiers/{n}/claim?track=free|paid` -> `{seasonId, track, tier, reward, alreadyClaimed, xp}`. Idempotent (a tier pays once). Cash is ledger reason `season_reward`; a cosmetic lands in `GET /inventory` (source `grant`); furniture lands in `GET /me/items`. Paid needs a live season pass (`403 PASS_REQUIRED`); short of XP is `409 TIER_LOCKED`; a tier not in the track is `404`.
- Added `GET /nods` (my book by set; no positions), `POST /nods/{nodId}/collect {proof: {nodId, x, z}}` and `GET /nods/leaderboard` (Hunter board, top 50 plus `me`). Collect is decided by the server's last position for the player (`ctl:pos`, fresh within 30 s, within 15 m of the nod): `409 POSITION_UNKNOWN`, `409 NOD_TOO_FAR`; the client position is only a consistency check (`400` beyond 30 m); `429 RATE_LIMITED` past 10 burst / 12 a minute. A nod counts once (a repeat is `200` with `alreadyCollected: true`); each new find awards `nodXp` (50) Season XP and a filled set grants its cosmetic once (`setReward`).
- New error codes `PASS_REQUIRED` (403), `TIER_LOCKED` (409), `NOD_TOO_FAR` (409). `POSITION_UNKNOWN` (409, until now realtime only) is also returned over REST.
- Reward-only cosmetics are `cosmetic_items` rows with `reward_*` keys: they are hidden from `GET /shop` and cannot be bought.
- Migration 087 adds `season_tier_claims`, `collected_nods`, `nod_set_grants` and (if missing) `season_xp`.

## 2026-10-24 - The Rug Room: Cash-only casino (slots, crash, coinflip)

Independent of the other open PRs. Migration 086 (`1700000086000_casino`); if it merges after 084 or 085, run migrations with `--no-check-order`.

- Play money, Cash only, 18+. Every success response carries `disclaimer: "Play money. No cash value. 18+"`, `sessionMinutes` (continuous play) and `sessionReminder` (true from 30 minutes). Nothing can be cashed out and nothing tradable is paid.
- New config `contract/config/casino.json` (+ `casino.schema.json`, checked by `contract:check`): stake limits, slots reel weights and paytable with `computedRtp` (95.05%), crash growth, coinflip payout and head-to-head cut. A new `contract:check` step `casino-rtp` recomputes the slots RTP and fails outside 94-96%.
- Added `GET /casino/state` (age and exclusion state, caps and what is left today, paytables; readable before 18+ is confirmed), `POST /casino/slots/spin {stakeCents}`, `POST /casino/crash/bet {stakeCents, autoCashout?}`, `POST /casino/crash/cashout {roundId}`, `POST /casino/coinflip/bet {stakeCents, side}`, `POST` and `GET /casino/coinflip/challenges`, `POST /casino/coinflip/challenges/{id}/accept | decline | cancel`, `GET /casino/rounds?mine&limit&before`, `GET /casino/rounds/{id}` and `POST /casino/self-exclude {days}`. Writes are idempotent and rate limited; request bodies are strict (an unknown field such as an outcome or multiplier is `VALIDATION_FAILED`).
- Server-authoritative commit-reveal RNG: `seedHash` is published when a round opens, `seed` is returned once it settles (never while open); the algorithm is in `docs/CASINO.md`. `GET /casino/rounds?mine` is the caller's own audit log; someone else's round or challenge is `404`.
- Crash: the crash point is drawn at the bet and never sent while the round is open. A manual cashout is decided by the server clock against the crash time; a late cashout answers `200` with payout 0 and `outcome.crashed: true`, a second one `409 ROUND_SETTLED`. One open crash round per player.
- Head-to-head coinflip: named opponent, the challenger's stake is escrowed (ledger `casino_stake`), the opponent has 120 s to accept, then the stake is refunded (`casino_refund`) by the next touch or a per-minute worker; the winner gets the pot minus 5%.
- Ledger reasons `casino_stake`, `casino_win`, `casino_refund`.
- Caps (UTC day): `CASINO_DAILY_STAKE_CAP_CENTS` (default 50000) and `CASINO_DAILY_LOSS_CAP_CENTS` (default 25000). Self-exclusion can be extended, never shortened.
- New error codes `AGE_REQUIRED` (403), `STAKE_CAP_REACHED` (403), `LOSS_CAP_REACHED` (403), `SELF_EXCLUDED` (403), `ROUND_SETTLED` (409), `ROUND_IN_PROGRESS` (409), `CHALLENGE_EXPIRED` (410), `CHALLENGE_NOT_OPEN` (409).
- Rich list: a net casino profit now counts at 25% on the `net_worth` and `weekly_pnl` boards (losses in full), so gamblers do not dominate it.
- Migration 086 adds `casino_players`, `casino_rounds`, `casino_challenges` and a partial index on `ledger_entries` for the casino reasons.

## 2026-10-24 - Event calendar: opt-in IRL check-in at Breakpoint

Extends the event calendar entry below (same PR).

- Added `POST /events/{slug}/checkin {lat, lng, accuracyM, isMock}`, only during the event window. The server checks the position against the venue geofence and discards it: no coordinates, accuracy or distance are stored, logged or returned. Rejections are `422 CHECKIN_REJECTED` with `details.reason`: `mock_location` (`isMock` true), `poor_accuracy` (`accuracyM` > 150), `account_too_new` (account created at or after the event `startsAt`), `outside_geofence`, `not_available` (no geofence). Out of window is `409 EVENT_NOT_LIVE`. At most 3 attempts per player per hour (`429`). Reply `{slug, checkedIn, checkedInAt, visible, firstCheckin, reward}`; a repeat returns the same check-in with `firstCheckin: false`, `reward: null`.
- One-time IRL reward per player per event (and so per wallet): Cash (ledger reason `event_irl_bonus`, default 10000 cents, env `EVENT_IRL_BONUS_CENTS`) plus the off-chain, grant-only cosmetics `irl_badge_breakpoint_2026` and `lanyard_breakpoint_2026_gold` (slot `acc`, source `grant`).
- Added `PUT /events/{slug}/checkin/visibility {visible}` (default hidden; needs a check-in, else `404`) and `GET /events/{slug}/irl?limit=&cursor=` -> `{items: [{alias, look, tribeId, avatarId, checkedInAt}], next}`: opted-in attendees only, newest first, blocked users excluded both ways, no location and no user id.
- Realtime `irl_checkin {slug, alias, at}` on the city room when a player turns visibility on (alias only; once an hour per player, 10 burst and 2/s per event). It is scoped, not a raw broadcast: the city room skips signed-out sessions and every player who blocked the attendee or was blocked by them, and it is sent only while the event is live and the attendee is visible.
- `calendar_events.json` events gain optional `geofence {lat, lng, radiusM, source}` and `irlRewardItemKeys`. Breakpoint 2026: 51.49639, -0.20972, 350 m, coordinates from the Wikipedia article on Olympia London. `CalendarEvent` gains `irlCheckin` (true when a geofence exists). New error code `CHECKIN_REJECTED` (422).
- Request bodies and coordinate fields are now redacted from API logs. Migration 090 adds `event_checkins(event_id, user_id, checked_in_at, visible)` and `events.geo_*` (the venue's geofence). What is stored and why: `docs/PRIVACY_IRL_CHECKIN.md`.

## 2026-10-24 - Push tokens: one account per token, DELETE /push/register

- Added `DELETE /push/register {fcmToken}` -> `204`. It removes that token from the caller's own devices only; someone else's or an unknown token is left alone and the reply is the same, so tokens cannot be probed or deleted by guessing. Call it on sign-out.
- A push token now belongs to exactly one account. `POST /push/register` with a token another account holds moves it to the caller in the same transaction, so the previous account can never receive pushes on this device. The openapi `POST /push/register` block now shows the real body (`platform`, `fcmToken` or `apnsToken`, `enabled`) and `201`.
- Migration 088 deletes duplicate tokens (the most recently updated row keeps it) and adds unique indexes on `push_devices.fcm_token` and `apns_token`.

## 2026-10-23 - Event calendar: Breakpoint 2026, event quest chain, lanyard

Independent of the daily streak PR (#9, migration 084); merge order does not matter for the code, see the PR for the migration order note.

- New BE-owned `contract/ids/calendar_events.json` (+ `calendar_events.schema.json`, checked by `contract:check`): `events: [{id, slug, title, kind, startsAt, endsAt, city, realVenue, ingameVenueId, skinId, streamUrl, sourceUrl, questSet, rewardCents, rewardItemKey}]` and `questSets` (steps with the booth, trivia-question and nod ids the client sends). It is a new file because `events.json` already holds the city's `evt_*` world events. The API upserts it into `events` (migration 085); an event ops edited is no longer overwritten. It seeds Breakpoint 2026 only: `breakpoint-2026`, 15 to 17 Nov 2026 (stored as 2026-11-15T00:00Z to 2026-11-18T00:00Z, the listing gives dates but no times), London, Olympia London, source https://luma.com/breakpoint2026, in-game venue `conference_hall`, skin `london_2026`. `streamUrl` is null until the organiser publishes a stream; ops set it with the admin PUT. New server-only `contract/config/event_trivia.json` holds the trivia answer key.
- Added `GET /events/current` -> `{items, serverNow}` (live events, with `endsAt`), `GET /events/upcoming?limit=` (default 10, max 50, with `startsAt`) and `GET /events/{slug}` -> the event plus `quest` progress for the caller (`skinId`, `streamUrl`, steps with `done/required`, trivia questions without answers, `reward`). `status` is `upcoming | live | ended`. The stream is a link-out; do not embed it.
- Added admin `PUT /admin/events/{slug}` (`ADMIN_WALLETS`) to correct title, dates, city, venue, `streamUrl` (https or null) and `sourceUrl`.
- Added `POST /events/{slug}/progress {step, proof: {id, answer?}}`. Steps are ordered (`booths` 3 of 6, `trivia` 3 of 4, `nods` 5 of 8). Booth and nod proofs are checked against the ids the quest set lists (each counts once); trivia is checked against the server key and each question is answered once. Only inside the event window; rate limited per player (burst 8, then 1 per 2 s); idempotent. The server cannot prove the player stood at a booth or nod: it stops unknown ids, repeats, order skips, and out-of-window claims, not a client replaying real ids.
- Completing the chain pays `rewardCents` Cash (ledger reason `event_reward`, 20000 for Breakpoint) and grants the off-chain cosmetic `lanyard_breakpoint_2026` (slot `acc`, inventory source `grant`), once. New cosmetics column `grant_only`: a grant-only item is not in `GET /shop` and cannot be bought. Never tradable, never an NFT.
- Realtime: the city room broadcasts `event_live {slug, title, kind, city, skinId, ingameVenueId, streamUrl, endsAt, at}` at the start and `event_ended {slug, title, kind, skinId, endedAt, at}` at the end, from a per-minute worker sweep (so up to about a minute late, once each).
- New error codes `EVENT_NOT_LIVE` (409) and `EVENT_STEP_INVALID` (400).
- Migration 085 adds `events`, `event_progress`, `event_completions`, `event_announcements` and `cosmetic_items.grant_only`.

## 2026-10-23 - gm streak and daily chest, daily/weekly quests, real push (FCM)

Independent of the homes (#7) and Duo Shop (#8) PRs, which are already on `main`: the home-visit quest is wired to `POST /homes/{ownerId}/visit` and works now.

- Added `GET /daily/status` -> `{streakDay, claimedToday, nextResetAt, freezes, maxFreezes, freezePriceCents, chest: {day, rewards: {cashCents, cosmetic}}}`. `streakDay` is the consecutive UTC days claimed up to now (0 when broken or never started); `chest` is today's while `claimedToday` is false, tomorrow's after. The server is the only clock; days are UTC dates.
- Added `POST /daily/claim` (no body; idempotent per UTC day) -> the status plus `{alreadyClaimed, claimed: {day, rewards}, freezesUsed, reset}`. The chest pays Cash with the new ledger reason `daily_streak` ($10 on day 1, +$2.50 a day to $25 on day 7, flat after) and, on day 7, 14 and 30, a cosmetic through the cosmetics inventory with `source: grant` (`head_cap_black`, `acc_aviator_sunglasses`, `acc_chain_gold`; skipped if already owned). A second claim the same day pays nothing and returns the first claim with `alreadyClaimed: true`. Missing a day resets to day 1 (`reset: true`) unless a held freeze covers every missed day; the freezes are then consumed automatically.
- Added `POST /daily/freeze` -> `201` status. Costs `freezePriceCents` (5000) Cash, ledger reason `streak_freeze`; at most 2 held. `402 INSUFFICIENT_CASH`; new `409 FREEZE_LIMIT_REACHED`.
- New FE-owned `contract/ids/quests.json` (+ `quests.schema.json`, checked by `contract:check`): `quests: [{id, title, description?, verb, target, reward {cashCents, seasonXp}, pool: daily | weekly, deepLink?}]`. It ships 10 daily and 8 weekly placeholder quests; edit the file to change them, no code change. `verb` is one of `shift_complete, perp_open, perp_close, prediction_place, alpha_call, paid_call, tip_send, home_visit`.
- Added `GET /quests` -> `{daily: {date, resetsAt, quests}, weekly: {week, resetsAt, quests}}`: 3 daily and a chain of 5 weekly quests per player, deterministic (seeded by user and UTC date or ISO week, distinct verbs preferred), each with `progress, target, completed, claimed, reward, deepLink`; weekly ones also `step` 1 to 5. Added `POST /quests/{id}/claim` (no body; idempotent) -> `{questId, alreadyClaimed, reward}`; pays Cash (ledger reason `quest_reward`) and records Season XP in the new `season_xp` table (R4 reads it). Only a quest in the caller's current picks is claimable (any other id is `404`); an unfinished one is new `409 QUEST_NOT_COMPLETE`.
- Progress comes only from server events, counted once per source event after the commit: a shift completed, a perp opened or closed, a prediction placed, an alpha call posted, a paid call accepted (both sides), a Cash tip of at least $10 sent, a visit to someone else's home. Social quests resist two accounts looping them: a tip counts once per recipient per 7 days and never when the recipient tipped the sender in the last 7 days; a paid call counts once per pair of players per 7 days; a home counts once per 7 days and not when its owner visited the visitor's home in the last 7 days. A tip moves Cash to the recipient rather than burning it, so this caps the farming (about one social quest per distinct counterpart per week) rather than making it unprofitable. The client never reports progress and never names a reward.
- Realtime: `quest_progress {questId, pool, progress, target, completed, at}` goes to the player (`city` room, like `dm`) on every change.
- Real push: FCM HTTP v1 delivery on top of `push_devices` (android and web devices with an FCM token), with a worker sweep every 5 minutes. Off unless `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT_JSON` (or `FCM_SERVICE_ACCOUNT_PATH`) are set: then every send is a logged no-op. Types: `streak_ending` (from 3 hours before the UTC reset, if not claimed), `daily_clue`, `liquidated`, `home_visit` (once per home per day), `event_starting` (stub for R2, nothing calls it yet). Every payload carries `type` and `deep_link` (`ctlife://quests`, `ctlife://daily-clue`, `ctlife://perps`, `ctlife://home`, `ctlife://events`) in the FCM data map. At most 4 pushes per player per UTC day. See `docs/PUSH.md`.
- Added `GET` and `PUT /push/prefs` `{quietEnabled, quietStartHour, quietEndHour, tzOffsetMin, disabledTypes}`: quiet hours in the player's local time (default on, 22:00 to 08:00 at offset 0, so the client should PUT its offset when push permission is granted) and a per-type opt-out. The existing `POST /push/register` is unchanged.
- New error codes `FREEZE_LIMIT_REACHED` (409), `QUEST_NOT_COMPLETE` (409). New ledger reasons `daily_streak`, `streak_freeze`, `quest_reward`.
- Migration 084 adds `login_streaks`, `daily_claims`, `quest_events`, `quest_progress`, `season_xp`, `push_prefs` and `push_log`.

## 2026-10-23 - Follow-up to the homes (#7) and Duo Shop (#8) merges

#7 and #8 were merged before their last updates, so these landed late: the real door ids in `home_units.json` (see "Real door ids" below), `homeId` in the unit access reply, the `/me` home-follows-lease fix, `flags.wireV3Kinds` in `GET /config`, and the real 18-item `shop_items.json` catalogue. No new endpoints. Deploy note: the six placeholder `flat:midrise_*` rows are no longer in the file but stay in `home_units`; delete the unleased ones once (`DELETE FROM home_units WHERE unit_id LIKE 'flat:midrise_%' AND unit_id NOT IN (SELECT unit_id FROM homes WHERE unit_id IS NOT NULL)`).

## 2026-10-23 - Duo Shop: Cash goods and furniture, scheduled delivery, placements

Merge after the homes PR (#7): orders to the door use `homes.unit_id` and `home_units`, and placements use its door access rules.

- New FE-owned `contract/ids/shop_items.json` (+ `shop_items.schema.json`, checked by `contract:check`): `items: [{itemId, category, name, priceCents, deliverable, placeable, footprint {w,d,h}, modelKey}]`. `category` is `furniture | decor | appliance | food | clothing` (the schema keeps `clothing` open); `footprint` (metres) is required exactly when `placeable` is true; `modelKey` is the frontend asset key. It ships the frontend's 18 items (12 furniture, 4 decor, 1 appliance, 1 food; no clothing, the cosmetics shop sells looks), with `modelKey` the client prefab `Resources/World/Furniture/<modelKey>`. The API upserts the file into `shop_items` (migration 083); an item dropped from the file leaves the catalogue but stays in the table.
- Added `GET /shop/catalog?category=` -> `{items, lockerFeeCents, windows: [{id, minutes}]}`. The cosmetics `GET /shop` and `POST /shop/purchase` are unchanged.
- Added `POST /shop/orders {items: [{itemId, qty}], window: 'asap' | '30m' | '1h', destination: 'door' | 'locker'}` -> `201 ShopOrder`. It debits Cash (ledger reason `shop_order`) from catalogue prices, plus a 300 cent locker fee for `locker`; the client never sends a price. Windows are real time: asap 10 min, 30 min, 60 min; nothing shortens the wait. Limits: 10 lines, 1 to 10 of each, 20 units, 5 orders in flight (`VALIDATION_FAILED`). `door` needs a home with a door (`409 NO_HOME_DOOR`; a player on the street uses `locker`); short of Cash is `402 INSUFFICIENT_CASH`. Idempotent: a replayed `Idempotency-Key` returns the same order and charges once.
- Added `GET /shop/orders`, `GET /shop/orders/{id}` (owner only; someone else's id is `404`) and `POST /shop/orders/{id}/cancel` (owner only, only while `placed`, full refund with ledger reason `shop_refund`; `409 ORDER_NOT_CANCELLABLE` otherwise; a cancelled order is never delivered). `ShopOrder.status` is `placed | out_for_delivery | delivered | cancelled`.
- Delivery: a BullMQ worker moves an order to `out_for_delivery` 60 s before `etaAt` and to `delivered` at `etaAt`, with a per-minute sweep as a safety net. Realtime `delivery_out {orderId, destination, unitId, etaAt}` (courier leaves; `etaAt` epoch ms; `unitId` null for a locker) and `delivery_arrived {orderId, destination, unitId}` go to the player (`city` room, like `dm`). On arrival the items become `player_items`, one row per unit: owned off-chain, not NFTs, never tradable.
- Added `GET /me/items` -> `{items: [{itemInstanceId, itemId, name, category, modelKey, placeable, footprint, orderId, acquiredAt, placedHomeId}]}`.
- Added `PUT /homes/{homeId}/placements {placements: [{itemInstanceId, x, z, rotY}]}` (owner only; replaces the set; items must be owned, `placeable` and listed once; x and z within 200 m, yaw in radians) and `GET /homes/{homeId}/placements` for anyone who may enter the door (owner, guests; a home without a door is open), `403 FORBIDDEN` otherwise. Both answer `{homeId, placements: [{itemInstanceId, x, z, rotY, itemId, name, modelKey, footprint}]}`.
- New error codes `NO_HOME_DOOR` (409), `ORDER_NOT_CANCELLABLE` (409), `ITEM_NOT_OWNED` (403, also for an unknown id), `ITEM_NOT_PLACEABLE` (409), `ITEM_ALREADY_PLACED` (409).
- Migration 083 adds `shop_items`, `shop_orders`, `shop_order_items`, `player_items` and `home_placements`. Food and clothing are delivered and owned but have no use yet.

## 2026-10-23 - Real door ids, access `homeId`, `/me` home kind, `flags.wireV3Kinds`

- `contract/ids/home_units.json` now holds the six real doors from the frontend (`flat:lgmf_<x>_<z>:0`, tier `flat`, `apartment_modern`, 18000 cents a week, capacity 2). The placeholder `flat:midrise_0N:0` rows stay in `home_units` on an existing database (the upsert never deletes); delete any that are unleased, once.
- `GET /units/{unitId}/access` adds `homeId` (the `home:<uuid>` instance id) when `canEnter` is true, for the owner and guests only, so a guest at a door can join the `home` room. Strangers never get it.
- `GET /me`: `homeId` and `character.homeId` now follow the live lease (`studio` after a studio lease) instead of the birth home; `home` gains `kind`. With no live lease they fall back to the character's birth home.
- `GET /config` adds `flags: {wireV3Kinds}` (boolean, default false, env `WIRE_V3_KINDS`). When true the client sends the v3 vehicle kinds.

## 2026-10-23 - Home units (doors), move-out, guests, door access

- New FE-owned `contract/ids/home_units.json` (+ `home_units.schema.json`, checked by `contract:check`): `units: [{unitId, district, tier, roomType, weeklyRentCents, capacity}]`. `unitId` is the door id, `flat:<buildingInstanceId>:<doorIndex>`; `tier` is `basement | flat | penthouse`. It ships six placeholder flat doors (`flat:midrise_01:0` to `flat:midrise_06:0`) for the Residences midrise buildings; the frontend replaces them with its real ids. The API upserts the file into the new `home_units` table (migration 082).
- Leasing (`POST /homes`) takes a free unit of the home's tier: `parents_basement` is `basement`, `hacker_house` and `studio` are `flat`, `penthouse` and `marina_villa` are `penthouse`. A full tier answers `409 NO_FREE_UNIT`. A tier with no units in the file leases as before with no door, so basement and penthouse keep working until doors are exported.
- `GET /me` adds `home: {homeId, unitId, tier, roomType, status, missedWeeks} | null`. `home.homeId` is the instance id (`home:<uuid>`); the existing top-level `homeId` is still the kind. The `POST /homes` and `POST /homes/{homeId}/rent` replies add `unitId, tier, roomType, status, missedWeeks`.
- Home `status`: `active`, `overdue`, `evicted`, `moved_out`. The weekly rent worker now sets `overdue` on a missed week (debt still accrues as before) and `evicted` after 4 missed weeks in a row; paying clears `overdue`. Late fees and the storage unit for belongings are not built yet.
- Added `POST /homes/{homeId}/move-out` (owner only; frees the unit, removes guests), `POST` and `DELETE /homes/{homeId}/guests/{userId}` (owner only, idempotent, reply `{homeId, guests}`) and `GET /units/{unitId}/access` -> `{canEnter, reason}` with `reason` one of `owner | guest | locked | vacant | evicted`. The answer is about the caller only.
- `POST /homes/{ownerId}/visit` now also returns `unitId` and `roomType`, and answers `403 FORBIDDEN` when the home has a door and the visitor is neither the owner nor a guest (no visit is logged). A home without a door stays open. The `home` realtime room applies the same rule on join (`FORBIDDEN`). The documented `roomId` reply was never returned; the openapi now shows the real body (`visitId, homeId, visitorUserId, visitedAt` plus the new fields) and the client joins `home` with `homeId`.
- New error codes `NO_FREE_UNIT` (409), `NOT_HOME_OWNER` (403), `UNIT_FULL` (409, a unit holds `capacity` people including the owner).
- `GET /homes/{id}` now answers by caller: the owner gets the full home and the recent visits (`view: 'owner'`); a guest gets `homeId, kind, tier, decoratedAt, unitId, roomType` (`'guest'`); anyone else gets `homeId, kind, tier, decoratedAt` only (`'public'`), with `visits: []`. Owner, status, rent, missed weeks, unit and visitors are no longer public. The `home` room now disconnects (code 4403) a client whose access is revoked (guest removed, move-out, eviction) instead of checking only on join.
- Migration 082 adds `home_units`, `home_guests` and `homes.unit_id, status, missed_weeks, ended_at`. Existing homes are `active` with no unit; one takes a free door the next time its owner pays rent.

## 2026-10-22 - v3 vehicle kinds, player entitlements, hovercar lease gate

- `VEHICLE_KINDS` adds `sedan`, `taxi`, `police`, `pickup`, `van` (60 m/s) and `bike` (25 m/s, like `moped`) for the frontend's v3 fleet. Until now the client sent them as `compact`.
- Added `GET /v1/me/entitlements` -> `{items: string[], updatedAt}`. The first key is `vehicle.hovercar`, the scarce right-to-drive pass for the `roadstar` kind (the v3 hovercar). It is granted while the player's wallet holds an asset in `HOVERCAR_COLLECTION` (a Metaplex Core collection, checked with Helius DAS `searchAssets` on this call, at most once a minute per player), or by an ops grant (`tools/scripts/entitlement-grant.ts`). Game Cash never grants it.
- The vehicles room refuses a `roadstar` lease without `vehicle.hovercar` with the new realtime code `NOT_ENTITLED` (403).
- New table `player_entitlements` (migration 081). New optional env `HOVERCAR_COLLECTION`; empty turns the wallet sync off.

## 2026-10-18 - Street rooms, island-wide vehicles, venue move fixes

- Venue `move`: players now join on the `.entrance` spot's own x/z. Speed is a distance budget from the last accepted move (refills at 6.5 m/s, 0.5 m slack, at most 1 s banked) instead of speed between arrivals; moves past it are clamped and applied, and the sender gets the new `corrected {x, z}`. Messages under 90 ms apart are no longer dropped (10/s with bursts of 5). A rejected `move` carries the server `x, z` when known.
- A player may hold two venue/street rooms at once; rooms do not de-duplicate users.
- Added the `street` room (`joinOrCreate("street", { token, district })`), one per district: `timeline | trenches | dubai_marina | boardwalk | airdrop_farm | builder_hills | breakpoint | residences | mountain | islet` (the ids in the frontend island plan). `StreetState { district, instanceId, players }`, same `PlayerState` and `move`/`emote`/`say`/`talking` as venues, x/z in island metres. Bounds come from the new FE-owned `contract/ids/districts.json`: `island` is a list of land polygons (coast, islet, causeway) and `districts` maps each id to its polygon. It is generated from the frontend's `tools/world/islandgen/out/plan.json` with `tools/scripts/import-districts.ts`; re-run it when the plan changes. Players within 30 m outside the polygon are still tracked so border crossings do not pop.
- Added the `vehicles` room (`joinOrCreate("vehicles", { token })`), one for the island. `VehiclesState.vehicles` is a map of `VehicleState { id, kind, driver, x, y, z, yaw, pitch, roll, speed, flags }`, filtered per client to vehicles within 250 m. Messages `vehicle_enter`, `vehicle_move`, `vehicle_exit`, `vehicle_hit`; server sends `vehicle_corrected` and relays `vehicle_hit` to the victim only. Per-kind caps and limits are in `docs/REALTIME.md`.
- `PlayerState` adds `ix, iz, irotY` (island pose, server-filled) at the end of the schema. Venue `move` accepts `island: true` to send island coordinates; `corrected`/`rejected` answer in the same frame, and the venue `welcome` adds `island {x, y, z, yaw}`. Venue placements come from `districts.json` (`venues`), generated from the island plan.
- Venue rooms on CT Island record each player's island position, so leaving a venue for the street is checked like any other move.
- Added FE-owned `contract/ids/parking.json` (`bays: [{id, kind, x, y, z, yaw}]`, yaw in radians). The vehicles room parks one server-owned vehicle per bay (id = bay id) and returns abandoned ones to their bay after 10 min when nobody is within 150 m. Empty until the frontend exports its bays.
- New realtime error codes: `OUT_OF_BOUNDS`, `UNKNOWN_EMOTE`, `SPOT_NOT_FOUND`, `NPC_NOT_FOUND` (already sent, now registered), `VEHICLE_TAKEN`, `VEHICLE_TOO_FAR`, `VEHICLE_LIMIT`, `NOT_DRIVER`, `ALREADY_DRIVING`, `POSITION_UNKNOWN`.

## 2026-10-17 - DM push, debt repayment, cash history, live perp PnL

- `POST /dms/{userId}` now pushes a realtime `dm` (`DmMessage`, `at` in epoch ms) to the recipient after the message commits. Blocked pairs still get `400` and nothing is pushed.
- Added `POST /bank/repay {amountCents}` -> `{repaidCents, cashCents, debtCents}`. Overpayment is capped at the debt. Errors `402 INSUFFICIENT_CASH` and new `409 NOTHING_TO_REPAY`.
- `GET /me` adds `debtDueAt` (next Sunday Unlock, Sun 20:00 UTC) and `debtWeeklyDueCents`, both null with no debt.
- Added `GET /ledger?before=&limit=` -> `{items: [{id, kind, amountCents, label, at}], next}`. `kind` is the ledger reason code; amounts are signed.
- Open perps in `GET /perps` carry `markMicros` and `unrealizedPnlCents`, computed with the same formula and price as close and liquidation.

## 2026-10-12 - Server-derived Space grants, spot pricing, payment reconciliation, paid ads

- `POST /rtc/token` derives Space publish rights from the stored role (host/speaker publish, everyone else subscribe-only), refuses ended or blocked Spaces, normalizes `space:` ids to one prefix and ignores client permission flags. Space tokens last 10 minutes.
- Spot trades price `price_micros` as micro-USD per base unit on both sides; a small buy then sell passes the same slippage cap. Response shapes are unchanged.
- `GET /payments/intents/{id}`: confirmed stays confirmed after expiry; a pending intent with a reported signature stays pending while it is reconciled from finalized chain data. 410 only when nothing was reported or found on chain.
- `POST /uploads` takes the raw `image/png`/`image/jpeg` body (was 415), re-encodes it without metadata and binds it to the uploader. `POST /ads/bookings` returns `{bookingId, intent, booking}` with a server-priced USDC intent; bookings go `awaiting_payment` -> `pending_review` (after a verified payment) -> `live` (admin). Added `GET /ads/bookings/{id}`, `POST /ads/bookings/{id}/cancel` and `GET /ads/slots/{id}/availability`; live ads carry a signed `imageUrl`. Rejected or cancelled paid bookings expose an owed-refund receipt.

## 2026-10-11 - Owned avatar delivery and dedicated USDC checkout

Added owned job resume, validated manifest/acceptance and optional `character.likenessJobId` persistence. Added immutable3-USDC checkout, finalized receipt verification, interrupted-payment recovery and delivery-owed/manual-review states. New generation and checkout remain disabled pending explicit provider end-user permission and runtime/storage provisioning. No Cash top-up behavior changes.

## 2026-10-11 - Private likeness pipeline contract

Added authenticated, default-disabled private photo ingestion/deletion, exact-preview
approval, job cancellation, private preview/result reads and durable job phase/hash
fields. Writes require idempotency keys. Rigged output remains awaiting validation;
no public generation, purchase or playable-result activation is included.

## 2026-10-11 - Dex/Nova palette capabilities

Added optional `characterPalettes` to `GET /v1/config`: finite per-head allowlists
for independently recolouring the existing UBC bodies. No new look slots or paid
shop items. Tightened character writes to reject extra look properties (breaking
for callers sending undocumented fields) and reject unknown/cross-body UBC
palette combinations. Existing seven-field authored looks remain compatible.

# Changelog

> Every change to the contract, in the order it is signed. Both teams read this before upgrading.

The contract is the OpenAPI spec, the Colyseus schemas, the ID registries, the config files and the Anchor IDL. A change is **additive** if the new field is optional, the new error code is new, the new message is new, or the new enum value is new. Anything else is a **breaking** change.

## 1.0.0-rc1

The first release candidate. Establishes the contract surface that the Unity client (FE) and the backend (BE) code against.

### Additive

- **`SERVER_BUSY` error code.** New error returned when the global login-concurrency limiter, the per-IP limiter, or any saturated dependency returns. HTTP `503` with a `Retry-After` header. The frontend builds a "city is busy, retrying" screen. (See `contract/ids/errors.json` and `contract/openapi.yaml`.)
- **`degraded: string[]` field on `GET /v1/config`.** A list of feature flags currently in degraded mode (e.g. `["voice", "llm", "feed"]`). The frontend reads it and disables those surfaces.
- **Multi-process realtime sharding (M3).** Multiple realtime processes, multiple `market` rooms fed by a single market leader via Redis pub/sub. The contract still says "market" room; the implementation sharded behind it. The frontend is unchanged.

### Breaking

- None.

## Unreleased

### Fixed (BE behaviour, no shape change)

- **Career progression is stored.** `POST /v1/shifts/{id}/complete` persists the XP it returns and promotes at the level threshold; `GET /v1/careers` and `POST /v1/careers/{id}/apply` return the stored `level`/`xp`, and shifts use the current level's pay. (GitHub #4)
- **Anon is hidden from the rich list.** `net_worth`, `weekly_pnl` and `weekly_return` exclude the `anon` tribe from `entries` in every scope. `GET /v1/leaderboards/{boardId}` now fills `me` with the caller's own row (their value and the rank they would hold), so an Anon player still sees their standing privately. (GitHub #4)
- **Origin home follows the lottery config.** Character creation sets `homeId` from `lottery.json` `outcomes[outcome].homeId` (insider → `studio`, seeker → `hacker_house`), not a hardcoded `skyrise` / `penthouse`. (GitHub #4)
- **Solana Pay URL amount is in user units.** `solanaPayUrl`'s `amount` is now `1` for 1 USDC; the intent's `amount` field and the unsigned `tx` stay in base units. (GitHub #4)

### Additive (character likeness preparation)

- Authenticated `GET /likeness`, `POST /likeness/jobs`, and `GET /likeness/jobs/{id}`. Public submission is disabled until provider, private upload, verified paid fulfillment, and runtime delivery are ready. A connected wallet is authentication only.
- `LIKENESS_UNAVAILABLE` (503) for the inactive provider path. Dedicated durable likeness entitlement/upload/job records do not reuse game-cash top-ups.


### Additive (FE-owned registries)

- **`ids/anims.json` 1.1.0:** 40 new animation IDs (sitting, phone, talk, dance, despair, liquidation set, tribe emotes, and `act_host_mic`, `act_listen_nod`, `emote_moon_jump`, `react_sad`). No renames or removals.
- **`ids/sfx.json` 1.1.0:** 34 new `sfx_*` IDs (UI, trading, stingers, phone, voice rooms, ORE refinery). No renames or removals.
- **`ids/spots.json` 1.1.0:** 22 venues (was 7) and 222 spots (was 38). Every existing spot ID is kept. Spots now carry `x`, `z`, `rotY` in metres/radians, and walkable rectangles match the FE greybox scenes.
