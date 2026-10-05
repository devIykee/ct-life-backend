# CT Life backend: M4 continuation

  You are continuing work on CT Life, the CT Life backend. The previous sessions
  have completed M0 (foundation + smoke), the retrofit pass, M1 (the contract
  at tag contract-v1.0.0-rc1), M2 (DB migrations, server/shared infrastructure,
  REST API, npc-brain, server/realtime, server/workers, tools/bots,
  tools/econ-sim, and the M2 test layer), and M3 (markets migrations, market
  engine, cash top-ups, Terminal Cafe, Perp Pit, ORE Refinery, Launchpad
  Tower, Prediction Pit, Alpha Calls + Trust Score + Smart Money, DMs/Feed/
  Follows, and the M3 test layer). M4 has not started.

  ## Where to start

  1. Read `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/UNVERIFIED.md`,
     `docs/TEST_REPORT.md`, and `docs/RETROFIT_REPORT.md` to see the full
     state. The local `main` is in sync with `origin/main`; the most recent
     commit is the M3 closing commit ("milestone M3: markets, positions,
     perps, ORE, launchpad, predictions, alpha, social").
  2. Read `docs/spec/contract.md` and `docs/spec/build-spec.md` (the two
     spec tabs).
  3. `cd ~/coding/ct-life-backend` and `git log --oneline -25` to see the
     commit history.
  4. Run the static gates:
     `pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:check
      && pnpm boundary:check && pnpm contract:check`.
     They should all be green. M3 left:
       - `pnpm test:unit` 47/47 passed
       - `pnpm db:verify` 37/37 schema invariants passed
       - `pnpm exec tsx tools/scripts/smoke.ts` 7/7 required checks passed.
  5. Read `docs/REALTIME.md` for the room notes; `docs/CAPACITY.md` for the
     per-instance and global caps the M4 stress tests must respect.

  ## The rules (these override the master prompt where they conflict)

  - Nothing is mocked. Every endpoint, room, worker, ledger transaction, and
    on-chain flow must really work. Real Postgres, real Redis, real LiveKit,
    real Helius, real Solana transactions on devnet. Forbidden: handlers
    that return canned data, // TODO stubs, fake success paths, in-memory
    stand-ins for production stores, and tests that assert against mocks
    of the thing under test.
  - Never claim done without proof. A milestone is done only when its test
    gate passes and you have pasted the real command output into
    `docs/TEST_REPORT.md`.
  - Verify every pinned version before using it. Run `npm view <pkg>
    versions`. The spec's versions may be wrong; log deviations in
    `docs/DECISIONS.md`.
  - Server-authoritative, append-only money ledger from day one. The client
    is never trusted for amounts, prices, scores, positions or timing.
    Every Cash change is a ledger entry. Balances are derived from, and
    reconcilable with, the ledger.
  - SOLID is mandatory, applied pragmatically. Layering: transport →
    application → domain ← infrastructure. The domain layer imports
    nothing from transport or infrastructure. Enforce with
    `tools/scripts/boundary-check.ts` and the `no-restricted-imports` ESLint
    rule. Money is a value object (Cents, TokenAmount with bigint base
    units); no `number` for money in domain code. Errors are a typed
    domain hierarchy mapped to contract error codes at exactly one place,
    the transport boundary. Use a Unit of Work for ledger transactions.
  - Document everything, extensively, as you build. TSDoc on every exported
    function, class, interface, and type. State units explicitly (cents,
    base units, milliseconds, epoch ms vs ISO strings). A header comment
    at the top of every file explaining its role. A config file gets a
    sibling description in its JSON Schema. Comment the why on non-obvious
    logic, especially money math, locking, idempotency, LiveKit token
    grants, and Solana account validation.
  - Under overload, degrade features and shed load; never fall over, and
    never lose or corrupt money. Stateless API and workers. No in-process
    authoritative state besides Colyseus room state. Per-IP and global
    login-concurrency limits return SERVER_BUSY (HTTP 503, Retry-After
    header). Helius, price feed, LiveKit each get a timeout, circuit
    breaker and bulkhead. Runtime feature flags in Redis, exposed as
    `degraded: string[]` on `GET /v1/config`.
  - Secrets. All keys come from env vars. Commit only `.env.example`.
    Never log secrets, private keys or full JWTs. Treasury and settle
    authority keys are loaded from env/secret store. Devnet and mainnet
    keys are separate variables. Never put a mainnet signing key in a
    repo file.
  - Mainnet safety. ORE and Seeker Genesis Token features read mainnet
    even on staging. Tests that move real mainnet value are behind
    `RUN_MAINNET_TESTS=1`, default off, and use tiny amounts.
  - Work resumably. Update `docs/PROGRESS.md` after every command. After
    every milestone, commit with `milestone M4: <area>` (e.g. M4: voice
    token, M4: spaces, M4: paid calls). Close M4 with `milestone M4:
    <name>`. The closing commit must include the test report append and
    the `docs/PROGRESS.md` M4 = DONE update.

  ## M3 status (already done, don't redo)

  - 9 M3 commits, in order: migrations, market engine, cash top-ups,
    terminal cafe, perp pit, ORE refinery, launchpad, predictions, alpha
    calls, social, tests, milestone M3 closing.
  - Market engine is the single writer of `coins.price_micros` (Redis
    SETNX lock, 2 s tick, hidden arc, AMM). Cash top-ups flow through
    the Helius signed webhook. The 4 worker loops (payment poller,
    liquidation, predictions, alpha) run as 5–30 s setIntervals in the
    workers process.
  - 12 SQL migrations (010..021), 37/37 invariants in `pnpm db:verify`.
  - 47/47 unit tests pass; `pnpm test:unit` covers the engine, AMM,
    Helius webhook signature, alpha trust-score edge cases, and the
    M2 ledger / rate-limit / JWT / NPC brain suites.
  - All static gates green; `pnpm boundary:check` warns on four
    files (`auth.ts` 301, `market-engine.ts` 344, `perp-pit.ts` 372,
    `terminal-cafe.ts` 478) — these are domain objects, accepted.
  - The Helius SDK was dropped at M2 (incompatible peer dep on
    `@solana/kit ^6.9`; we pin 8.4). The webhook handler uses a thin
    fetch-based parser in `server/application/helius-webhook.ts`. That
    pattern is the template for M4 on-chain flows (tip on-chain, paid
    call escrow).
  - `docs/UNVERIFIED.md` continues to track the devnet airdrop, the ORE
    mainnet read, the SKR devnet mint, and the M3 SDK port.

  ## M3 commit log (most recent first)

  ```
  15f7cf6 milestone M3: markets, positions, perps, ORE, launchpad, predictions, alpha, social
  7824a21 M3: tests + bot M3 endpoints (#46)
  91a689c M3: DMs, Feed, Follows, smart-money opt-in flag (#45)
  bb9b271 M3: Alpha Calls + Trust Score + Smart Money (#44)
  1c5627f M3: Prediction Pit (binary bets at 5m/15m/1h/daily) (#43)
  ecbdbea M3: Launchpad Tower (coin creation, lifecycle, tombstones) (#42)
  f2f38c4 M3: ORE Refinery (board reader, stake builder, miner badge) (#41)
  c68504c M3: Perp Pit (perpetuals, liquidations, REKT card) (#40)
  7af3110 M3: Terminal Cafe (markets, positions, trades) (#39)
  e602d46 M3: cash top-ups (Solana Pay + Helius webhook) (#38)
  2f4da07 M3: market engine (#37)
  76c98d5 M3: migrations for the markets layer (#36)
  3a80b7d M2: workers (BullMQ), bots, econ-sim, tests #32-#35
  0e01514 M2: server/realtime (Colyseus city, market, venue rooms; full message handlers)
  c39a02f M2: packages/npc-brain (9 archetypes as pure state machines)
  ff52b9f M2: REST API (auth, core, social, work, ops routes; full e2e)
  25aad5b M2: server/shared infrastructure (config, db+UoW, redis, jwt, helius, livekit, s3, idempotency, rate limit)
  9359975 M2: migrations (db schema + verifier)
  160d59e milestone M1: the contract (v1.0.0-rc1)
  ```

  ## M3 layered architecture in place (over the M2 foundation)

  - `server/shared/domain` — pure value objects (Cents, TokenAmount,
    Clock, Rng, uuidv7, error hierarchy). Imports nothing from outside.
  - `server/shared/{config,db,redis,auth,solana,livekit,s3,logger,infra}` —
    leaf modules. Boundary check forbids domain → transport/infra imports.
  - `server/application` — AuthService, CharacterService, LotteryService,
    NeedsService, PublicProfileService, BlocksService, ReportsService,
    BoardsService, CareersService, ShiftsService, DailyClueService,
    MarketEngine (with `amm.ts` and `hidden-arc.ts`), TopupService,
    HeliusWebhookService, TerminalCafeService, PerpPitService,
    ORE RefineryService, LaunchpadService, PredictionsService,
    AlphaService, SocialGraphService. Plus `context.ts` (AppContext).
  - `server/api` — Fastify composition root, middleware (auth,
    idempotency), routes (auth, core, social, work, ops, payments, markets,
    perps, ore, predictions, alpha, social-graph). The Helius webhook
    route is wired with a raw-body content-type parser for HMAC
    verification.
  - `server/realtime` — Colyseus schemas, CityRoom, MarketRoom, VenueRoom
    (with all 8 message handlers), realtime main.ts.
  - `server/workers` — BullMQ composition root, plus four setInterval
    workers: payment poller, liquidation, predictions, alpha.
  - `db/migrations` — 12 SQL files, append-only trigger, idempotency
    unique.

  ## M4 status (in flight, the focus of this session)

  Done:

  - M0: foundation + smoke. Postgres on 5434, Redis on 6381, LiveKit
    dev server on 7880 (binary from .runtime/), MinIO on 9000
    (binary from .runtime/). `.env` populated.
  - M1: the contract at `contract-v1.0.0-rc1` (tagged). `contract/
    openapi.yaml` declares the M4 endpoints (rtc, spaces, video-calls,
    creator, paid-calls, tips, homes, push, meta) with `x-phase: 3`
    except homes which is `x-phase: 4`. Realtime `contract/realtime/*`
    carries the `SpaceState`, `VideoCallState`, `HomeState` schemas
    and the corresponding message types. `pnpm contract:check` is green.
  - M2: every M2 task committed (#27-#35). 32/32 vitest, 7/7 smoke,
    15/15 db:verify, all static gates green.
  - M3: every M3 task committed (#36-#46). 47/47 vitest, 7/7 smoke,
    37/37 db:verify, all static gates green.

  Pending (the M4 work to finish in this session):

  #: 47
  Task: Migrations for the voice + social layer
  What's needed: db/migrations/022{0..9}_*.sql.
    022_voice_rooms (room_id text PK `{kind}:{id}`, host_user_id FK,
      kind in 'space'|'video'|'paid_call', title text, status in
      'live'|'ended', started_at timestamptz, ended_at timestamptz
      nullable, max_speakers smallint default 8, requires_payment bool
      default false, price_per_minute_cents bigint nullable,
      created_at timestamptz default now(); index (status, started_at
      desc) for the live list).
    023_voice_speakers (speaker_id uuid PK, room_id text FK, user_id FK,
      role in 'host'|'speaker'|'listener', joined_at timestamptz,
      left_at timestamptz nullable, hand_raised_at timestamptz nullable;
      index (room_id, user_id) unique where left_at is null).
    024_paid_call_escrow (escrow_id uuid PK, call_id text FK, payer_user_id
      FK, payee_user_id FK, total_cents bigint, settled_cents bigint
      default 0, status in 'pending'|'active'|'settled'|'refunded'|
      'disputed', settlement_tx_signature text nullable, started_at
      timestamptz, ended_at timestamptz nullable; index (status),
      (payer_user_id), (payee_user_id)).
    025_creator_profiles (user_id PK FK, handle text unique, bio text,
      banner_image_key text nullable, avatar_image_key text nullable,
      categories text[] default '{}', created_at timestamptz default
      now()).
    026_homes (home_id text PK, owner_user_id FK, kind in 'parents_basement'
      |'hacker_house'|'studio'|'penthouse'|'marina_villa', rent_cents_per_week
      bigint, decorated_at timestamptz nullable, last_rent_paid_at
      timestamptz nullable, created_at timestamptz default now();
      index (owner_user_id)).
    027_home_visits (visit_id uuid PK, home_id text FK, visitor_user_id FK,
      visited_at timestamptz default now(); index (home_id, visited_at
      desc), (visitor_user_id, visited_at desc)).
    028_tips (tip_id uuid PK, from_user_id FK, to_user_id FK, kind in
      'cash'|'onchain', amount_cents bigint nullable for cash, amount_lamports
      bigint nullable for onchain, mint text nullable, signature text
      unique nullable for onchain, message text max 200 nullable,
      created_at timestamptz default now(); index (to_user_id, created_at
      desc)).
    029_push_devices (device_id uuid PK, user_id FK, platform in 'ios'
      |'android'|'web', apns_token text nullable, fcm_token text nullable,
      enabled bool default true, created_at timestamptz default now(),
      updated_at timestamptz default now(); index (user_id, enabled)).
    030_meta (key text PK, value jsonb, updated_at timestamptz default
      now()).
  Update pnpm db:verify to assert: voice_rooms.kind in allowed set;
  voice_speakers.role in allowed set; paid_call_escrow.status in
  allowed set; creator_profiles.handle UNIQUE; homes.kind in allowed
  set; tips.kind in allowed set; tips either (amount_cents > 0 for
  cash) or (amount_lamports > 0 for onchain), enforced by CHECK
  ((kind = 'cash' AND amount_cents > 0) OR (kind = 'onchain' AND
  amount_lamports > 0)); push_devices.platform in allowed set.
  Migrate via `pnpm db:migrate`. Re-run `pnpm db:verify` to confirm.

  #: 48
  Task: LiveKit room service + RTC token minting
  What's needed: server/application/livekit.ts. `mintRtcToken(ctx, {
  userId, kind, id })` returns `{ token, url, roomName, identity }`. The
  token is built with `livekit-server-sdk@2.19.1` AccessToken. Room name
  is `{kind}:{id}`. Identity is the userId. `canPublish` defaults to
  true; spaces start listeners at false and the host promotes them
  (the openapi `/v1/spaces/{id}/speakers/{userId}` POST is the promote
  endpoint). TTL is 1 hour. The service is the only writer of room
  metadata. Tests in `server/application/livekit.test.ts`: positive
  (token decodes to the expected grants), negative (TTL expiry),
  and the promote-acts-on-server-state path.

  #: 49
  Task: Spaces (host + speakers + hand-raising + end)
  What's needed: server/application/spaces.ts. Endpoints:
    POST /v1/spaces               — create; mints the host token, sets
      voice_rooms row, sets host as the first voice_speakers row
    GET  /v1/spaces               — list live spaces (status='live',
      started_at desc, 50/page)
    GET  /v1/spaces/{id}          — get a space; returns room, host,
      current speakers, hand queue
    POST /v1/spaces/{id}/hand     — raise hand; flips hand_raised_at on
      the speaker row
    GET  /v1/spaces/{id}/speakers — list current speakers
    POST /v1/spaces/{id}/speakers/{userId} — host promotes a listener
      to speaker (and mints a token with canPublish=true); throws
      ForbiddenError if the caller is not the host
    DELETE /v1/spaces/{id}/speakers/{userId} — host demotes a speaker
    POST /v1/spaces/{id}/end      — host ends; sets status='ended',
      ended_at=now(), closes the LiveKit room
  The Spaces Room is a Colyseus room (state schema already in
  `contract/realtime/states.ts` as `SpaceState`). The handler uses
  the LiveKit room service HTTP API to set the participant
  permissions. Realtime capacity per instance: 200 spaces, each
  with up to 8 speakers. Tests: promotion permission, hand-raise
  queue ordering, end-closes-LiveKit-room.

  #: 50
  Task: Video calls (free 1:1 and group)
  What's needed: server/application/video-calls.ts. Endpoints:
    POST /v1/video-calls         — start a 1:1 or group call
    GET  /v1/video-calls         — list the user's active calls
    POST /v1/video-calls/{id}/end — end the call
  The call is a voice_rooms row with kind='video'. The call's
  speakers are the participants. No payment is required. Capacity
  per call: 8. The endpoint mints a LiveKit token for each
  participant and returns the URL + tokens. Tests: 1:1 call setup,
  group call setup, end-closes-LiveKit-room.

  #: 51
  Task: Creator profile + paid calls (escrow + settlement)
  What's needed: server/application/creator.ts +
  server/application/paid-calls.ts. Endpoints:
    POST /v1/creator             — create a creator profile (one per
      user; UNIQUE on handle)
    GET  /v1/creator/{handle}    — public read
    PATCH /v1/creator            — update bio, banner, avatar, categories
    POST /v1/paid-calls          — start a paid call: creates a
      voice_rooms row (kind='paid_call', requires_payment=true,
      price_per_minute_cents), creates a paid_call_escrow row
      (status='pending'), returns the call id + the LiveKit URL +
      token for the caller (caller cannot publish until escrow is
      funded)
    POST /v1/paid-calls/{id}/submitted — caller posts the escrow
      funding tx signature; service updates paid_call_escrow
      (status='active', settlement_tx_signature), flips the call
      room to allow canPublish
    POST /v1/paid-calls/{id}/accept   — payee accepts the incoming call
    POST /v1/paid-calls/{id}/decline  — payee declines; service marks
      escrow 'refunded' (the refund path returns the caller's funds)
    POST /v1/paid-calls/{id}/end      — either side ends; service
      computes settled_cents = ceil(seconds * price_per_minute_cents /
      60), writes 'tip' ledger row (M4 #54) for the settled amount
      minus the 5% protocol fee, marks the escrow 'settled'
    GET  /v1/paid-calls/{id}     — return the call + escrow state
  The settlement uses the same Helius webhook path as cash top-ups
  (`payment_intents` with kind='paid_call'); the spec routes the
  escrow credit through the same idempotency story. The M4 dev
  path stubs the on-chain legs and credits the ledger locally;
  the production port is the same pattern as the M3 cash topup
  but the `reference` is the call id. The 5% fee is recorded as
  a separate 'fee' ledger row. Tests: paid call happy path
  (caller posts sig → payee accepts → end → settled), timeout
  (no end → escrow remains 'active'), decline path (refund),
  settled amount math.

  #: 52
  Task: Homes (rent, visit, decorate)
  What's needed: server/application/homes.ts. Endpoints:
    POST /v1/homes                    — create (kind + initial rent
      debit; the lottery already grants the home, so this is
      effectively an explicit "buy" or "upgrade")
    POST /v1/homes/{homeId}/rent      — weekly rent; debits
      rent_cents_per_week from the owner's cash via the 'rent'
      ledger row, sets last_rent_paid_at=now()
    POST /v1/homes/{ownerId}/visit    — record a visit; appends a
      home_visits row
    GET  /v1/homes/{id}               — get a home + recent visits
  Rent runs at Monday 00:00 UTC (the spec's mondayResetCron). The
  M4 worker (server/workers/rent.ts) iterates all homes, debits
  the weekly rent, and writes the 'rent' ledger row. Missed rent
  increases `debt_cents` on the balances row (exit-liquidity baby
  semantics). Tests: rent debit, missed-rent debt, visit append.

  #: 53
  Task: Tips (cash + on-chain)
  What's needed: server/application/tips.ts. Endpoints:
    POST /v1/tips             — cash tip: writes a 'tip' ledger row
      (credit the recipient's cash), `kind='cash'`, `amount_cents`
    POST /v1/tips/onchain     — on-chain tip: returns a memo +
      recipient + amount, marks the row pending; the Helius webhook
      credits the recipient's cash on confirmed credit (same path
      as the M3 cash topup, with the `topup` reason replaced by
      `tip_onchain_credit`)
    GET  /v1/tips?toUserId=&limit=50 — list recent tips to a user
  Tests: cash tip credits the ledger, on-chain tip pending →
  confirmed path (the M3 webhook is reused; the receiver's tip row
  transitions to 'confirmed' once the credit lands).

  #: 54
  Task: Push, Meta, Ad booking (Phase 5 prep)
  What's needed: server/application/push.ts +
  server/application/meta.ts + server/application/ads.ts. Endpoints:
    POST /v1/push/register           — register a device (apns or
      fcm token); upserts push_devices
    GET  /v1/meta/current            — return the current weekly
      meta (the row in `meta` with key='current')
    POST /v1/admin/meta              — set the meta row (admin only)
    GET  /v1/ads/live                — list live ad slots
    GET  /v1/ads/slots               — list all slots
    POST /v1/ads/bookings            — book a slot; reserves the
      creative key in S3, writes the ad_bookings row
  Phase 5 builds the booking / moderation flow; the M4 slice
  registers the endpoints and the meta row. Tests: device
  upsert, meta read, ad slot listing.

  #: 55
  Task: Spaces + Video Room realtime integration
  What's needed: server/realtime/rooms/space.ts +
  server/realtime/rooms/video-call.ts. Each Colyseus room wires
  the participants to the LiveKit token grants (server/application
  /livekit.ts is the only writer of permissions). The
  SpaceState carries the speaker list + the hand-queue; the
  VideoCallState carries the participant list. Realtime capacity
  per instance: 200 spaces, 100 video calls. Tests: a Colyseus
  room joins, raises hand, host promotes, the room state updates
  to reflect the new canPublish grant; the call ends and the
  LiveKit room closes.

  #: 56
  Task: Webhooks (LiveKit + ORE)
  What's needed: server/application/livekit-webhook.ts +
  server/application/ore-webhook.ts. The LiveKit webhook fires on
  participant join/leave, track published, room finished. The
  handler verifies the JWT in the `Authorization` header (the
  LiveKit webhook secret is `LIVEKIT_WEBHOOK_SECRET`). On room
  finished, mark the corresponding voice_rooms row 'ended'. On
  participant left, mark the voice_speakers row with left_at=now().
  The ORE webhook (separate from the daily board reader) is the
  upstream of the cache: when ORE pushes a round end, the worker
  updates the cached board and emits a city room 'ore_round_end'
  event. Both webhooks are idempotent on (source, signature) via
  the existing webhook_events UNIQUE. Tests: LiveKit signature
  positive/negative, room-finished → status='ended',
  participant-left → speaker row updated.

  #: 57
  Task: Tests + load + bot e2e
  What's needed: Unit: every M4 service (LiveKit token grants,
  Spaces promote / hand-raise / end, paid call escrow math, rent
  weekly debit, tip credit, push upsert, meta read). Integration:
  every new endpoint, every error code, idempotent replay. The
  bot world is extended with createHome → visitHome → tipBot →
  startSpaceBot → joinSpace → raiseHand → endSpace paths. The
  M4 deep load test runs 100 bots across 4 space instances for
  5 minutes, recording p50/p95 REST latency, room tick lag, and
  bytes/s per client. Performance: a tools/scripts/microbench.ts
  that measures p50/p95 REST latency on /v1/me under the bot
  load. Realtime: 200 bots across 4 venue instances is the M3 gate
  that the M4 session re-runs to confirm no regression.

  ## M4 gate requirements (all must pass before closing M4)

  1. Unit tests for the LiveKit token, spaces promote/hand/end,
     paid-call escrow math, rent debit, tip credit, push upsert,
     meta read, webhook signature (positive + negative), and the
     new invariant assertions in pnpm db:verify.
  2. API integration tests for every new endpoint including every
     error code and idempotent replay.
  3. Contract: openapi.yaml carries the new endpoints; pnpm
     contract:check is green; pnpm docs:check passes.
  4. Realtime load: 100 bots across 4 space instances for 5
     minutes; record p50/p95 REST latency, room tick lag,
     bytes/s per client.
  5. Helius-slow: a synthetic delay in the Helius client still
     results in successful paid-call settlement (the on-chain leg
     is async via webhook + reconciler).
  6. The M2/M3 deep integration tests still pass: move validation,
     sit/stand with SPOT_TAKEN, emote rate, say sanitisation,
     npc_tap on Giveaway Guy.
  7. pnpm db:verify is green with the new M4 invariants.

  ## Reporting format (for docs/TEST_REPORT.md)

  Append a section to docs/TEST_REPORT.md at the end of the M4 gate
  with:

  1. Milestone name, commit hash, date.
  2. The exact commands run and the real output trimmed to
     pass/fail counts and any failures.
  3. Measured numbers (LiveKit token mint latency, paid-call
     settlement round-trip, p50/p95 REST latency, room tick lag,
     bytes/s per client).
  4. New entries added to DECISIONS.md, UNVERIFIED.md, and
     docs/adr/.
  5. Documentation created or updated this milestone, and the
     result of the docs-check and boundary-check.
  6. SOLID self-review: any module over the size limits (40
     lines/function, 300 lines/file) or crossing a layer boundary,
     with justification or the refactor.
  7. Anything in the spec believed to be wrong, inconsistent or
     risky, with a proposed fix. Flag spec problems; do not silently
     work around them.

  ## Pinned versions (verify before using; the M2/M3 pin list is unchanged)

  - Node 22+
  - TypeScript 5.9.3
  - Fastify 5.12.5
  - Colyseus 0.18.9, @colyseus/redis-presence 0.18.5,
    @colyseus/redis-driver 0.18.4, @colyseus/schema 5.0.36,
    @colyseus/sdk 0.18.5, @colyseus/testing 0.18.6,
    @colyseus/ws-transport 0.18.4
  - BullMQ 6.3.11
  - @solana/kit 8.4.0
  - @anchor-lang/core 1.2.0
  - Anchor CLI: spec says 1.2.0 but it does not exist; installed is
    1.1.2. Use 1.1.2.
  - Solana CLI: spec says 4.1.2 but it does not exist; installed is
    3.1.10. Use 3.1.10; M3 may install 4.3.0.
  - livekit-server-sdk 2.19.1
  - openapi-generator v7.25.0 (via
    @openapitools/openapi-generator-cli; needs Java 21)
  - ore-api 3.8.25, ore-stake-api 0.3.0 (Rust crates, reference only)
  - @solana/web3.js 1.99.x

  The livekit-server binary v1.13.7 is downloaded from GitHub to
  .runtime/livekit-server and the MinIO binary RELEASE.2025-09-07T16-
  13-09Z is downloaded to .runtime/minio. Both are gitignored.

  ## Environment

  - Repo: ~/coding/ct-life-backend
  - Branch: main
  - GitHub: https://github.com/deviykee/ct-life-backend (private)
  - Author: deviykee eokorie1911@gmail.com on every commit
  - License: MIT (LICENSE at the repo root)
  - LiveKit dev server runs as a process under .runtime/livekit-server
    (port 7880).
  - MinIO runs as a process under .runtime/minio (port 9000).
  - Postgres runs in Docker on host port 5434.
  - Redis runs in Docker on host port 6381.
  - The mock Compose profile starts the bot population in
    timeline_square with ENABLE_DEV_AUTH=true.
  - pnpm dev:up is the canonical way to bring the stack healthy.

  ## Known limitations and workarounds

  - Devnet airdrop is per-IP rate-limited by the public Solana
    faucet. The smoke treats it as informational. For the bot
    e2e, fund the devnet wallets via https://faucet.solana.com
    once each, or use a local validator. Recorded in
    docs/UNVERIFIED.md.
  - Docker Hub is pull-restricted in this dev environment for
    minio/minio, minio/mc, and livekit/livekit. Workaround:
    download MinIO and LiveKit binaries from their GitHub releases
    and run as processes (see above). CI (GitHub Actions) has
    unblocked Docker Hub and the compose file works there.
  - @coral-xyz/anchor on npm goes only to 0.32.1. The spec's
    "Anchor 1.2.0" does not exist on npm. Use
    @coral-xyz/anchor@0.32.1 for any TypeScript client code that
    needs Anchor IDL decoding. Pair with anchor-lang = "0.31.1"
    Rust crate.
  - The official helius-sdk@3.2.0 has an incompatible peer dep on
    @solana/kit ^6.9 but we pin 8.4. M2 dropped the SDK in favour
    of the thin fetch-based client in server/shared/solana/helius.ts
    + server/application/helius-webhook.ts. M4 paid-call escrow
    reuses the same pattern; production port of the
    parsed-transaction helpers is M5+ if it materialises.
  - No public Solana test validator is required for the M4 bot
    e2e. If the devnet airdrop is unavailable, run
    solana-test-validator locally and point SOLANA_RPC_URL_DEVNET
    at it.
  - The ORE board reader (M3 #41) hits mainnet; tests that
    actually call it are gated by RUN_MAINNET_TESTS=1. The M4
    ORE webhook shares the same flag.

  ## Next action

  Start with M4 #47 (db/migrations for the voice + social layer).
  Migrations are the foundation: every M4 service depends on
  voice_rooms, voice_speakers, paid_call_escrow, creator_profiles,
  homes, home_visits, tips, push_devices, and meta. Then M4 #48
  (LiveKit token) is the gate every realtime flow depends on. Then
  M4 #49 (Spaces) which exercises the room + token + Colyseus
  stack end-to-end. Then M4 #50 (video calls), #51 (paid calls +
  creator), #52 (homes), #53 (tips), #54 (push/meta/ads), #55
  (room realtime), #56 (webhooks), #57 (tests + load). Close M4
  with M4: <name> after the M4 gate passes and the test report
  append and the PROGRESS.md update are committed.

  Update docs/PROGRESS.md after every command. Commit each
  milestone group with M4: <area> (e.g. M4: voice token, M4:
  spaces, M4: paid calls, M4: homes, M4: tips, M4: push meta ads,
  M4: webhooks, M4: tests). Close M4 with M4: <name>. The closing
  commit must include the test report append and the
  PROGRESS.md M4 = DONE update.

  ---

  ## Notes for whoever picks this up next

  - M3 left a verified, layered codebase. The boundary check
    (pnpm boundary:check) is the single best indicator that a new
    file respects the layering — run it after every file you add.
    The contract check (pnpm contract:check) is the single best
    indicator that the openapi.yaml and contract/realtime/*.ts
    stay in sync with the implementation. Run both.
  - The LiveKit server in .runtime/livekit-server is the dev
    server. Production uses LiveKit Cloud; the SDK talks to either
    via the same token API.
  - The M3 cash-topup / Helius webhook is the template for the M4
    paid-call escrow funding path. The escrow is `status='active'`
    when the funding signature lands; the settlement writes a
    `tip` ledger row for the settled amount minus the 5% fee.
  - The M3 append-only ledger trigger is the hard floor. Every M4
    service that touches cash (rent, tips, paid-call settlement,
    fees) must run inside `runInTransaction` and write a ledger
    row. Tests assert the conservation invariant:
    sum(ledger.delta_cents WHERE user_id = X) == balances.cash_cents
    for every X.
  - The M3 deep load test (200 bots across 4 instances for 5
    minutes) re-runs at M4 to confirm no regression; the M4 load
    test (100 bots across 4 space instances for 5 minutes) is the
    new gate. Use `pnpm tsx tools/bots/world.ts --bots 200
    --venue timeline_square` for the venue regression, and a
    parallel `pnpm tsx tools/bots/world.ts --bots 100 --space
    <spaceId>` for the space load.
  - Spaces capacity is 200 instances of 8 speakers = 1600
    concurrent speakers per realtime process. The capacity doc
    (docs/CAPACITY.md) is the source of truth; the load runner
    asserts the cap is honoured.
  - The "no mocks" rule means the LiveKit dev server is the
    production stand-in for the M4 dev path; production swaps the
    URL/API key/secret via env vars. M4 tests must connect to
    the real dev server and assert token grants are honoured.
  - The contract integration checklist is the M4 spec's
    acceptance gate. Phase 3 endpoints (spaces, video-calls,
    creator, paid-calls) and the homes endpoint (Phase 4) are the
    new work. Automate them in pnpm test:integration where
    possible, and document the rest in the M4 closing commit
    message.
