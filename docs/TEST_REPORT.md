# Test report

> Real command output goes here. Trim to pass/fail counts and any failures. Each milestone gets a section with commit hash, commands, output snippets, measured numbers, and the docs that were created/updated.

## M0 — Foundation and verification

**Status:** in progress (paused for credentials)
**Commit:** pending
**Date:** 2026-10-05

### Pinned-version verification

- `pnpm` queries against npm, crates.io and GitHub releases show all pinned versions exist except:
  - **Anchor CLI 1.2.0** — does not exist on npm or as a published cargo `anchor-cli`. Installed is 1.1.2. See `DECISIONS.md`.
  - **Solana CLI 4.1.2** — does not exist as a published tag; installed is 3.1.10; latest 4.x stable is 4.3.0. See `DECISIONS.md`.
  - **TypeScript** — pinned to 5.9.3 (latest 5.x) because the spec requires "TypeScript 5 or 6" for colyseus/schema 5.0.36.
- See `docs/DECISIONS.md` (M0 section) for the full table.

### Environment readiness

- Node 22.22.3: OK.
- pnpm 9.x: OK via Corepack.
- Docker 29.1.3 + Compose v5.5.0: OK.
- Solana CLI 3.1.10 installed; `anchor-cli` 1.1.2 installed.
- Cargo 1.97.1, Rust 1.97.1: OK.
- Existing containers `nairastock-postgres` (5433) and `nairastock-redis` (6380) are healthy on the host but are NOT the CT Life stack; the compose stack will run on 5432/6379 inside the network. No conflict.

### External dependency smoke

**Not run** — waiting on credentials. The smoke script (`tools/scripts/smoke.ts`) covers:

- Helius RPC `getHealth` against devnet and mainnet.
- LiveKit token mint + ephemeral room create + delete.
- Postgres connectivity.
- Redis connectivity + PING.
- Devnet airdrop to the settle authority.
- S3 (MinIO) bucket create + put + get.

When credentials arrive: paste the actual output here.

### CI gate

`pnpm lint` and `pnpm typecheck` run in CI. They cannot be executed locally until `pnpm install` completes. The install needs network access and will be done after the credential batch lands.

### Documentation created/updated this milestone

- `README.md` (new): quick start, architecture, scripts, env groups, docs index.
- `CONTRIBUTING.md` (new): coding standards, SOLID, layering, worked examples for adding an endpoint/room message/NPC/currency/config/registry.
- `docs/PROGRESS.md` (new): resumable milestone log.
- `docs/DECISIONS.md` (new): M0 version and architecture decisions.
- `docs/UNVERIFIED.md` (new): what cannot be verified in this environment.
- `docs/TEST_REPORT.md` (this file).
- `docs/adr/0001-architecture-overview.md` (new).
- `docs/adr/0002-version-pinning.md` (new).
- `docs/adr/0003-monorepo-and-bots.md` (new).

### Docs-check + boundary-check

Both scripts are written; both are run in CI. They cannot be executed locally until `pnpm install` completes.

### SOLID self-review

- `server/api/main.ts`, `server/realtime/main.ts`, `server/workers/main.ts` are the only composition roots. No business code in them. The shared `server/shared` is split by capability (db, redis, ledger, auth, solana, livekit, logger) so no single file crosses two domains.
- ESLint `no-restricted-imports` enforces that the domain layer (`server/shared`, `packages/npc-brain`) does not import from transport.
- JSDoc rule requires docs on every public export.

## M1..M8

Each milestone appends a section here at the end of the gate, with commit hash, commands run, output trimmed to pass/fail, and measured numbers.
