# Progress

> Single source of truth for resumability. When a new session starts, the next engineer reads this file first, then the latest `TEST_REPORT.md`, then `DECISIONS.md`, then the spec.

## How to use this file

- Every milestone has a section.
- After every command run, the **last command** is updated.
- **Blockers** are explicit. They say what is needed and what to do.
- **Next** is the exact next thing to do, not a vague plan.

## M0 — Foundation and verification

**Status:** in progress (paused for credentials)
**Last commit:** pending
**Last command:** `pnpm smoke` → blocked on missing credentials, see "Blockers" below

### Done

- [x] Spec docs read end-to-end (`docs/spec/contract.md`, `docs/spec/build-spec.md`).
- [x] Every pinned version verified against npm, crates.io, and GitHub releases. Deviations recorded in `docs/DECISIONS.md` (M0 section).
- [x] Repo initialized (TypeScript workspace, pnpm, ESLint 9 flat, Prettier, EditorConfig, .nvmrc, .node-version).
- [x] Directory layout created per the prompt (`contract/`, `server/{api,realtime,workers,shared}`, `packages/npc-brain`, `programs/ct_escrow`, `tools/{bots,econ-sim,contract-check,scripts}`, `db/migrations`, `docs/{spec,adr}`).
- [x] `README.md`, `CONTRIBUTING.md` written.
- [x] `docs/DECISIONS.md` initialised with M0 version and architecture decisions.
- [x] `docs/UNVERIFIED.md` initialised with what cannot be verified in this environment.
- [x] `docs/TEST_REPORT.md` initialised.
- [x] `.env.example` written with every variable the spec requires, inline docs.
- [x] `docker-compose.yml` written with Postgres 16, Redis 7, LiveKit dev, MinIO, plus api/realtime/workers services, with `mock` profile per the prompt's deviation.
- [x] `.github/workflows/ci.yml` written (lint, typecheck, unit, contract-check on every push; e2e/load/mainnet-read on nightly/manual).
- [x] ESLint config with JSDoc, layering (`no-restricted-imports` on domain), strict TypeScript.
- [x] `tools/scripts/keygen.ts` for generating local dev keypairs.
- [x] `tools/scripts/smoke.ts` for the M0 smoke gate.
- [x] `tools/scripts/boundary-check.ts` and `tools/scripts/docs-check.ts` skeletons.

### In progress / blocked

- [ ] `pnpm dev:up` cannot be run end-to-end because the dev environment is missing required external credentials. Listed in "Blockers" below.
- [ ] `pnpm smoke` cannot reach a green state for the same reason. When credentials arrive: run smoke, paste output into `docs/TEST_REPORT.md`, tag as M0 done.

### Blockers — required credentials

The following variables are required for the M0 gate (external dependency smoke tests). They are listed exactly once here; the user has been asked in a single batched message at the end of the M0 prep session.

1. `HELIUS_API_KEY` — Helius RPC + webhooks.
2. `HELIUS_WEBHOOK_SECRET` — for verifying Helius webhook signatures.
3. `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` — LiveKit server SDK and dev server.
4. `SOLANA_RPC_URL_DEVNET` — for the devnet airdrop smoke (or a pre-funded devnet keypair).
5. `TREASURY_PUBKEY_DEVNET` — the on-chain treasury the bot will fund in the smoke test.
6. `SETTLE_AUTHORITY_KEYPAIR_DEVNET` — base58 keypair (or path), the backend's signer for ct_escrow.
7. `ADMIN_KEYPAIR_DEVNET` — base58 keypair (or path), admin tools.
8. `JWT_PRIVATE_KEY` — RS256 private key in PEM. Will be auto-generated for local if absent.
9. `S3_ACCESS_KEY`, `S3_SECRET_KEY` — MinIO credentials. Defaults are set in compose; these are for staging/prod.
10. `ANTHROPIC_API_KEY` — required for M7 LLM NPCs. Not required for M0.

Optional (logged in `UNVERIFIED.md` if absent, gate does not block):

- `SENTRY_DSN`, `X_CLIENT_ID`/`X_CLIENT_SECRET`, `RAILWAY_TOKEN`, `LIVEKIT_WEBHOOK_SECRET`, `PUSH_*`.

### Next

1. Drop credentials into `.env` (file is gitignored).
2. `pnpm install` — install workspace deps.
3. `pnpm dev:up` — bring the stack healthy.
4. `pnpm smoke` — confirm every external dependency is green.
5. `pnpm lint && pnpm typecheck` — confirm CI gate.
6. Commit as `milestone M0: foundation and verification` with the test report.

## M1 — The contract (the teammate is blocked until this exists)

**Status:** not started

### Plan

- Build `contract/openapi.yaml` for every REST endpoint in spec section 4, every phase, with `x-phase`, examples, error codes, headers.
- Build `contract/realtime/*.ts` with Colyseus schemas for `VenueState`, `MarketState`, `CityState`, `HomeState` and message types.
- Populate `contract/ids/*.json` and `contract/config/*.json` per spec section 2 and 7.
- Build `tools/contract-check` (schema, codegen, response validator, freshness check).
- Tag `contract-v1.0.0-rc1` and continue.

## M2..M8

See `README.md` for the milestone list and `docs/adr/` for decisions made along the way.

## M2 — DB migrations (#27)

**Status:** DONE
**Last command:** `pnpm db:verify` → 15 check(s) passed
**Last commit:** pending (this session)

### Done in this slice

- [x] `node-pg-migrate@8.0.2` chosen and installed.
- [x] `.pgmigrate.json` config; `pnpm db:migrate`, `pnpm db:rollback`, `pnpm db:status` scripts.
- [x] 9 SQL migrations in `db/migrations/` (1700000001xxx_*_users → 1700000009xxx_indexes). Each has `-- Up Migration` and `-- Down Migration` markers per the node-pg-migrate SQL template.
- [x] Append-only `ledger_entries` with BEFORE UPDATE OR DELETE trigger that raises `check_violation` (SQLSTATE 23514).
- [x] `blocks` has `UNIQUE (blocker_user_id, blocked_user_id)`.
- [x] `ledger_entries.idempotency_ref` is `UNIQUE`.
- [x] `users.wallet` is `UNIQUE`; `users.sgt_mint` has a `UNIQUE` partial index.
- [x] `balances.cash_cents` and `balances.debt_cents` are `bigint` with `CHECK (… >= 0)`.
- [x] `tools/scripts/verify-migrations.ts` — 15 invariant checks against a running Postgres. Run with `pnpm db:verify`.

### Static gate this slice

```
$ pnpm typecheck    → no errors
$ pnpm lint         → no errors
$ pnpm format:check → all files match
$ pnpm docs:check   → OK (12 env vars, 23 error codes, 0 realtime messages, links resolve)
$ pnpm boundary:check → layering OK
$ pnpm contract:check  → all steps green
```

### Migration verification (real output, trimmed)

```
$ pnpm db:migrate
Migrations complete!
$ pnpm db:verify
[OK] table users exists
[OK] table characters exists
[OK] table balances exists
[OK] table ledger_entries exists
[OK] table needs exists
[OK] table skills exists
[OK] table blocks exists
[OK] table reports exists
[OK] ledger_entries has append-only trigger
[OK] ledger_entries UPDATE is blocked
[OK] ledger_entries DELETE is blocked
[OK] blocks UNIQUE (blocker, blocked)
[OK] ledger_entries.idempotency_ref UNIQUE
[OK] users.wallet UNIQUE
[OK] balances.cash_cents has non-negative CHECK
verify-migrations: 15 check(s) passed.
```

### Next

- [x] #28 server/shared infrastructure (pg pool with SERIALIZABLE + statement_timeout, Unit of Work, ioredis, JWT, Helius, LiveKit, S3, Solana keypairs, pino, config, idempotency, rate limiter, error handler).
- [x] #29 REST API composition root.
- [ ] #30 packages/npc-brain.
- [ ] #31 server/realtime.
- [ ] #32 server/workers.
- [ ] #33 tools/bots.
- [ ] #34 tools/econ-sim.
- [ ] #35 tests + load + bot e2e.

## M2 — Server/shared infrastructure (#28)

**Status:** DONE
**Last command:** `pnpm test:unit` → 10/10 passed
**Last commit:** pending (this session)

### Done in this slice

- [x] `server/shared/config/config.ts` — typed env loader. Reads the M0 env names (TREASURY_PUBKEY_DEVNET, etc.), resolves the cluster from `APP_ENV` (local → devnet, prod → mainnet), and exposes a single `Config` object. No module reads `process.env` directly except this one.
- [x] `server/shared/logger/logger.ts` — pino with secret-redacting paths.
- [x] `server/shared/db/pool.ts` — pg.Pool with `statement_timeout` and `lock_timeout` set on every new connection; `withConnection` and `connect` helpers; `close` on shutdown.
- [x] `server/shared/db/uow.ts` — `runInTransaction(fn)` is the only module that calls BEGIN/COMMIT/ROLLBACK. Sets `ISOLATION LEVEL SERIALIZABLE` per transaction. Retries SQLSTATE 40001 with exponential backoff + jitter (max 3 retries by default).
- [x] `server/shared/redis/client.ts` — ioredis with two clients (`main` and `subscriber`) so pub/sub doesn't break regular commands.
- [x] `server/shared/auth/jwt.ts` — RS256 signer/verifier via `jose`. Access token (15 min) and refresh token (30 d). Derives the public key from the private key when `JWT_PUBLIC_KEY` is absent, so M0's single-`JWT_PRIVATE_KEY` setup is enough. Publishes JWKS for `/v1/auth/jwks`.
- [x] `server/shared/solana/helius.ts` — fetch-based Helius RPC client (we dropped the official helius-sdk because of an incompatible peer dep on `@solana/kit ^6.9`; the M2 SGT check only needs `getTokenAccountsByOwnerV2` and the SDK's webhook helpers are M3).
- [x] `server/shared/solana/keypair.ts` — file path or base58 → `Keypair` loader + base58 decoder + wallet hash helper.
- [x] `server/shared/livekit/token.ts` — wraps `livekit-server-sdk` AccessToken. Room name `{kind}:{id}`, identity = userId. `canPublish` defaults to true; spaces start listeners at false and the host promotes them.
- [x] `server/shared/s3/client.ts` — `@aws-sdk/client-s3` wrapper. `put`, `presignGet`, `presignPut`, `ensureBucket`. Path-style for MinIO.
- [x] `server/shared/infra/error-envelope.ts` — single mapper from `DomainError` to the contract error envelope `{ code, message, details }`. Adds `Retry-After` for `RATE_LIMITED` and `SERVER_BUSY`; `WWW-Authenticate: Bearer` for `TOKEN_EXPIRED`/`SIGNATURE_INVALID`.
- [x] `server/shared/infra/idempotency.ts` — `RedisIdempotencyStore` with `reserve` / `complete` / `abort` / `peek`. Cache check first (so replays work even after the lock is released), then SET-NX lock for in-flight serialization. Body-hash mismatch returns `bodyHashMismatch: true` so the transport returns `VALIDATION_FAILED`.
- [x] `server/shared/infra/rate-limit.ts` — Lua-scripted token bucket (per-user REST), per-IP login counter, and a global login semaphore (counter-based, with release). Returns the wait time so the transport can set `Retry-After`.
- [x] `server/shared/index.ts` — barrel.
- [x] Tests against the real local Postgres and Redis: 10 tests across `wiring.test.ts`, `jwt.test.ts`, `rate-limit.test.ts` — all pass.

### Static gate this slice

```
$ pnpm typecheck    → no errors
$ pnpm lint         → no errors
$ pnpm format:check → all files match
$ pnpm docs:check   → OK (23 env vars, 23 error codes, 0 realtime messages, links resolve)
$ pnpm boundary:check → layering OK
$ pnpm contract:check  → all steps green
$ pnpm test:unit    → 10/10 passed
$ pnpm smoke        → 7/7 required checks passed
$ pnpm db:verify    → 15/15 schema invariants passed
```

### Spec issues raised

- **Helius SDK is unusable at the pinned @solana/kit 8.4.0.** The official `helius-sdk@3.2.0` requires `@solana/kit ^6.9`; we pin 8.4. We dropped the SDK and wrote a thin fetch client in `server/shared/solana/helius.ts`. M3 webhook helpers (signing, parsed transactions) may need a different approach; recorded in UNVERIFIED.md.

### Next

- [ ] #29 REST API composition root.
  - [ ] #30 packages/npc-brain.
  - [ ] #31 server/realtime.
  - [ ] #32 server/workers.
  - [ ] #33 tools/bots.
  - [ ] #34 tools/econ-sim.
  - [ ] #35 tests + load + bot e2e.

## M2 — REST API (#29)

**Status:** DONE
**Last command:** `pnpm boundary:check` → layering OK
**Last commit:** pending (this session)

### Done in this slice

- [x] `server/application/context.ts` — AppContext composition root.
- [x] `server/application/auth.ts` — `AuthService`. SIWS challenge, verify, dev auth, refresh, logout. Ed25519 via Node `crypto.verify`. SGT check falls back to isSeeker=false on Helius failure.
- [x] `server/application/character.ts` — `CharacterService.create`. 23505 → AliasTakenError, existing character → ForbiddenError.
- [x] `server/application/lottery.ts` — `LotteryService.roll`. Reads weights from `contract/config/lottery.json`. Character existence is the M2 sentinel for AlreadyRolledError.
- [x] `server/application/needs.ts` — `NeedsService.apply`. Array-shaped config.
- [x] `server/application/public-profile.ts` — `PublicProfileService.byId`. `netWorthCents = cashCents - debtCents`.
- [x] `server/application/blocks.ts` — `BlocksService.block` / `unblock`. Idempotent.
- [x] `server/application/reports.ts`, `boards.ts`, `careers.ts`, `shifts.ts`, `daily-clue.ts`.
- [x] `server/api/main.ts` — Fastify composition root, request-id, idempotency onSend, error handler, 404.
- [x] `server/api/middleware/auth.ts` — bearer middleware.
- [x] `server/api/middleware/idempotency.ts` — cache-first reserve, body-hash mismatch.
- [x] `server/api/routes/{auth,core,social,work,ops}.ts` — every Phase 1 endpoint.
- [x] `tools/scripts/boundary-check.ts` — added APP_ROOTS.

### End-to-end smoke (real output, trimmed)

- `GET /healthz` → 200
- `GET /readyz` → 200 (postgres, redis, helius all OK)
- `GET /v1/config` → 200 (returns venues, archetypes, traits, etc.)
- `POST /v1/auth/dev` (with `Idempotency-Key: k1`) → 200, returns user + access/refresh tokens
- `POST /v1/auth/dev` (replay with same key) → 200, returns the same body
- `GET /v1/me` with bearer token → 200, returns Me shape
- `POST /v1/lottery/roll` → 200, returns `{"outcome":"insider","cashCents":300000,"debtCents":0,"homeId":"studio"}`
- `POST /v1/lottery/roll` (re-roll) → 409 `ALREADY_ROLLED`
- `POST /v1/characters` → 201; retry → 403 `character_exists`
- `POST /v1/needs/actions` (eat) → 200, hunger 50 → 80
- `POST /v1/blocks/{userId}` → 204; `DELETE` → 204
- `POST /v1/reports` → 204
- `GET /v1/leaderboards/net_worth?scope=global` → 200
- `POST /v1/shifts` (discord_mod) → 200, returns shiftId + endsAt
- `GET /v1/daily-clue` → 200

### Static gate this slice

```
$ pnpm typecheck    → no errors
$ pnpm lint         → no errors
$ pnpm format:check → all files match
$ pnpm docs:check   → OK (23 env vars, 23 error codes, links resolve)
$ pnpm boundary:check → layering OK (soft-size warn on auth.ts: 301 lines)
$ pnpm contract:check  → all steps green
$ pnpm test:unit    → 10/10 passed
$ pnpm smoke        → 7/7 required checks passed
$ pnpm db:verify    → 15/15 schema invariants passed
```
