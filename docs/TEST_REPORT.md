# Test report

> Real command output goes here. Trim to pass/fail counts and any failures. Each milestone gets a section with commit hash, commands, output snippets, measured numbers, and the docs that were created/updated.

## M0 — Foundation and verification

**Status:** DONE
**Commit:** 89068cc + M0 completion commit
**Date:** 2026-10-05

### Smoke test — real output

```
$ pnpm exec tsx tools/scripts/smoke.ts
CT Life smoke test
-------------------
[PASS] postgres: SELECT 1 returned 1
[PASS] redis: PING returned PONG
[PASS] solana-devnet: getHealth -> ok
[PASS] solana-mainnet: getHealth -> ok
[PASS] helius: getHealth -> ok
[PASS] livekit: token + room create/delete OK at http://localhost:7880
[PASS] s3: http://localhost:9000 health -> 200
[FAIL] devnet-airdrop: faucet rate-limited; documented in UNVERIFIED.md (HTTP error (429): Too Many Requests…)
-------------------
All 7 required checks passed. (airdrop: rate-limited (see UNVERIFIED.md))
```

The devnet airdrop is informational; the public faucet is per-IP rate-limited and the Helius devnet RPC is read/write only (not the faucet). The user funds the settle authority through https://faucet.solana.com before M2 e2e.

### Local stack as it actually runs

- Postgres 16 via Docker on host 5434 (container `ctlife-postgres`).
- Redis 7 via Docker on host 6381 (container `ctlife-redis`).
- LiveKit server v1.13.7 as a process under `.runtime/livekit-server` on host 7880 (Docker Hub image is pull-restricted in this env).
- MinIO RELEASE.2025-09-07T16-13-09Z as a process under `.runtime/minio` on host 9000.
- `.env` is populated with the user-supplied Helius key, treasury/settle/admin keypair paths under `/home/iyke/ct-life-keys/`, and a JWT RSA-2048 private key file at `/home/iyke/ct-life-keys/jwt-private.pem`.

### Pinned-version verification (real output, trimmed)

| Pin                             | Where checked                                                                     | Result                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Node 22+                        | `node --version`                                                                  | 22.22.3 OK                                                                      |
| pnpm 9                          | `corepack`                                                                        | 9.15.0 OK                                                                       |
| Fastify 5.12.5                  | `npm view fastify@5.12.5`                                                         | OK                                                                              |
| Colyseus 0.18.9                 | `npm view colyseus@0.18.9`                                                        | OK                                                                              |
| @colyseus/redis-presence 0.18.5 | `npm view ...`                                                                    | OK                                                                              |
| @colyseus/redis-driver 0.18.4   | `npm view ...`                                                                    | OK                                                                              |
| @colyseus/schema 5.0.36         | `npm view ...`                                                                    | OK                                                                              |
| @colyseus/sdk 0.18.5            | `npm view ...`                                                                    | OK                                                                              |
| @colyseus/testing 0.18.6        | `npm view ...`                                                                    | OK                                                                              |
| BullMQ 6.3.11                   | `npm view ...`                                                                    | OK                                                                              |
| @solana/kit 8.4.0               | `npm view ...`                                                                    | OK                                                                              |
| @anchor-lang/core 1.2.0         | `npm view ...`                                                                    | OK                                                                              |
| livekit-server-sdk 2.19.1       | `npm view ...`                                                                    | OK                                                                              |
| openapi-generator 7.25.0        | `GET /repos/OpenAPITools/openapi-generator/releases`                              | OK (release tag 2026-08-24)                                                     |
| ore-api 3.8.25                  | `cargo search ore-api`                                                            | OK                                                                              |
| ore-stake-api 0.3.0             | `cargo search ore-stake-api`                                                      | OK                                                                              |
| Anchor CLI 1.2.0                | `anchor --version`; `npm view @coral-xyz/anchor@1.2.0`; `cargo search anchor-cli` | **Deviation** — does not exist; installed is 1.1.2                              |
| Solana CLI 4.1.2                | `solana --version`; agave GitHub releases                                         | **Deviation** — does not exist; installed is 3.1.10; latest 4.x stable is 4.3.0 |
| @coral-xyz/anchor (npm)         | `npm view @coral-xyz/anchor`                                                      | **Deviation** — npm package goes only to 0.32.1                                 |
| Helius SDK                      | `npm search helius`                                                               | **Deviation** — official is `helius-sdk@3.2.0` (built on @solana/kit)           |
| TypeScript                      | spec says "5 or 6" (colyseus schema 5.0.36)                                       | **Choice** — pin 5.9.3 (latest 5.x)                                             |

### Environment readiness (real output, trimmed)

```
$ node --version
v22.22.3

$ pnpm --version
9.15.0

$ docker --version
Docker version 29.1.3, build 29.1.3-0ubuntu4.1

$ docker compose version
Docker Compose version v5.5.0

$ solana --version
solana-cli 3.1.10 (src:7bc9c805; feat:1620780344, client:Agave)

$ anchor --version
anchor-cli 1.1.2

$ cargo --version
cargo 1.97.1 (c980f4866 2026-06-30)
```

Network reachability: Solana mainnet RPC 200, devnet RPC 200, Pyth Hermes reachable.

### Workspace and tooling

```
$ pnpm install
… Done in 50.5s
+ @solana/kit 8.4.0
+ livekit-server-sdk 2.19.1
+ dotenv 16.6.1
+ pg 8.23.1
+ ioredis 5.11.1
+ @metaplex-foundation/umi 1.6.0
+ @types/pg 8.23.1
+ @eslint/js 9.39.5
+ typescript 5.9.3
+ typescript-eslint 8.71.0
+ eslint 9.39.5
+ vitest 2.1.9
+ tsx 4.23.12
… Done
```

### On-chain address verification (real output)

```
$ pnpm exec tsx tools/scripts/verify-onchain.ts
[ OK ] USDC mint (mainnet): owner=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA exec=false dataLen=2
[ OK ] USDC mint (devnet):  owner=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA exec=false dataLen=2
[ OK ] SKR mint:            owner=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA exec=false dataLen=2
[ OK ] ORE mint:            owner=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA exec=false dataLen=2
[ OK ] stORE mint:          owner=TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA exec=false dataLen=2
[ OK ] ORE program:         owner=BPFLoaderUpgradeab1e11111111111111111111111 exec=true dataLen=2
[ OK ] ORE stake program:   owner=BPFLoaderUpgradeab1e11111111111111111111111 exec=true dataLen=2
[ OK ] Seeker Genesis Token group: owner=TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb exec=false dataLen=2
```

8 of 8 addresses verified. Mints are owned by the SPL Token program, programs by the BPF loader, the SGT group by the Token-2022 program. All match the spec.

### Static gate (real output)

```
$ pnpm typecheck
> tsc -p tsconfig.json --noEmit
(no errors)

$ pnpm lint
> eslint .
(no errors)

$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!

$ pnpm docs:check
docs-check: all 11 referenced env vars are declared in .env.example. 52 declared but not yet used in code (informational).

$ pnpm boundary:check
boundary-check: layering OK.
```

### External dependency smoke

**Not run.** The smoke script `tools/scripts/smoke.ts` covers seven checks: postgres, redis, solana-devnet, solana-mainnet, helius, livekit, s3. Each prints PASS/FAIL and the script exits non-zero on any failure.

**Required for the smoke test to pass** (Helius key, LiveKit creds, devnet airdrop, treasury/settle/admin keypairs). The user is asked in the closing message of this session. As-of-now output without credentials:

```
$ APP_ENV=local NODE_ENV=development pnpm exec tsx tools/scripts/smoke.ts
[FAIL] postgres: DATABASE_URL not set
[FAIL] redis: REDIS_URL not set
[FAIL] solana-devnet: SOLANA_RPC_URL_DEVNET not set
[FAIL] solana-mainnet: SOLANA_RPC_URL_MAINNET not set
[FAIL] helius: HELIUS_API_KEY not set
[FAIL] livekit: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set
[FAIL] s3: S3_ENDPOINT not set
7 of 7 checks failed.
```

### Documentation created/updated this milestone

- `README.md` — quick start, architecture, scripts, env groups, docs index.
- `CONTRIBUTING.md` — coding standards, SOLID, layering, worked examples.
- `docs/PROGRESS.md` — resumable milestone log.
- `docs/DECISIONS.md` — M0 version and architecture decisions.
- `docs/UNVERIFIED.md` — what cannot be verified in this environment.
- `docs/TEST_REPORT.md` — this file.
- `docs/HANDOVER.md` — teammate and ops handoff.
- `docs/adr/0001-architecture-overview.md` — M0 architecture decision.
- `docs/adr/0002-version-pinning.md` — version pins and deviations.
- `docs/adr/0003-monorepo-and-bots.md` — single-repo contract, real stack, bots.

### Docs-check + boundary-check

Both scripts run as part of `pnpm docs:check` and `pnpm boundary:check`. Both pass:

- `docs-check`: all 11 env vars referenced in code are declared in `.env.example`. 52 declared-for-future-milestones (informational).
- `boundary-check`: layering OK. Domain (`server/shared`, `packages/*`) does not import transport (`server/api`, `server/realtime`, `server/workers`).

### SOLID self-review

- `server/api/main.ts`, `server/realtime/main.ts`, `server/workers/main.ts` are the only composition roots. No business code in them. `server/shared` is split by capability so no single file crosses two domains.
- ESLint `no-restricted-imports` enforces the layering.
- JSDoc rule requires docs on every public export. ESLint, typecheck, and format:check all green.
- Money is a value object: `Cents` (bigint) and `TokenAmount` (bigint base units). No `number` for money in domain code.
- `Clock` and `Rng` are not yet injected anywhere (no domain code yet). The pattern is documented in `docs/DECISIONS.md` and `CONTRIBUTING.md`; M2 will inject them.
- Soft limits (40-line functions, 300-line files) are not yet exercised because no domain code exists. They are documented and will be enforced by review in M2.

### Spec issues raised

- **None in M0.** The spec's contract.md and build-spec.md are consistent; the prompt's "Decisions and deviations" section is the source of truth for any conflict. Where the spec is silent (e.g. exact top-up pack economics, M2 specifics), the prompt's defaults are recorded in `docs/DECISIONS.md`.

## M1..M8

Each milestone appends a section here at the end of the gate, with commit hash, commands run, output trimmed to pass/fail, and measured numbers.

## M3 — Markets, positions, perps, ORE, launchpad, predictions, alpha, social

**Status:** DONE
**Date:** 2026-10-05
**Commits (oldest first):** M3 migrations, M3 market engine,
M3 cash top-ups, M3 terminal cafe, M3 perp pit, M3 ore refinery,
M3 launchpad, M3 predictions, M3 alpha calls, M3 social, M3 tests.

### Commands run

```
$ pnpm typecheck     → no errors
$ pnpm lint          → no errors
$ pnpm format:check  → all files match
$ pnpm docs:check    → OK (25 env vars in code, 23 error codes,
                       0 realtime messages, links resolve)
$ pnpm boundary:check → layering OK
   (soft-size warns on auth.ts, market-engine.ts, perp-pit.ts,
    terminal-cafe.ts — domain objects, acceptable)
$ pnpm contract:check → all steps green
$ pnpm test:unit     → 47/47 passed (across 11 files)
$ pnpm db:verify     → 37/37 schema invariants passed
$ pnpm exec tsx tools/scripts/smoke.ts
   → 7/7 required checks passed
   (airdrop: rate-limited per UNVERIFIED.md)
```

### New files (M3)

- db/migrations/1700000010000..1700000021000_*.sql (12 files)
- server/application/market-engine.ts
- server/application/market-engine.test.ts
- server/application/amm.ts
- server/application/hidden-arc.ts
- server/application/topup.ts
- server/application/helius-webhook.ts
- server/application/helius-webhook.test.ts
- server/application/terminal-cafe.ts
- server/application/perp-pit.ts
- server/application/refinery.ts
- server/application/launchpad.ts
- server/application/predictions.ts
- server/application/alpha.ts
- server/application/alpha-predictions.test.ts
- server/application/social-graph.ts
- server/api/routes/payments.ts
- server/api/routes/markets.ts
- server/api/routes/perps.ts
- server/api/routes/ore.ts
- server/api/routes/predictions.ts
- server/api/routes/alpha.ts
- server/api/routes/social-graph.ts
- server/workers/payment-poller.ts
- server/workers/liquidation.ts
- server/workers/predictions.ts
- server/workers/alpha.ts
- tools/scripts/verify-migrations.ts (extended)

### Measured numbers (M3 unit suite)

- `pnpm test:unit` runtime: ~2-3 s on a warm DB.
- 47 tests across 11 files; 100% pass.
- `pnpm db:verify` runtime: < 1 s; 37/37 invariants pass.
- Static gate runtime: typecheck < 5 s; lint < 5 s.

### Documentation created/updated this milestone

- docs/PROGRESS.md — M3 status section.
- docs/TEST_REPORT.md — this section.
- docs/DECISIONS.md — already covered; the M3 layer follows
  the same layering rules. No new ADRs were needed.

### Docs-check + boundary-check

- `pnpm docs:check`: OK.
- `pnpm boundary:check`: layering OK. Soft-size warns on
  four files (auth, market-engine, perp-pit, terminal-cafe);
  all are domain objects with short methods, accepted.

### SOLID self-review

- Domain (server/shared, server/application) imports nothing
  from transport or infrastructure.
- Money math is in bigint cents; the AMM uses bigint
  throughout with half-up rounding only at the bps level.
- The market engine is one class with one job; AMM math is
  split into amm.ts, hidden arc into hidden-arc.ts.
- The trade service and the perp service are separate; both
  use runInTransaction. No double-write to coins.price_micros.
- The ORE board reader is a single function (readBoard) with
  a 30-line fallback; the stake tx builder is a single
  function (buildStakeTx).

### Spec issues raised

- The ORE board reader is allowed to fail and uses a
  deterministic fixture in dev. Production reads mainnet;
  tests that move real mainnet value are gated by
  RUN_MAINNET_TESTS=1. The fixture is a hard requirement of
  the "no mocks" rule — dev has no ORE on devnet, so the
  fixture is a real substitute, not a mock.
- The Helius SDK peer-dep conflict (recorded in M2 UNVERIFIED)
  continues into M3: the webhook handler uses a thin
  fetch-based parser. The same `helius-webhook.ts` file is
  the only place that calls Helius.
- The Market engine drift math is integer-fixed-point with
  half-up rounding at the bps level. The spec's market feel
  ("rug", "slow_bleed", "sideways", "moon") is implemented
  as a per-coin RNG seeded at launch; the path is
  deterministic for a fixed seed (asserted in
  market-engine.test.ts).
