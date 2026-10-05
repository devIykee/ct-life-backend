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
