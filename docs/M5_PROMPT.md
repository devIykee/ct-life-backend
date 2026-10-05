# CT Life backend: M5 continuation

You are continuing work on CT Life, the CT Life backend. The previous sessions
have completed M0 (foundation + smoke), the retrofit pass, M1 (the contract
at tag contract-v1.0.0-rc1), M2 (DB migrations, server/shared infrastructure,
REST API, npc-brain, server/realtime, server/workers, tools/bots,
tools/econ-sim, and the M2 test layer), M3 (markets migrations, market
engine, cash top-ups, Terminal Cafe, Perp Pit, ORE Refinery, Launchpad
Tower, Prediction Pit, Alpha Calls + Trust Score + Smart Money, DMs/Feed/
Follows, and the M3 test layer), and M4 (voice + social migrations,
LiveKit room service + RTC tokens, Spaces, free video calls, creator
profile + paid calls + escrow + settlement, homes + rent, tips cash +
on-chain, push/meta/ads Phase 5 prep, Spaces + Video Room realtime
integration, LiveKit + ORE webhooks, and the M4 test + bot slice).
M5 has not started.

## Where to start

1. Read `docs/PROGRESS.md`, `docs/DECISIONS.md`, `docs/UNVERIFIED.md`,
   `docs/TEST_REPORT.md`, and `docs/RETROFIT_REPORT.md` to see the full
   state. The local `main` is in sync with `origin/main`; the most
   recent commit is the M4 closing commit ("M4 #57: Tests + bot e2e
   - closing slice (#57)").
2. Read `docs/spec/contract.md` and `docs/spec/build-spec.md` (the
   two spec tabs).
3. `cd ~/coding/ct-life-backend` and `git log --oneline -30` to see
   the commit history.
4. Run the static gates:
   `pnpm typecheck && pnpm lint && pnpm format:check && pnpm docs:check
 && pnpm boundary:check && pnpm contract:check`.
   They should all be green. M4 left:
   - `pnpm test:unit` 99/99 passed (across 19 files)
   - `pnpm db:verify` 55/55 schema invariants passed
   - `pnpm exec tsx tools/scripts/smoke.ts` 7/7 required checks passed.
5. Read `docs/REALTIME.md` for the room notes; `docs/CAPACITY.md`
   for the per-instance and global caps the M5 stress tests must
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
- Work resumably. Update `docs/PROGRESS.md` after every command.
  After every milestone, commit with `milestone M5: <area>`
  (e.g. M5: cosmetics, M5: businesses, M5: sunday-unlock).
  Close M5 with `milestone M5: <name>`. The closing commit must
  include the test report append and the `docs/PROGRESS.md`
  M5 = DONE update.

## M4 status (already done, don't redo)

- 11 M4 commits, in order: migrations, LiveKit token, spaces,
  video calls, creator + paid calls, homes, tips, push/meta/ads,
  realtime rooms, webhooks, tests + closing slice.
- 21 SQL migrations (010..030), 55/55 invariants in
  `pnpm db:verify`. Append-only trigger on `ledger_entries`,
  idempotency UNIQUE on `webhook_events(source, signature)`.
- Market engine is the single writer of `coins.price_micros`.
  4 worker loops (payment poller, liquidation, predictions,
  alpha) plus the new M4 rent worker.
- 99/99 unit tests pass; pnpm contract:check is green.
- All static gates green; pnpm boundary:check warns on the M4
  domain objects (creator.ts, paid-calls.ts, livekit.ts,
  livekit-webhook.ts) — these are domain objects, accepted.
- The Helius SDK was dropped at M2 (incompatible peer dep on
  `@solana/kit ^6.9`; we pin 8.4). The webhook handler uses a
  thin fetch-based parser in `server/application/helius-webhook.ts`.
  That pattern is the template for M5 on-chain flows.
- `docs/UNVERIFIED.md` continues to track the devnet airdrop,
  the ORE mainnet read, the SKR devnet mint, the Helius SDK
  peer-dep, and the M3 SDK port.

## M4 layered architecture in place (the M5 work builds on this)

- `server/shared/domain` — pure value objects (Cents, TokenAmount,
  Clock, Rng, uuidv7, error hierarchy). Imports nothing from
  outside.
- `server/shared/{config,db,redis,auth,solana,livekit,s3,logger,
infra}` — leaf modules. Boundary check forbids domain →
  transport/infra imports.
- `server/application` — AuthService, CharacterService, LotteryService,
  NeedsService, PublicProfileService, BlocksService, ReportsService,
  BoardsService, CareersService, ShiftsService, DailyClueService
  (stub), MarketEngine (with `amm.ts` and `hidden-arc.ts`),
  TopupService, HeliusWebhookService, TerminalCafeService,
  PerpPitService, ORE RefineryService, LaunchpadService,
  PredictionsService, AlphaService, SocialGraphService, LiveKitService,
  SpacesService, VideoCallsService, CreatorService, PaidCallsService,
  HomesService, TipsService, PushService, MetaService, AdsService,
  LiveKitWebhookService, OreWebhookService. Plus `context.ts`
  (AppContext) and `livekit.ts` (room service client wrapper).
- `server/api` — Fastify composition root, middleware (auth,
  idempotency), routes (auth, core, social, work, ops, payments,
  markets, perps, ore, predictions, alpha, social-graph, spaces,
  video-calls, creator, paid-calls, homes, tips, push-meta-ads).
  The Helius webhook route is wired with a raw-body content-type
  parser for HMAC verification.
- `server/realtime` — Colyseus schemas, CityRoom, MarketRoom,
  VenueRoom, SpaceRoom, VideoCallRoom (with all message handlers),
  realtime main.ts. CityRoom 1 Hz, MarketRoom 0.5 Hz, VenueRoom
  10 Hz, SpaceRoom 2 Hz, VideoCallRoom 1 Hz.
- `server/workers` — BullMQ composition root, plus five
  setInterval workers: payment poller, liquidation, predictions,
  alpha, rent.
- `db/migrations` — 21 SQL files, append-only trigger, idempotency
  UNIQUE, append-only ledger.

## M5 status (in flight, the focus of this session)

Done:

- M0: foundation + smoke. Postgres on 5434, Redis on 6381,
  LiveKit dev server on 7880 (binary from .runtime/), MinIO on
  9000 (binary from .runtime/). `.env` populated.
- M1: the contract at `contract-v1.0.0-rc1` (tagged). `contract/
openapi.yaml` declares the M5 endpoints (cosmetic shop,
  daily-clue, gigs, businesses, season-pass, ads slots + bookings,
  creator + paid calls live, homes live) with `x-phase: 4` for
  Phase 4 endpoints and `x-phase: 5` for ad slots + bookings.
  Realtime `contract/realtime/*` carries the `SpaceState`,
  `VideoCallState`, plus the new `BusinessState`, `HomeState`
  schemas. `pnpm contract:check` is green.
- M2: every M2 task committed (#27-#35). 32/32 vitest at M2 close.
- M3: every M3 task committed (#36-#46). 47/47 vitest at M3 close.
- M4: every M4 task committed (#47-#57). 99/99 vitest at M4 close.

Pending (the M5 work to finish in this session):

#:
Task: 58
Migrations for the city-life layer
What's needed: db/migrations/031{0..9}_*.sql.
031_daily_clue (clue_id uuid PK, date date UNIQUE, clue_text text,
answer_hash text, prize_cents bigint, expires_at timestamptz,
created_at timestamptz default now(); index (date)).
032_daily_clue_attempts (attempt_id uuid PK, user_id uuid FK,
clue_id uuid FK, attempt_text text, correct bool,
attempted_at timestamptz default now(); index
(user_id, clue_id) UNIQUE).
033_season_pass (pass_id uuid PK, user_id uuid FK UNIQUE,
tier text CHECK in ('free','season'), started_at, expires_at,
price_paid_cents bigint, created_at).
034_cosmetic_items (item_id uuid PK, slot text CHECK in
(skin, head, hair, top, bottom, shoes, acc), item_key text
UNIQUE, name text, price_cents bigint, onchain_only bool
default false, created_at).
035_cosmetic_inventory (inventory_id uuid PK, user_id uuid FK,
item_id uuid FK, source text CHECK in ('shop','mint','grant'),
acquired_at timestamptz default now(); UNIQUE
(user_id, item_id)).
036_businesses (business_id uuid PK, owner_user_id uuid FK,
kind text CHECK in ('lemonade_stand','laundromat','cafe',
'shop','arcade'), rent_cents_per_week bigint CHECK > 0,
income_min_cents bigint, income_max_cents bigint,
created_at, closed_at nullable). Index (owner_user_id).
037_business_days (day_id uuid PK, business_id uuid FK,
day_date date, pay_cents bigint, kind text CHECK in
('normal','bad_day','great_day'), description text; UNIQUE
(business_id, day_date)).
038_gig_runs (run_id uuid PK, user_id uuid FK, gig_id text,
pay_cents bigint, outcome_id text, started_at, ended_at,
INDEX (user_id)).
039_ad_slots (slot_id text PK, kind text, terms jsonb,
next_free_at timestamptz nullable). The M4 ads.ts in-memory
table moves here.
040_ad_bookings (booking_id uuid PK, user_id uuid FK,
slot_id text FK, term_id text, upload_id text, link text,
status text CHECK in ('pending_review','live','rejected'),
created_at, INDEX (slot_id, status), INDEX (user_id,
created_at DESC)).
041_ad_creatives (creative_id uuid PK, booking_id uuid FK,
image_key text, mime_type text, size_bytes int,
uploaded_at timestamptz).
042_projects (project_id uuid PK, owner_user_id uuid FK,
kind text CHECK in ('memecoin','dex','nft_studio',
'perps_venue','l2'), status text CHECK in ('founded',
'launching','live','paused','rugged'), cash_cents bigint
default 0, created_at, INDEX (owner_user_id)).
043_project_hires (hire_id uuid PK, project_id uuid FK,
user_id uuid FK, role text CHECK in ('dev','mod','kol',
'auditor'), salary_cents_per_week bigint CHECK > 0,
hired_at timestamptz default now(); UNIQUE
(project_id, user_id)).
044_nft_mints (mint_id uuid PK, user_id uuid FK, item_id text,
mint_address text UNIQUE, signature text, network text CHECK
in ('devnet','mainnet'), minted_at timestamptz default now()).
045_meta_jobs (job_id uuid PK, kind text CHECK in
('weekly_meta','sunday_unlock'), week_iso text, payload jsonb,
created_at timestamptz default now(); UNIQUE
(kind, week_iso)).
Update pnpm db:verify to assert: daily_clue.date UNIQUE;
daily_clue_attempts UNIQUE (user_id, clue_id); season_pass
UNIQUE user_id; cosmetic_items UNIQUE item_key;
businesses.kind CHECK; business_days.kind CHECK;
ad_bookings.status CHECK; ad_creatives UNIQUE booking_id;
projects.status CHECK; project_hires.role CHECK; nft_mints
UNIQUE mint_address; meta_jobs UNIQUE (kind, week_iso).
Migrate via `pnpm db:migrate`. Re-run `pnpm db:verify`.

#:
Task: 59
Cosmetics shop + inventory
What's needed: server/application/cosmetics.ts. Endpoints:
GET /v1/shop — list shop items by slot
POST /v1/shop/purchase — buy a Cash cosmetic; debit
'cosmetic' ledger row, append
cosmetic_inventory
GET /v1/inventory — list the user's cosmetics
M4 #54 already shipped the ad slot + booking stubs. M5 #64
makes them real (creative upload to S3, review state machine,
ad_creatives row).
Tests: shop listing, Cash purchase, inventory, daily cap
on cosmetic purchases, item already owned -> idempotent.

#:
Task: 60
Daily clue + Sunday Unlock worker
What's needed: server/application/daily-clue.ts. Endpoints:
GET /v1/daily-clue — return today's clue (text + expiresAt; never the
answer hash)
POST /v1/daily-clue/answer — submit a guess; correct ->
credit prize via 'daily_clue'
ledger row, record
daily_clue_attempts
server/workers/sunday-unlock.ts: runs at Sun 20:00 UTC. Pulls
the week's winners + losers, writes the Weekly Meta rotation
(UPDATE meta SET value = ... WHERE key = 'current'), credits
the season pass holders' weekly perk (a single 'weekly_perk'
ledger row per pass holder).
Tests: correct answer credits prize, wrong answer rejected,
one attempt per day enforced by UNIQUE
(user_id, clue_id), weekly meta rotate persists.

#:
Task: 61
Season pass
What's needed: server/application/season-pass.ts. Endpoints:
POST /v1/season-pass/buy — purchase the season pass for
$5 USDC (Cash equivalent; in
M5 the dev path credits Cash
from a recorded webhook —
production wires the payment
intent flow from M3).
GET /v1/season-pass/me — return the user's pass (or 404)
POST /v1/season-pass/claim — claim the weekly perk
(server/workers/sunday-unlock.ts
is the source of truth for
which perk is active).
Tests: tiered pricing (free vs season), expiring pass
behavior, double-claim refused, perk delivery credited.

#:
Task: 62
Player businesses + bad days
What's needed: server/application/businesses.ts. Endpoints:
POST /v1/businesses — found a business (kind +
initial rent debit; rent uses
the M4 homes rent model but
keyed off businesses.kind)
GET /v1/businesses/{id} — get a business + recent days
POST /v1/businesses/{id}/run — daily 'open' that returns
today's pay (normal, bad_day,
or great_day). Inserts a
business_days row and credits
the owner's cash via
'business_pay' ledger row.
server/workers/businesses.ts: runs the bad-day table per the
config; inserts tomorrow's row at midnight UTC.
Tests: bad_day pays zero + maybe a penalty; great_day pays
income_max; normal pays random income in
[income_min, income_max]; idempotency: rerunning /run on the
same day is refused (UNIQUE business_id+date).

#:
Task: 63
Gigs
What's needed: server/application/gigs.ts. Endpoints:
GET /v1/gigs — list the 5 side gigs with
formulas
POST /v1/gigs/{gigId}/run — run a gig; resolves pay via
the formula, credits via
'gig_pay' ledger row, writes
a gig_runs row.
Tests: every gig's formula with the spec's boundary inputs,
pay-cents bounds, runs/writes a row, negative inputs refused.

#:
Task: 64
Ads (full) + creative uploads
What's needed: server/application/ads.ts (extend M4 stub).
GET /v1/ads/live — list live creatives for
slot ids; cache 5 minutes
in Redis (ore:ads:live:{slotId})
GET /v1/ads/slots — list all slots + terms + nextFreeAt (now from DB)
POST /v1/uploads — accept a multipart image
(PNG/JPG <= 1 MB); put to S3
at ads/{uploadId}; insert
ad_creatives row
POST /v1/ads/bookings — bind a creative to a slot +
term; status='pending_review'
until an admin approves (M5
has no admin UI; the
approval happens in real life
and is out of scope).
server/application/ads-admin.ts: POST /v1/admin/ads/bookings/
{id}/approve and /reject. Admin role check.
Tests: creative upload, slot listing (now from DB), booking
creation, ad_bookings.status CHECK, Redis cache invalidation
on booking approve.

#:
Task: 65
Player projects (Builder Hills)
What's needed: server/application/projects.ts. Endpoints:
POST /v1/projects — found a project (kind + cash
seed); inserts a projects row
(Builder -30% perk lowers
cost). debits the seed via
'project_seed' ledger row.
POST /v1/projects/{id}/hire — hire a player (role +
salary). Inserts
project_hires, weekly salary
debits from the project owner's
cash via 'project_payroll'
ledger row.
POST /v1/projects/{id}/launch — flip status 'founded' ->
'launching'; the launchpad
flow (M3 #42) runs.
GET /v1/projects/{id} — return the project + hires +
status.
server/workers/projects.ts: every Monday, debit every
project_hire's salary from the owner's cash; if cash < salary
the project's status flips to 'paused'.
Tests: found + seed debit, hire + weekly debit, launch
status flip, paused-for-insufficient-funds.

#:
Task: 66
Cosmetic NFTs (Metaplex Core mint)
What's needed: server/application/nft-mint.ts. Endpoints:
POST /v1/nft/mint — mint a Core asset for an
item the user owns; the
devnet Mints flow builds the
unsigned v0 transaction for
MWA. After the client signs
and submits, the M3 webhook
records nft_mints.
GET /v1/nft/inventory — list the user's nft_mints.
Metaplex Core uses the @metaplex-foundation/mpl-core SDK.
The M4 prompt records using "PUT /v1/uploads" for the
creative file; M5's NFT mint builds on that.
Tests: mint address derives from item + user (deterministic
in dev), nft_mints UNIQUE, signature UNIQUE, inventory
lists owned NFTs.

#:
Task: 67
VC Row + Builder Hills venues (NPCs only)
What's needed: server/realtime/rooms/venue.ts already supports
arbitrary venueId. M5 #67 adds two new NPC archetypes (vc_npc + builder_npc) to packages/npc-brain/src/index.ts. The venue
room picks them up via the existing venue registry; the only
new code is the archetype state machine + the lines.
Tests: archetype init, brain tick, line selection.

#:
Task: 68
Sunday Unlock + Weekly Meta rotation
What's needed: server/workers/sunday-unlock.ts (the worker) + server/workers/weekly-meta.ts (rotation). Cron pattern
via the existing M2 BullMQ upsertJobScheduler. Integration with
the meta table (already in M4 #54); the worker writes a new
meta row with value=weeklyMetaJson at Sun 20:00 UTC. The
season pass holder perk credits land in the same worker.
Tests: worker fires the cron, writes the meta row, credits
weekly perks, leaves the non-pass holders alone.

#:
Task: 69
Tests + load + bot e2e
What's needed: Unit: every M5 service (cosmetic purchase,
daily clue correct/wrong, season pass buy/claim, business
bad_day/great_day, gig run, ad booking creation, project
found/hire/launch, NFT mint dev path, Sunday Unlock worker,
Weekly Meta rotation). Integration: every new endpoint,
every error code, idempotent replay. The bot world is
extended with foundProject -> hireBot -> runGigBot ->
dailyClueBot -> seasonPassBot -> purchaseCosmeticBot ->
foundBusinessBot paths. The M5 deep load test runs 100 bots
across 4 METAPLEXIBLE instances for 5 minutes (the M5 gate
introduces METAPLEXIBLE as the venue shard key), recording
p50/p95 REST latency, room tick lag, bytes/s per client.
Performance: a tools/scripts/microbench.ts that measures
p50/p95 REST latency on /v1/me under the bot load. Realtime:
100 bots across 4 venue instances is the M4 gate that the
M5 session re-runs to confirm no regression.

## M5 gate requirements (all must pass before closing M5)

1. Unit tests for the cosmetic shop, daily clue, season pass,
   businesses (bad-day table), gigs, ads (full + creative
   upload), player projects (found/hire/launch), NFT mint
   dev path, Sunday Unlock worker, Weekly Meta rotation, and
   the new invariant assertions in pnpm db:verify.
2. API integration tests for every new endpoint including every
   error code and idempotent replay.
3. Contract: openapi.yaml carries the new endpoints; pnpm
   contract:check is green; pnpm docs:check passes.
4. Realtime load: 100 bots across 4 venue instances for 5
   minutes; record p50/p95 REST latency, room tick lag,
   bytes/s per client.
5. Helius-slow: a synthetic delay in the Helius client still
   results in successful cosmetic purchase + NFT mint (the
   on-chain leg is async via webhook + reconciler).
6. The M2/M3/M4 deep integration tests still pass: market
   engine tick drift, MIX_LIQ guards, ORE board read, prediction
   resolution, alpha trust score, hired-friend bot paths, NPC
   tap on Giveaway Guy, voice rooms (Spaces create/list/get/
   hand/speakers/end), paid calls (start/submitted/accept/
   decline/end).
7. pnpm db:verify is green with the new M5 invariants (target:
   70+ invariants; 55 M4 + ~15 M5).

## Reporting format (for docs/TEST_REPORT.md)

Append a section to docs/TEST_REPORT.md at the end of the M5
gate with:

1. Milestone name, commit hash, date.
2. The exact commands run and the real output trimmed to
   pass/fail counts and any failures.
3. Measured numbers (LiveKit token mint latency, paid-call
   settlement round-trip, NFT mint dev path latency,
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

## Pinned versions (verify before using; the M2/M3/M4 pin list is unchanged)

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
- @metaplex-foundation/mpl-core 1.x (M5 new) — verify on npm
  before installing.

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
- The official helius-sdk@3.2.0 has an incompatible peer dep
  on @solana/kit ^6.9 but we pin 8.4. M2 dropped the SDK in
  favour of the thin fetch-based client in
  server/shared/solana/helius.ts + server/application/helius-webhook.ts.
  M5 paid-call escrow + NFT mint reuse the same pattern; the
  production port of the parsed-transaction helpers is M6+ if
  it materialises.
- No public Solana test validator is required for the M5 bot
  e2e. If the devnet airdrop is unavailable, run
  solana-test-validator locally and point SOLANA_RPC_URL_DEVNET
  at it.
- The ORE board reader (M3 #41) hits mainnet; tests that
  exercise this reader are gated by RUN_MAINNET_TESTS=1.
- The M4 prompt's webhook lesson: webhook handlers do NOT need
  SERIALIZABLE. Use plain `ctx.db.withConnection` for the
  LiveKit + Helius webhook paths; the SET TRANSACTION in
  runInTransaction can itself abort the transaction when the
  cached DB has a stale snapshot. The M5 webhook paths
  (LiveKit, ORE, Helius cosmetic-purchase confirmation) all
  follow this rule.
- The Metaplex Core SDK version must be verified on npm before
  installing. The official SDK was renamed from
  @metaplex-foundation/mpl-core to @metaplex-foundation/core
  in late 2025; check both names.

## Next action

Start with M5 #58 (db/migrations for the city-life layer).
Migrations are the foundation: every M5 service depends on
daily_clue, season_pass, cosmetic_items + inventory,
businesses + business_days, gig_runs, ad_slots + bookings +
creatives, projects + project_hires, nft_mints, and meta_jobs.
Then M5 #59 (Cosmetics shop + inventory), M5 #60 (Daily clue

- Sunday Unlock worker), M5 #61 (Season pass), M5 #62
  (Player businesses + bad days), M5 #63 (Gigs), M5 #64 (Ads
  full + creative uploads), M5 #65 (Player projects), M5 #66
  (Cosmetic NFTs), M5 #67 (VC Row + Builder Hills venues), M5
  #68 (Sunday Unlock + Weekly Meta rotation), M5 #69 (Tests +
  load + bot e2e). Close M5 with M5: <name> after the M5 gate
  passes and the test report append and the PROGRESS.md
  M5 = DONE update are committed.

Update docs/PROGRESS.md after every command. Commit each
milestone group with M5: <area> (e.g. M5: cosmetics, M5:
businesses, M5: sunday-unlock). Close M5 with M5: <name>.
The closing commit must include the test report append and
the PROGRESS.md M5 = DONE update.

---

## Notes for whoever picks this up next

- M4 left a verified, layered codebase. The boundary check
  (pnpm boundary:check) is the single best indicator that a
  new file respects the layering — run it after every file
  you add. The contract check (pnpm contract:check) is the
  single best indicator that the openapi.yaml and
  contract/realtime/*.ts stay in sync with the implementation.
  Run both.
- The LiveKit server in .runtime/livekit-server is the dev
  server. Production uses LiveKit Cloud; the SDK talks to
  either via the same token API.
- The M3 Helius webhook pattern is reused by M5 webhook
  services (LiveKit, ORE, Helius cosmetic confirmation).
  Idempotency on (source, signature).
- The M3 append-only ledger trigger is the hard floor. Every
  M5 service that touches cash (cosmetic purchase, business
  pay, gig pay, season pass buy, weekly perk, project seed,
  project payroll) runs through runInTransaction or
  ctx.db.withConnection and writes ledger rows. Tests assert
  the conservation invariant:
  sum(ledger.delta_cents WHERE user_id = X) == balances.cash_cents
  for every X.
- The M4 deep load test (200 bots across 4 instances for 5
  minutes) re-runs at M5 to confirm no regression; the M5 load
  test (100 bots across 4 venue instances for 5 minutes) is
  the new gate. Use `pnpm tsx tools/bots/world.ts --bots 200
--venue timeline_square` for the venue regression, and a
  parallel `pnpm tsx tools/bots/world.ts --bots 100 --venue
<venueId>` for the M5 gate.
- Spaces capacity is 200 instances of 8 speakers = 1600
  concurrent speakers per realtime process. The capacity doc
  (docs/CAPACITY.md) is the source of truth; the load runner
  asserts the cap is honoured.
- The "no mocks" rule means the LiveKit dev server is the
  production stand-in for the M5 dev path; production swaps
  the URL/API key/secret via env vars. M5 tests must connect
  to the real dev server and assert token grants are honoured.
- The Metaplex Core dev path is the M4 ad creative upload
  pattern: build the unsigned v0 transaction for MWA, the
  client signs and submits, the M3 webhook records nft_mints.
  The M5 NFT mint does not move the Core asset itself — the
  dev path uses the existing test validator's local key.
- The contract integration checklist is the M5 spec's
  acceptance gate. Phase 4 endpoints (cosmetic shop, daily
  clue, gigs, businesses, season pass, NFT mint, Sunday
  Unlock) and the Phase 5 endpoints (ad slots + bookings,
  creative uploads) are the new work. Automate them in
  pnpm test:integration where possible, and document the
  rest in the M5 closing commit message.
