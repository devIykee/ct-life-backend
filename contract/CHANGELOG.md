## 2026-10-24 - Event calendar: opt-in IRL check-in at Breakpoint

Extends the event calendar entry below (same PR).

- Added `POST /events/{slug}/checkin {lat, lng, accuracyM, isMock}`, only during the event window. The server checks the position against the venue geofence and discards it: no coordinates, accuracy or distance are stored, logged or returned. Rejections are `422 CHECKIN_REJECTED` with `details.reason`: `mock_location` (`isMock` true), `poor_accuracy` (`accuracyM` > 150), `account_too_new` (account created at or after the event `startsAt`), `outside_geofence`, `not_available` (no geofence). Out of window is `409 EVENT_NOT_LIVE`. At most 3 attempts per player per hour (`429`). Reply `{slug, checkedIn, checkedInAt, visible, firstCheckin, reward}`; a repeat returns the same check-in with `firstCheckin: false`, `reward: null`.
- One-time IRL reward per player per event (and so per wallet): Cash (ledger reason `event_irl_bonus`, default 10000 cents, env `EVENT_IRL_BONUS_CENTS`) plus the off-chain, grant-only cosmetics `irl_badge_breakpoint_2026` and `lanyard_breakpoint_2026_gold` (slot `acc`, source `grant`).
- Added `PUT /events/{slug}/checkin/visibility {visible}` (default hidden; needs a check-in, else `404`) and `GET /events/{slug}/irl?limit=&cursor=` -> `{items: [{alias, look, tribeId, avatarId, checkedInAt}], next}`: opted-in attendees only, newest first, blocked users excluded both ways, no location and no user id.
- Realtime `irl_checkin {slug, alias, at}` on the city room when a player turns visibility on (alias only; once an hour per player, 10 burst and 2/s per event). It is scoped, not a raw broadcast: the city room skips signed-out sessions and every player who blocked the attendee or was blocked by them, and it is sent only while the event is live and the attendee is visible.
- `calendar_events.json` events gain optional `geofence {lat, lng, radiusM, source}` and `irlRewardItemKeys`. Breakpoint 2026: 51.49639, -0.20972, 350 m, coordinates from the Wikipedia article on Olympia London. `CalendarEvent` gains `irlCheckin` (true when a geofence exists). New error code `CHECKIN_REJECTED` (422).
- Request bodies and coordinate fields are now redacted from API logs. Migration 090 adds `event_checkins(event_id, user_id, checked_in_at, visible)` and `events.geo_*` (the venue's geofence). What is stored and why: `docs/PRIVACY_IRL_CHECKIN.md`.

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

## 2026-10-23 - Duo Shop: Cash goods and furniture, scheduled delivery, placements

Merge after the homes PR (#7): orders to the door use `homes.unit_id` and `home_units`, and placements use its door access rules.

- New FE-owned `contract/ids/shop_items.json` (+ `shop_items.schema.json`, checked by `contract:check`): `items: [{itemId, category, name, priceCents, deliverable, placeable, footprint {w,d,h}, modelKey}]`. `category` is `furniture | decor | appliance | food | clothing`; `footprint` (metres) is required exactly when `placeable` is true; `modelKey` is the frontend asset key. It ships 20 placeholder items with placeholder model keys (`shop_<itemId>`); the frontend replaces them. The API upserts the file into `shop_items` (migration 083); an item dropped from the file leaves the catalogue but stays in the table.
- Added `GET /shop/catalog?category=` -> `{items, lockerFeeCents, windows: [{id, minutes}]}`. The cosmetics `GET /shop` and `POST /shop/purchase` are unchanged.
- Added `POST /shop/orders {items: [{itemId, qty}], window: 'asap' | '30m' | '1h', destination: 'door' | 'locker'}` -> `201 ShopOrder`. It debits Cash (ledger reason `shop_order`) from catalogue prices, plus a 300 cent locker fee for `locker`; the client never sends a price. Windows are real time: asap 10 min, 30 min, 60 min; nothing shortens the wait. Limits: 10 lines, 1 to 10 of each, 20 units, 5 orders in flight (`VALIDATION_FAILED`). `door` needs a home with a door (`409 NO_HOME_DOOR`; a player on the street uses `locker`); short of Cash is `402 INSUFFICIENT_CASH`. Idempotent: a replayed `Idempotency-Key` returns the same order and charges once.
- Added `GET /shop/orders`, `GET /shop/orders/{id}` (owner only; someone else's id is `404`) and `POST /shop/orders/{id}/cancel` (owner only, only while `placed`, full refund with ledger reason `shop_refund`; `409 ORDER_NOT_CANCELLABLE` otherwise; a cancelled order is never delivered). `ShopOrder.status` is `placed | out_for_delivery | delivered | cancelled`.
- Delivery: a BullMQ worker moves an order to `out_for_delivery` 60 s before `etaAt` and to `delivered` at `etaAt`, with a per-minute sweep as a safety net. Realtime `delivery_out {orderId, destination, unitId, etaAt}` (courier leaves; `etaAt` epoch ms; `unitId` null for a locker) and `delivery_arrived {orderId, destination, unitId}` go to the player (`city` room, like `dm`). On arrival the items become `player_items`, one row per unit: owned off-chain, not NFTs, never tradable.
- Added `GET /me/items` -> `{items: [{itemInstanceId, itemId, name, category, modelKey, placeable, footprint, orderId, acquiredAt, placedHomeId}]}`.
- Added `PUT /homes/{homeId}/placements {placements: [{itemInstanceId, x, z, rotY}]}` (owner only; replaces the set; items must be owned, `placeable` and listed once; x and z within 200 m, yaw in radians) and `GET /homes/{homeId}/placements` for anyone who may enter the door (owner, guests; a home without a door is open), `403 FORBIDDEN` otherwise. Both answer `{homeId, placements: [{itemInstanceId, x, z, rotY, itemId, name, modelKey, footprint}]}`.
- New error codes `NO_HOME_DOOR` (409), `ORDER_NOT_CANCELLABLE` (409), `ITEM_NOT_OWNED` (403, also for an unknown id), `ITEM_NOT_PLACEABLE` (409), `ITEM_ALREADY_PLACED` (409).
- Migration 083 adds `shop_items`, `shop_orders`, `shop_order_items`, `player_items` and `home_placements`. Food and clothing are delivered and owned but have no use yet.

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
