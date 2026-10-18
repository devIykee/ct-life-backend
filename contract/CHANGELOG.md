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
