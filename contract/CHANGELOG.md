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
