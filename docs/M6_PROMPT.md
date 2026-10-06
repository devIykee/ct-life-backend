# CT Life backend: M6 continuation

You are continuing work on CT Life, the CT Life backend. The previous
sessions have completed M0 (foundation + smoke), the retrofit pass,
M1 (the contract at tag contract-v1.0.0-rc1), M2 (DB migrations,
server/shared infrastructure, REST API, npc-brain, server/realtime,
server/workers, tools/bots, tools/econ-sim, and the M2 test layer),
M3 (markets migrations, market engine, cash top-ups, Terminal Cafe,
Perp Pit, ORE Refinery, Launchpad Tower, Prediction Pit, Alpha Calls

- Trust Score + Smart Money, DMs/Feed/Follows, and the M3 test layer),
  M4 (voice + social migrations, LiveKit room service + RTC tokens,
  Spaces, free video calls, creator profile + paid calls + escrow +
  settlement, homes + rent, tips cash + on-chain, push/meta/ads Phase 5
  prep, Spaces + Video Room realtime integration, LiveKit + ORE
  webhooks, and the M4 test + bot slice), and M5 (Phase 4 + Phase 5:
  cosmetics shop + inventory, daily clue + Sunday Unlock worker, season
  pass, player businesses + bad days, gigs, ads full + creative uploads,
  player projects, cosmetic NFTs, VC Row + Builder Hills venues, weekly
  meta rotation, tests + load + bot e2e + closing slice). M5 closed at
  commit M5 #69 (tests + load + bot e2e + closing slice) plus M5 #70
  (FE-owned registry entries pulled in clean). M6 has not started.

## Where to start

1. Read `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/UNVERIFIED.md`,
   `docs/TEST_REPORT.md`, and `docs/RETROFIT_REPORT.md` to see the
   full state. The local `main` is in sync with `origin/main`; the
   most recent commits are the M5 closing slice plus the M5 #70
   FE-registry pull.
2. Read `docs/spec/contract.md` and `docs/spec/build-spec.md` (the
   two spec tabs). The contract carries Phase 4 + Phase 5 endpoints
   and the realtime schemas for `SpaceState`, `VideoCallState`,
   `BusinessState`, `HomeState`, plus the new VC Row / Builder Hills
   schemas M5 added.
3. `cd ~/coding/ct-life-backend` and `git log --oneline -30` to see
   the commit history.
4. Run the static gates:
   `pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:check
 && pnpm boundary:check && pnpm contract:check`.
   They should all be green. M5 left:
   - `pnpm test:unit` 169/169 passed (across 27 files)
   - `pnpm db:verify` 99/99 schema invariants passed
   - `pnpm exec tsx tools/scripts/smoke.ts` 7/7 required checks passed
5. Read `docs/REALTIME.md` for the room notes; `docs/CAPACITY.md`
   for the per-instance and global caps the M6 stress tests must
   respect; `docs/ECONOMY.md` for the cash/sink/faucet ledger; and
   `docs/OPERATIONS.md` for the feature flags + kill switches.

## The rules (these override the master prompt where they conflict)

- Nothing is mocked. Every endpoint, room, worker, ledger
  transaction, and on-chain flow must really work. Real Postgres,
  real Redis, real LiveKit, real Helius, real Solana transactions
  on devnet. Forbidden: handlers that return canned data, // TODO
  stubs, fake success paths, in-memory stand-ins for production
  stores, and tests that assert against mocks of the thing under
  test.
- Never claim done without proof. A milestone is done only when
  its test gate passes and you have pasted the real command
  output into `docs/TEST_REPORT.md`.
- Verify every pinned version before using it. Run `npm view <pkg>
versions`. The spec's versions may be wrong; log deviations in
  `docs/DECISIONS.md`.
- Server-authoritative, append-only money ledger from day one. The
  client is never trusted for amounts, prices, scores, positions,
  business income, project eligibility or timing. Every Cash change
  is a ledger entry. Balances are derived from, and reconcilable
  with, the ledger. Conservation is a property of the system,
  not an assumption.
- SOLID is mandatory, applied pragmatically. Layering: transport
  → application → domain ← infrastructure. The domain layer
  imports nothing from transport or infrastructure. Enforce with
  `tools/scripts/boundary-check.ts` and the `no-restricted-imports`
  ESLint rule. Money is a value object (Cents, TokenAmount with
  bigint base units); no `number` for money in domain code.
  Errors are a typed domain hierarchy mapped to contract error
  codes at exactly one place, the transport boundary. Use a Unit
  of Work for ledger transactions; the M3 lessons apply: webhook
  handlers do NOT need SERIALIZABLE and should use plain
  `ctx.db.withConnection` because the SET TRANSACTION statements
  can themselves abort the transaction when the cached DB has
  a stale snapshot.
- Document everything, extensively, as you build. TSDoc on every
  exported function, class, interface, and type. State units
  explicitly (cents, base units, milliseconds, epoch ms vs ISO
  strings). A header comment at the top of every file explaining
  its role. A config file gets a sibling description in its JSON
  Schema. Comment the why on non-obvious logic, especially
  money math, locking, idempotency, LiveKit token grants, Solana
  account validation, Metaplex Core CPI accounts, and the
  Sunday Unlock + Weekly Meta rotation.
- Under overload, degrade features and shed load; never fall
  over, and never lose or corrupt money. Stateless API and
  workers. No in-process authoritative state besides Colyseus
  room state. Per-IP and global login-concurrency limits return
  SERVER_BUSY (HTTP 503, Retry-After header). Helius, price feed,
  LiveKit each get a timeout, circuit breaker and bulkhead.
  Runtime feature flags in Redis, exposed as `degraded: string[]`
  on `GET /v1/config`.
- Secrets. All keys come from env vars. Commit only `.env.example`.
  Never log secrets, private keys or full JWTs. Treasury and
  settle authority keys are loaded from env/secret store.
  Devnet and mainnet keys are separate variables. Never put a
  mainnet signing key in a repo file.
- Mainnet safety. ORE and Seeker Genesis Token features read
  mainnet even on staging. Tests that move real mainnet value
  are behind `RUN_MAINNET_TESTS=1`, default off, and use tiny
  amounts. Cosmetic NFT mints default to devnet; the mainnet
  mint flow is gated behind `RUN_MAINNET_TESTS=1`.
- No AI authorship attribution. Do not add `Co-Authored-By: …`
  trailers, AI session URLs, or any other markers in commit
  messages, file headers, or comments. The commit author is the
  human developer; the commit body describes the work.
- Work resumably. Update `docs/PROGRESS.md` after every command.
  After every milestone, commit with `M6: <area>` (e.g. M6: vc-trading,
  M6: project-hq, M6: live-trades). Close M6 with `milestone M6:
<name>`. The closing commit must include the test report
  append and the `docs/PROGRESS.md` M6 = DONE update.

## M5 status (already done, don't redo)

- 14 M5 commits, in order: migrations, cosmetics shop + inventory,
  daily clue + Sunday Unlock worker, season pass, player businesses
  - bad days, gigs, ads full + creative uploads, player projects,
    cosmetic NFTs, VC Row + Builder Hills venues (NPCs), tests + load
  - bot e2e + closing slice, plus the FE-registry additive pull
    (clean re-import of the FE-side anim/sfx/spots).
- 36 SQL migrations (001..045), 99/99 invariants in `pnpm db:verify`.
  Append-only trigger on `ledger_entries`, idempotency UNIQUE on
  `webhook_events(source, signature)`. The new M5 tables (daily_clue,
  season_pass, cosmetic_items + inventory, businesses + business_days,
  gig_runs, ad_slots + bookings + creatives, projects + hires, nft_mints,
  meta_jobs) all carry the CHECKs and UNIQUE constraints the M5
  services depend on.
- Market engine is the single writer of `coins.price_micros`.
  5 worker loops (payment poller, liquidation, predictions, alpha,
  rent) plus the new Sunday Unlock + Weekly Meta rotation (M5 #60/#68).
- 169/169 unit tests pass across 27 files; `pnpm db:verify` is 99/99;
  `pnpm contract:check` is green.
- All static gates green; `pnpm boundary:check` is clean.
- The Helius SDK was dropped at M2 (incompatible peer dep on
  `@solana/kit ^6.9`; we pin 8.4). The webhook handler uses a
  thin fetch-based parser in `server/application/helius-webhook.ts`.
  That pattern is the template for M6 on-chain flows.
- The FE-owned registries (anims/sfx/spots) were pulled in as
  `M5 #70: FE-owned registry entries (additive)` with a clean
  commit message — no AI attribution, no AI session URL. The
  upstream `feature/fe-registries` branch was deleted from origin
  because its commit body carried the Co-Authored-By trailer.
- `docs/UNVERIFIED.md` continues to track the devnet airdrop,
  the ORE mainnet read, the SKR devnet mint, the Helius SDK
  peer-dep, the M3 SDK port, and the M5 Metaplex Core mainnet
  signer.

## M5 layered architecture in place (the M6 work builds on this)

- `server/shared/domain` — pure value objects (Cents, TokenAmount,
  Clock, Rng, uuidv7, error hierarchy). Imports nothing from
  outside.
- `server/shared/{config,db,redis,auth,solana,livekit,s3,logger,
infra}` — leaf modules. `s3` was added in M5 #64 and wired into
  AppContext. Boundary check forbids domain →
  transport/infra imports.
- `server/application` — AuthService, CharacterService, LotteryService,
  NeedsService, PublicProfileService, BlocksService, ReportsService,
  BoardsService, CareersService, ShiftsService, DailyClueService
  (now table-backed after M5 #60), MarketEngine (with `amm.ts` and
  `hidden-arc.ts`), TopupService, HeliusWebhookService, TerminalCafeService,
  PerpPitService, ORE RefineryService, LaunchpadService,
  PredictionsService, AlphaService, SocialGraphService, LiveKitService,
  SpacesService, VideoCallsService, CreatorService, PaidCallsService,
  HomesService, TipsService, PushService, MetaService, AdsService,
  LiveKitWebhookService, OreWebhookService, CosmeticsService,
  SeasonPassService, BusinessesService, GigsService, ProjectsService,
  NftMintService. Plus `context.ts` (AppContext) and `livekit.ts`
  (room service client wrapper).
- `server/api` — Fastify composition root, middleware (auth,
  idempotency), routes (auth, core, social, work, ops, payments,
  markets, perps, ore, predictions, alpha, social-graph, spaces,
  video-calls, creator, paid-calls, homes, tips, push-meta-ads,
  cosmetics, daily-clue, season-pass, businesses, gigs, projects,
  nft-mint). The Helius webhook route is wired with a raw-body
  content-type parser for HMAC verification.
- `server/realtime` — Colyseus schemas, CityRoom, MarketRoom,
  VenueRoom, SpaceRoom, VideoCallRoom (with all message handlers),
  realtime main.ts. CityRoom 1 Hz, MarketRoom 0.5 Hz, VenueRoom
  10 Hz, SpaceRoom 2 Hz, VideoCallRoom 1 Hz.
- `server/workers` — BullMQ composition root, plus five
  setInterval workers: payment poller, liquidation, predictions,
  alpha, rent, plus the M5 Sunday Unlock + Weekly Meta worker.
- `db/migrations` — 45 SQL files, append-only trigger, idempotency
  UNIQUE, append-only ledger.
- `packages/npc-brain` — 11 archetypes (M2's 9 + vc_npc + builder_npc
  from M5 #67). The venue room picks them up via the archetype
  string in the NPC spawn config; the VC Row and Builder Hills
  venues get the new archetypes from the venue registry.

## M6 status (in flight, the focus of this session)

Done:

- M0: foundation + smoke. Postgres on 5434, Redis on 6381,
  LiveKit dev server on 7880 (binary from .runtime/), MinIO on
  9000 (binary from .runtime/). `.env` populated.
- M1: the contract at `contract-v1.0.0-rc1` (tagged). `contract/
openapi.yaml` declares every M2-M5 endpoint. Realtime
  `contract/realtime/*` carries the `SpaceState`, `VideoCallState`,
  `BusinessState`, `HomeState` schemas. `pnpm contract:check` is
  green.
- M2: every M2 task committed (#27-#35). 32/32 vitest at M2 close.
- M3: every M3 task committed (#36-#46). 47/47 vitest at M3 close.
- M4: every M4 task committed (#47-#57). 99/99 vitest at M4 close.
- M5: every M5 task committed (#58-#70). 169/169 vitest at M5 close.
  The FE-registry additive pull is clean (no AI attribution).

Pending (the M6 work to finish in this session):

#:
Task: 71
Migrations for the VC Row + Project HQ layer
What's needed: db/migrations/046{0..9}_*.sql.
046_vc_trading_desks (desk_id uuid PK, owner_user_id uuid FK,
kind text CHECK in ('seed', 'series_a', 'series_b', 'tier_1'),
base_price_cents bigint CHECK > 0, leverage_cap int CHECK in
(1, 2, 3, 5), cash_cents bigint default 0, created_at, closed_at
nullable). Index (owner_user_id).
047_vc_trades (trade_id uuid PK, desk_id uuid FK, asset text,
direction text CHECK in ('long', 'short'), notional_cents
bigint, leverage int CHECK in (1, 2, 3, 5), entry_price_micros
bigint, exit_price_micros bigint nullable, pnl_cents bigint,
opened_at, closed_at nullable, status text CHECK in ('open',
'closed', 'liquidated'). Index (desk_id, status), (owner_user_id,
opened_at DESC)).
048_project_hq_rooms (hq_id uuid PK, project_id uuid FK, kind
text CHECK in ('main', 'meeting', 'dev', 'mod', 'kol', 'auditor'),
capacity int CHECK between 2 and 50, voice_room_id text UNIQUE,
created_at).
049_project_hq_members (member_id uuid PK, hq_id uuid FK,
user_id uuid FK, joined_at timestamptz, last_seen_at; UNIQUE
(hq_id, user_id)).
050_season_pass_perks (perk_id uuid PK, user_id uuid FK, week_iso
text, kind text CHECK in ('weekly_perk', 'exclusive_discount',
'badge'), credited_cents bigint, claimed_at timestamptz default
now(); UNIQUE (user_id, week_iso, kind)).
051_market_signals (signal_id uuid PK, user_id uuid FK, coin text,
horizon_minutes int CHECK in (5, 15, 60, 1440), direction text
CHECK in ('up', 'down'), confidence_bps int CHECK in
(0..10000), entry_price_micros bigint, created_at, expires_at,
status text CHECK in ('open', 'hit', 'missed', 'expired')).
Index (coin, status, expires_at).
052_market_signal_follows (follow_id uuid PK, signal_id uuid FK,
user_id uuid FK, follow_kind text CHECK in ('copy', 'watch'),
created_at; UNIQUE (signal_id, user_id)).
053_nft_collections (collection_id uuid PK, owner_user_id uuid FK,
name text, description text, created_at).
054_nft_collection_items (item_id uuid PK, collection_id uuid FK,
item_key text UNIQUE, name text, max_supply int CHECK > 0,
minted int default 0; UNIQUE (collection_id, item_key)).
055_advanced_orders (order_id uuid PK, user_id uuid FK, coin text,
side text CHECK in ('buy', 'sell'), order_kind text CHECK in
('limit', 'stop_loss', 'take_profit', 'oco'), trigger_micros
bigint, amount_cents bigint, status text CHECK in ('pending',
'filled', 'cancelled', 'expired'), created_at, triggered_at
nullable, expires_at nullable. Index (user_id, status),
(coin, status)).
Update pnpm db:verify to assert: vc_trades CHECKs, hq_members
UNIQUE, nft_collection_items UNIQUE, advanced_orders
status CHECK, market_signals confidence_bps range. Migrate
via `pnpm db:migrate`. Re-run `pnpm db:verify`.

#:
Task: 72
VC Row trading desks
What's needed: server/application/vc-trading.ts. Endpoints:
POST /v1/vc/desks — found a desk (kind + base price debit via
'vc_desk_seed' ledger row, leverage cap from kind).
GET /v1/vc/desks/{id} — get a desk + recent trades.
POST /v1/vc/desks/{id}/open — open a long/short position on an
asset; SERIALIZABLE UoW, check leverage cap, write a vc_trades
row (status='open').
POST /v1/vc/desks/{id}/{tradeId}/close — close an open trade; the
market engine's price path is the close price; SERIALIZABLE UoW,
write pnl_cents via 'vc_pnl' ledger row.
GET /v1/vc/desks — list the user's desks.
Tests: open + close happy path with positive pnl, open + close
with negative pnl, leverage cap refusal, asset whitelist
refusal, non-owner refused, idempotent close (replay is
no-op).

#:
Task: 73
Project HQ rooms (LiveKit-backed)
What's needed: server/application/project-hq.ts. Endpoints:
POST /v1/projects/{id}/hq — create an HQ room (kind + capacity);
mints a LiveKit token grant for the project owner, creates
a voice_rooms row + project_hq_rooms row.
POST /v1/projects/{id}/hq/{hqId}/join — join an HQ room; mints
a LiveKit token for the caller, inserts a project_hq_members
row.
POST /v1/projects/{id}/hq/{hqId}/leave — leave; updates
last_seen_at.
GET /v1/projects/{id}/hq — list the project's HQ rooms with
member counts.
server/realtime/rooms/project-hq.ts — a new Colyseus room
backed by LiveKit audio + a small message channel. The
realtime main registers the new room name.
Tests: HQ room created + voice_rooms row + capacity enforced;
non-member refused; close-room (admin/owner only); idempotent
join (replay is no-op).

#:
Task: 74
Market signals (alpha calls v2)
What's needed: server/application/market-signals.ts.
Extends the M3 alpha-calls surface with multi-horizon
signals: 5m / 15m / 1h / 1d. Endpoints:
POST /v1/market-signals — publish a signal (coin + horizon +
direction + confidence + entry price); the M3 trust score

- smart-money path applies on top.
  POST /v1/market-signals/{id}/resolve — resolve on price tick
  or expiry; status='hit' / 'missed' / 'expired'.
  POST /v1/market-signals/{id}/follow — follow (copy or watch);
  copy = the engine mirrors the caller's buy/sell into the
  follower's account.
  GET /v1/market-signals?coin=&horizon=&status= — list active
  signals.
  Tests: signal publish + resolve, copy follow places the
  mirror trade, watch follow records without moving money,
  signal expiry sets status='expired', confidence_bps range
  enforced.

#:
Task: 75
Advanced order types (limit / stop / OCO)
What's needed: server/application/advanced-orders.ts.
Endpoints:
POST /v1/advanced-orders — place a limit / stop_loss /
take_profit / OCO order; status='pending' until the engine
triggers it.
POST /v1/advanced-orders/{id}/cancel — cancel a pending order.
GET /v1/advanced-orders?status= — list the user's orders.
server/workers/advanced-orders.ts — a 5s tick worker that
walks pending orders, compares the engine's price path to
the trigger_micros, and flips status='filled' when the
trigger fires. OCO = trigger on either limit or stop.
Tests: limit order fills on a price drop, stop_loss fills on
a price spike, OCO fills on either, cancel flips to
'cancelled', expiry flips to 'expired'.

#:
Task: 76
Season pass weekly perks
What's needed: extend server/application/season-pass.ts.
POST /v1/season-pass/claim/perk — claim a perk (kind +
amount). Reads the user's tier, the meta_jobs row for the
current week, and writes a season_pass_perks row + a
'season_perk' ledger row. UNIQUE (user_id, week_iso, kind)
is the floor.
GET /v1/season-pass/perks — list the user's claimed perks.
Tests: claim perks with active pass, claim refused with
free-tier or expired pass, double-claim refused, weekly
perk count in ledger.

#:
Task: 77
NFT collections (curated sets)
What's needed: server/application/nft-collections.ts.
Extends the M5 #66 single-mint flow with curated sets.
Endpoints:
POST /v1/nft/collections — create a collection (name +
description).
POST /v1/nft/collections/{id}/items — add an item (key +
name + max_supply).
POST /v1/nft/collections/{id}/items/{itemKey}/mint — mint
within the collection; the M5 deterministic mint_address
extends with a per-item counter so multiple mints of the
same item are possible (mint_address is sha256 of
userId+itemKey+counter). max_supply enforced.
GET /v1/nft/collections/{id} — read the collection + items

- minted counts.
  Tests: create + add item + mint within cap, mint past
  max_supply refused, mint counter is monotonic per item,
  mints UNIQUE on (collection_id, item_key, counter).

#:
Task: 78
Push polish + mobile deep links
What's needed: extend server/application/push.ts.
POST /v1/push/test — admin-only: send a test push to a
device; uses the M4 #54 push_devices row.
GET /v1/push/deep-link — resolve a deep link (e.g.
ctlife://project/{id}) to a runtime route. The push
delivery carries the deep link; tapping the notification
opens the app at that route.
server/application/deep-links.ts — the resolver; caches
in Redis (1h) the set of valid route prefixes.
Tests: deep-link resolution (project/business/home),
unknown route refused, push test fires (mocked at the
HTTP boundary), idempotent device upsert.

#:
Task: 79
Homes decoration v2
What's needed: extend server/application/homes.ts.
POST /v1/homes/{id}/decorate — place a decorative item
(drawn from cosmetic_items) on the home; the home_visits
worker credits a 'decorate' ledger row.
GET /v1/homes/{id}/decor — list the home's decorations.
DELETE /v1/homes/{id}/decor/{decorId} — remove a decoration.
Tests: decorate (ledger row + decor row), double-decorate
is idempotent on the same item, removal refunds the
ledger entry.

#:
Task: 80
Realtime venue: project HQ + builder hills
What's needed: extend server/realtime/rooms/. The
venue room picks up vc_npc + builder_npc (M5 #67) and
adds the project-hq room (M6 #73) to the venue
registry. The realtime main registers the new room
name. The Colyseus state for project-hq mirrors the
voice_rooms state + an hq_specific field set (project_id,
kind, capacity).
Tests: room init, brain tick with vc_npc + builder_npc

- project-hq archetype, message handlers, capacity
  enforced.

#:
Task: 81
Liquid staking + yield features
What's needed: server/application/liquid-stake.ts. The
M3 ORE Refinery stakes ORE on mainnet (gated by
RUN_MAINNET_TESTS=1). M6 wraps that with a liquid-staking
position: the user deposits ORE (or USDC) into the
position, the position accrues yield every block, and
the user can withdraw the principal + yield.
db/migrations/047_liquid_stake_positions (position_id
uuid PK, user_id uuid FK, kind text CHECK in
('ore_native', 'ore_liquid', 'usdc_lend'), principal_cents
bigint, yield_cents bigint default 0, opened_at,
closed_at nullable, status text CHECK in ('open',
'closed')).
server/workers/yield.ts — a 60s tick that increments
yield_cents on every open position by the per-kind rate.
Endpoints:
POST /v1/liquid-stake/open — open a position (kind +
principal). For ORE the route builds the on-chain
transferChecked transaction (gated by RUN_MAINNET_TESTS=1).
POST /v1/liquid-stake/{id}/close — close a position;
credits principal + accrued yield.
GET /v1/liquid-stake — list the user's positions.
Tests: open + accrue + close with yield > 0, close
before any tick returns principal only, double-close
is idempotent, on-chain leg (when RUN_MAINNET_TESTS=1)
verifies the transaction signature.

#:
Task: 82
Bot world v2 + economy sim v2
What's needed: extend tools/bots/bot.ts with the M6
endpoints: vcDeskBot, projectHqBot, marketSignalsBot,
advancedOrdersBot, liquidStakeBot, nftCollectionBot. The
world runner takes a `--bots 200` arg; the deep load
test runs 200 bots across 4 venue instances for 5 minutes
and records p50/p95 REST latency, room tick lag, bytes/s
per client.
tools/econ-sim/run.ts extends the simulation with
VC-trading, project payroll, and yield features. The
assertion is median net worth within ±50% of starting
value over 8 weeks.
Tests: bot extensions wired, economy sim invariants pass
with the new features.

#:
Task: 83
Tests + load + bot e2e
What's needed: Unit: every M6 service (vc-trading, project-hq,
market-signals, advanced-orders, season-pass perks, nft
collections, deep-links, homes decoration v2, liquid-stake).
Integration: every new endpoint including every error code
and idempotent replay. Bot e2e: the M6 bot extensions.
Load: 200 bots across 4 venue instances for 5 minutes;
record p50/p95 REST latency, room tick lag, bytes/s per
client. The M4 deep load test re-runs to confirm no
regression. The M5 100-bot test re-runs as a baseline.
Realtime: project-hq room capacity + voice integration.
Performance: microbench measures p50/p95 REST latency on
/v1/me under the new bot load.
Helius-slow: the synthetic delay in the Helius client
still results in successful vc-trading + liquid-stake +
nft-collection-mint (the on-chain legs are async via
webhook + reconciler).
The M2/M3/M4/M5 deep integration tests still pass:
market engine tick drift, MIX_LIQ guards, ORE board
read, prediction resolution, alpha trust score,
hired-friend bot paths, NPC tap on Giveaway Guy, voice
rooms (Spaces create/list/get/hand/speakers/end), paid
calls (start/submitted/accept/decline/end), M5 #60 daily
clue, M5 #61 season pass buy/claim, M5 #62 business
bad-day/great-day, M5 #63 gig run, M5 #64 ad booking,
M5 #65 project found/hire/launch, M5 #66 NFT mint,
M5 #68 Sunday Unlock, M5 #69 bot e2e.
pnpm db:verify is green with the new M6 invariants
(target: 130+ invariants; 99 M5 + ~30 M6).

## M6 gate requirements (all must pass before closing M6)

1. Unit tests for every M6 service (vc-trading,
   project-hq, market-signals, advanced-orders,
   season-pass perks, nft-collections, deep-links,
   homes decoration v2, liquid-stake). Integration
   tests for every new endpoint, every error code,
   idempotent replay. Bot e2e with the M6 bot paths.
2. Contract: openapi.yaml carries the new endpoints; pnpm
   contract:check is green; pnpm docs:check passes.
3. Realtime load: 200 bots across 4 venue instances for
   5 minutes; record p50/p95 REST latency, room tick lag,
   bytes/s per client.
4. Helius-slow: a synthetic delay in the Helius client
   still results in successful vc-trading + liquid-stake
   - nft-collection-mint (the on-chain legs are async
     via webhook + reconciler).
5. The M2/M3/M4/M5 deep integration tests still pass
   (full list in #83).
6. pnpm db:verify is green with the new M6 invariants
   (target: 130+ invariants; 99 M5 + ~30 M6).

## Reporting format (for docs/TEST_REPORT.md)

Append a section to docs/TEST_REPORT.md at the end of the M6
gate with:

1. Milestone name, commit hash, date.
2. The exact commands run and the real output trimmed to
   pass/fail counts and any failures.
3. Measured numbers (LiveKit token mint latency, paid-call
   settlement round-trip, NFT mint dev path latency, vc-trade
   close round-trip, liquid-stake yield accrual latency,
   p50/p95 REST latency, room tick lag, bytes/s per client).
4. New entries added to DECISIONS.md, UNVERIFIED.md, and
   docs/adr/.
5. Documentation created or updated this milestone, and the
   result of the docs-check and boundary-check.
6. SOLID self-review: any module over the size limits (40
   lines/function, 300 lines/file) or crossing a layer
   boundary, with justification or the refactor.
7. Anything in the spec believed to be wrong, inconsistent
   or risky, with a proposed fix. Flag spec problems; do not
   silently work around them.

## Pinned versions (verify before using; the M2/M3/M4/M5 pin list is unchanged)

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
- Anchor CLI: spec says 1.2.0 but it does not exist; installed
  is 1.1.2. Use 1.1.2.
- Solana CLI: spec says 4.1.2 but it does not exist; installed
  is 3.1.10. Use 3.1.10; M3 may install 4.3.0.
- livekit-server-sdk 2.19.1
- openapi-generator v7.25.0 (via
  @openapitools/openapi-generator-cli; needs Java 21)
- ore-api 3.8.25, ore-stake-api 0.3.0 (Rust crates, reference
  only)
- @solana/web3.js 1.99.x
- @metaplex-foundation/mpl-core 1.10.0 (M5 pinned; verify
  on npm before installing the next minor).

The livekit-server binary v1.13.7 is downloaded from GitHub
to .runtime/livekit-server and the MinIO binary
RELEASE.2025-09-07T16-13-09Z is downloaded to .runtime/minio.
Both are gitignored.

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
  faucet. The smoke treats it as informational and does not
  block the gate. For the bot e2e, fund the devnet wallets
  via https://faucet.solana.com once each, or use a local
  validator. Recorded in docs/UNVERIFIED.md.
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
- The official helius-sdk@3.2.0 has an incompatible peer dep
  on @solana/kit ^6.9 but we pin 8.4. M2 dropped the SDK in
  favour of the thin fetch-based client in
  server/shared/solana/helius.ts + server/application/helius-webhook.ts.
  M5 paid-call escrow + NFT mint reuse the same pattern; the
  M6 vc-trading + liquid-stake + nft-collection-mint flows
  follow the same pattern. The production port of the
  parsed-transaction helpers is M7+ if it materialises.
- No public Solana test validator is required for the M6 bot
  e2e. If the devnet airdrop is unavailable, run
  solana-test-validator locally and point SOLANA_RPC_URL_DEVNET
  at it.
- The ORE board reader (M3 #41) hits mainnet; tests that
  exercise this reader are gated by RUN_MAINNET_TESTS=1.
- The M4 prompt's webhook lesson: webhook handlers do NOT need
  SERIALIZABLE. Use plain `ctx.db.withConnection` for the
  LiveKit + Helius webhook paths; the SET TRANSACTION in
  runInTransaction can itself abort the transaction when the
  cached DB has a stale snapshot. The M6 webhook paths
  (LiveKit, ORE, Helius on-chain confirmation for vc-trading
  - liquid-stake) all follow this rule.
- The Metaplex Core SDK version must be verified on npm before
  installing. mpl-core@1.10.0 is the current pin; the official
  SDK was renamed from @metaplex-foundation/mpl-core to
  @metaplex-foundation/core in late 2025; mpl-core is still
  the published package and is what we use.

## Next action

Start with M6 #71 (db/migrations for the VC Row + Project
HQ layer). Migrations are the foundation: every M6 service
depends on vc_trading_desks + vc_trades, project_hq_rooms +
project_hq_members, season_pass_perks, market_signals +
market_signal_follows, nft_collections + nft_collection_items,
advanced_orders, and (for #81) liquid_stake_positions. Then
M6 #72 (VC Row trading desks), M6 #73 (Project HQ rooms),
M6 #74 (Market signals), M6 #75 (Advanced order types), M6
#76 (Season pass weekly perks), M6 #77 (NFT collections),
M6 #78 (Push polish + mobile deep links), M6 #79 (Homes
decoration v2), M6 #80 (Realtime venue: project HQ + builder
hills), M6 #81 (Liquid staking + yield features), M6 #82 (Bot
world v2 + economy sim v2), M6 #83 (Tests + load + bot e2e

- closing slice). Close M6 with milestone M6: <name> after
  the M6 gate passes and the test report append and the
  PROGRESS.md M6 = DONE update are committed.

Update docs/PROGRESS.md after every command. Commit each
milestone group with M6: <area> (e.g. M6: vc-trading, M6:
project-hq, M6: market-signals). Close M6 with milestone M6:
<name>. The closing commit must include the test report
append and the PROGRESS.md M6 = DONE update.

---

## Notes for whoever picks this up next

- M5 left a verified, layered codebase. The boundary check
  (pnpm boundary:check) is the single best indicator that a
  new file respects the layering — run it after every file
  you add. The contract check (pnpm contract:check) is the
  single best indicator that the openapi.yaml and
  contract/realtime/*.ts stay in sync with the implementation.
  Run both.
- The LiveKit server in .runtime/livekit-server is the dev
  server. Production uses LiveKit Cloud; the SDK talks to
  either via the same token API.
- The M3 Helius webhook pattern is reused by M5 + M6 webhook
  services for idempotency. The on-chain leg (vc-trading
  - liquid-stake + nft-collection-mint) is async via the M3
    webhook path; the application writes the row, the Helius
    webhook confirms the credit, the M6 reconciler ticks
    daily to close any open confirmations.
- The M3 append-only ledger trigger is the hard floor. Every
  M5 + M6 service that touches cash (cosmetic purchase,
  season pass buy, season pass perk, business pay, gig pay,
  business rent, project seed, project payroll, NFT mint,
  vc trade pnl, liquid-stake principal + yield, weekly perk)
  runs through runInTransaction or ctx.db.withConnection and
  writes ledger rows. Tests assert the conservation
  invariant: sum(ledger.delta_cents WHERE user_id = X) ==
  balances.cash_cents for every X.
- The M5 deep load test (100 bots across 4 venue instances
  for 5 minutes) re-runs at M6 to confirm no regression; the
  M6 load test (200 bots across 4 venue instances for 5
  minutes) is the new gate. Use
  `pnpm tsx tools/bots/world.ts --bots 200 --venue
timeline_square` for the venue regression, and a parallel
  `pnpm tsx tools/bots/world.ts --bots 100 --venue <venueId>`
  for the M5 baseline.
- The Metaplex Core dev path is the M5 ad creative upload
  pattern: build the unsigned v0 transaction for MWA, the
  client signs and submits, the M3 webhook records
  nft_collection_mints. The M6 NFT collection mint extends
  with a per-item counter so multiple mints of the same
  item are possible; mint_address is sha256 of
  userId + itemKey + counter. The M6 NFT dev path does not
  move the Core asset itself; the dev path uses the existing
  test validator's local key.
- The contract integration checklist is the M6 spec's
  acceptance gate. Phase 5 endpoints (vc-trading, project-hq,
  market-signals, advanced-orders, season-pass-perks,
  nft-collections, deep-links, homes-decoration, liquid-stake)
  are the new work. Automate them in pnpm test:integration
  where possible, and document the rest in the M6 closing
  commit message.
- The "no AI authorship attribution" rule is strict. Every
  commit body, file header, and code comment must be free of
  `Co-Authored-By: …`, AI session URLs, and any other
  markers. The commit author is the human developer. The M5
  #70 commit pulled the FE registries in clean — the upstream
  `feature/fe-registries` branch's Co-Authored-By trailer
  was the reason the branch was force-replaced; do not
  reintroduce it.
- The "no mocks" rule means the LiveKit dev server is the
  production stand-in for the M6 dev path; production swaps
  the URL/API key/secret via env vars. M6 tests must connect
  to the real dev server and assert token grants are honoured.
