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

- [ ] #28 server/shared infrastructure (pg pool with SERIALIZABLE + statement_timeout, Unit of Work, ioredis, JWT, Helius, LiveKit, S3, Solana keypairs, pino, config, idempotency, rate limiter, error handler).
- [ ] #29 REST API composition root.
- [ ] #30 packages/npc-brain.
- [ ] #31 server/realtime.
- [ ] #32 server/workers.
- [ ] #33 tools/bots.
- [ ] #34 tools/econ-sim.
- [ ] #35 tests + load + bot e2e.
