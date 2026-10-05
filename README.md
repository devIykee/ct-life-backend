# CT Life — backend

CT Life is a 3D multiplayer Crypto Twitter life-sim on Solana, built native for the Solana Seeker phone. This repository contains everything server-side: REST API, realtime rooms, background workers, the on-chain `ct_escrow` program, the cross-team contract, headless test bots, and deployment config. The Unity client lives in a separate repo and pulls `contract/` from here.

## Status

| Milestone | Description                       | Status      |
| --------- | --------------------------------- | ----------- |
| M0        | Foundation and verification       | in progress |
| M1        | The contract (versioned, codegen) | not started |
| M2        | Phase 1: City and identity        | not started |
| M3        | Phase 2: Money and markets        | not started |
| M4        | Phase 3: Voice and calls          | not started |
| M5        | Phase 4: City life                | not started |
| M6        | Phase 5: Projects and ads         | not started |
| M7        | Phase 6: Competition              | not started |
| M8        | Hardening, deployment, handover   | not started |

See `docs/PROGRESS.md` for live status and `docs/TEST_REPORT.md` for per-milestone proof.

## Architecture

```mermaid
flowchart LR
  subgraph Client
    Unity[Unity 6.3 LTS]
  end

  subgraph Backend
    API[server/api · Fastify 5]
    RT[server/realtime · Colyseus 0.18]
    WK[server/workers · BullMQ 6]
    NP[packages/npc-brain]
    SH[server/shared · domain + adapters]
  end

  subgraph Stores
    PG[(Postgres 16)]
    RD[(Redis 7)]
    S3[(S3 / MinIO)]
  end

  subgraph Solana
    Dev[Devnet]
    Main[Mainnet]
    Escrow[ct_escrow program]
    ORE[ORE / stake]
  end

  subgraph Media
    LK[LiveKit]
  end

  Unity -- HTTPS / WS --> API
  Unity -- WS / Colyseus --> RT
  Unity -- LiveKit SDK --> LK
  API --> SH
  RT --> SH
  WK --> SH
  NP --> RT
  API --> PG
  API --> RD
  RT --> RD
  WK --> RD
  WK --> PG
  API --> S3
  API --> Dev
  API --> Main
  WK --> Main
  Escrow -. read .-> Main
  ORE -. read .-> Main
```

## Quick start

```bash
# 1. Toolchain
nvm use                    # Node 22
corepack enable            # pnpm

# 2. Environment
cp .env.example .env
# Fill in the credentials listed in .env.example. Required ones
# (Helius, LiveKit, treasury pubkeys, keypairs) are documented inline.

# 3. Local stack (Postgres, Redis, LiveKit dev, MinIO, api, realtime, workers)
pnpm dev:up

# 4. Smoke test every external dependency
pnpm smoke

# 5. Lint and typecheck
pnpm lint
pnpm typecheck

# 6. Run the contract checks (M1 onwards)
pnpm contract:check
```

## Environments

| Env       | REST             | Realtime         | Solana                      | Notes                                                     |
| --------- | ---------------- | ---------------- | --------------------------- | --------------------------------------------------------- |
| `local`   | `localhost:4010` | `localhost:2567` | devnet                      | Real stack via Docker Compose                             |
| `mock`    | `localhost:4010` | `localhost:2567` | devnet                      | Same stack with `ENABLE_DEV_AUTH=true` and bot population |
| `staging` | Railway          | Railway          | devnet + mainnet (ORE, SGT) | Two real Seekers for the integration checklist            |
| `prod`    | Railway          | Railway          | mainnet                     | Public launch                                             |

## Repository layout

```
ct-life-backend/
├── contract/         # Source of truth (OpenAPI, Colyseus schemas, IDs, config, IDL)
├── server/
│   ├── api/          # Fastify 5 REST
│   ├── realtime/     # Colyseus 0.18 rooms
│   ├── workers/      # BullMQ jobs
│   └── shared/       # Domain + adapters (db, redis, ledger, auth, solana, livekit)
├── packages/
│   └── npc-brain/    # Pure, deterministic NPC state machines
├── programs/ct_escrow/  # Anchor 0.31 program
├── tools/
│   ├── bots/         # Headless real-keypair clients for e2e and load
│   ├── econ-sim/     # 1,000-player economy simulator
│   ├── contract-check/  # Schema, codegen, response validation
│   └── scripts/      # keygen, smoke, docs-check, boundary-check
├── db/migrations/    # node-pg-migrate SQL
├── docs/             # spec/, adr/, all top-level docs
└── .github/workflows/ci.yml
```

## Scripts

| Command                 | What it does                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev:up`           | Start the local stack (Postgres, Redis, LiveKit dev, MinIO, api, realtime, workers) |
| `pnpm dev:down`         | Stop the local stack                                                                |
| `pnpm dev:logs`         | Tail the stack logs                                                                 |
| `pnpm smoke`            | Smoke-test every external dependency                                                |
| `pnpm keygen`           | Generate a devnet keypair (treasury, settle authority, admin)                       |
| `pnpm typecheck`        | TypeScript `strict` over all workspaces                                             |
| `pnpm lint`             | ESLint (incl. JSDoc, layering) over all workspaces                                  |
| `pnpm format`           | Prettier write                                                                      |
| `pnpm test`             | All test suites                                                                     |
| `pnpm test:unit`        | Pure unit tests                                                                     |
| `pnpm test:integration` | Real Postgres + Redis via Compose                                                   |
| `pnpm test:e2e`         | Bots on real devnet (gated by `ENABLE_E2E=1`)                                       |
| `pnpm contract:check`   | Schema, codegen, response validation                                                |
| `pnpm contract:codegen` | Run codegen into `contract/openapi/generated/` and `contract/realtime/generated/`   |
| `pnpm docs:check`       | Verify env vars, error codes, room messages are documented                          |
| `pnpm boundary:check`   | Verify layering (domain never imports transport)                                    |
| `pnpm anchor:build`     | Build the `ct_escrow` program                                                       |
| `pnpm anchor:test`      | Run Anchor tests on `solana-test-validator`                                         |

## Environment variables

Every variable the backend reads is documented in `.env.example`. The `docs:check` script fails the build if any variable referenced in code is missing from `.env.example` or this README. The exhaustive list, grouped by purpose:

### Process

| Variable        | Purpose                                                                     | Required | Example       |
| --------------- | --------------------------------------------------------------------------- | -------- | ------------- |
| `APP_ENV`       | Deployment profile: `local` \| `mock` \| `staging` \| `prod`.               | yes      | `local`       |
| `NODE_ENV`      | Follows `APP_ENV` (`production` for staging/prod, otherwise `development`). | yes      | `development` |
| `LOG_LEVEL`     | pino log level.                                                             | yes      | `info`        |
| `PORT_API`      | REST listen port for `server/api`.                                          | yes      | `4010`        |
| `PORT_REALTIME` | Colyseus listen port for `server/realtime`.                                 | yes      | `2567`        |
| `PORT_WORKERS`  | HTTP listen port for `server/workers`; `0` means no HTTP.                   | yes      | `0`           |

### Solana

| Variable                           | Purpose                                                   | Required   | Example                                      |
| ---------------------------------- | --------------------------------------------------------- | ---------- | -------------------------------------------- |
| `SOLANA_RPC_URL_DEVNET`            | Devnet RPC.                                               | yes        | `https://api.devnet.solana.com`              |
| `SOLANA_RPC_URL_MAINNET`           | Mainnet RPC.                                              | yes        | `https://api.mainnet-beta.solana.com`        |
| `SOLANA_WS_URL_DEVNET`             | Devnet WebSocket.                                         | yes        | `wss://api.devnet.solana.com`                |
| `SOLANA_WS_URL_MAINNET`            | Mainnet WebSocket.                                        | yes        | `wss://api.mainnet-beta.solana.com`          |
| `SOLANA_COMMITMENT`                | Default commitment.                                       | yes        | `confirmed`                                  |
| `SOLANA_FINALIZED_COMMITMENT`      | Commitment for the reconciliation pass.                   | yes        | `finalized`                                  |
| `TREASURY_PUBKEY_DEVNET`           | Treasury wallet on devnet (top-ups land here).            | yes (M2+)  | `Dgw3c4GbQ…N2gZ`                             |
| `TREASURY_PUBKEY_MAINNET`          | Treasury wallet on mainnet.                               | yes (prod) | —                                            |
| `SETTLE_AUTHORITY_KEYPAIR_DEVNET`  | Path or base58 of the settle authority keypair on devnet. | yes (M3+)  | `/home/iyke/ct-life-keys/settle-devnet.json` |
| `SETTLE_AUTHORITY_KEYPAIR_MAINNET` | Same for mainnet.                                         | yes (prod) | —                                            |
| `ADMIN_KEYPAIR_DEVNET`             | Path or base58 of the admin keypair on devnet.            | yes (M2+)  | `/home/iyke/ct-life-keys/admin-devnet.json`  |
| `ADMIN_KEYPAIR_MAINNET`            | Same for mainnet.                                         | yes (prod) | —                                            |
| `CT_ESCROW_PROGRAM_ID_DEVNET`      | ct_escrow program id on devnet.                           | yes (M4+)  | —                                            |
| `CT_ESCROW_PROGRAM_ID_MAINNET`     | Same for mainnet.                                         | yes (prod) | —                                            |

### Helius

| Variable                 | Purpose                                           | Required  | Example                                     |
| ------------------------ | ------------------------------------------------- | --------- | ------------------------------------------- |
| `HELIUS_API_KEY`         | Helius API key (free tier, 10 req/s, 1M credits). | yes       | —                                           |
| `HELIUS_RPC_URL_DEVNET`  | Helius devnet RPC URL with `?api-key=…`.          | yes       | `https://devnet.helius-rpc.com/?api-key=…`  |
| `HELIUS_RPC_URL_MAINNET` | Helius mainnet RPC URL with `?api-key=…`.         | yes       | `https://mainnet.helius-rpc.com/?api-key=…` |
| `HELIUS_WEBHOOK_SECRET`  | HMAC secret for the Helius webhook.               | yes (M2+) | —                                           |

### LiveKit

| Variable                 | Purpose                        | Required  | Example                   |
| ------------------------ | ------------------------------ | --------- | ------------------------- |
| `LIVEKIT_URL`            | LiveKit server URL.            | yes       | `ws://localhost:7880`     |
| `LIVEKIT_API_KEY`        | LiveKit API key (server-side). | yes       | `devkey`                  |
| `LIVEKIT_API_SECRET`     | LiveKit API secret.            | yes       | `devsecret_please_change` |
| `LIVEKIT_WEBHOOK_SECRET` | Webhook signing secret.        | yes (M3+) | —                         |

### Database and cache

| Variable       | Purpose                 | Required | Example                                          |
| -------------- | ----------------------- | -------- | ------------------------------------------------ |
| `DATABASE_URL` | Postgres URL.           | yes      | `postgres://ctlife:ctlife@localhost:5434/ctlife` |
| `DATABASE_SSL` | Enable TLS to Postgres. | yes      | `false`                                          |
| `REDIS_URL`    | Redis URL.              | yes      | `redis://localhost:6381/0`                       |
| `REDIS_TLS`    | Enable TLS to Redis.    | yes      | `false`                                          |

### Auth

| Variable                  | Purpose                                                         | Required | Example                                   |
| ------------------------- | --------------------------------------------------------------- | -------- | ----------------------------------------- |
| `JWT_PRIVATE_KEY`         | RS256 private key in PEM (or path).                             | yes      | `/home/iyke/ct-life-keys/jwt-private.pem` |
| `JWT_PUBLIC_KEY`          | RS256 public key (auto-derived from the private in local/mock). | optional | —                                         |
| `JWT_KEY_ID`              | `kid` published in JWKS.                                        | yes      | `ctlife-1`                                |
| `JWT_ACCESS_TTL_SECONDS`  | Access-token TTL.                                               | yes      | `900`                                     |
| `JWT_REFRESH_TTL_SECONDS` | Refresh-token TTL.                                              | yes      | `2592000`                                 |

### Storage (S3)

| Variable              | Purpose                        | Required  | Example                 |
| --------------------- | ------------------------------ | --------- | ----------------------- |
| `S3_ENDPOINT`         | S3-compatible endpoint.        | yes (M5+) | `http://localhost:9000` |
| `S3_REGION`           | Region for the SDK.            | yes       | `us-east-1`             |
| `S3_ACCESS_KEY`       | Access key.                    | yes       | `minioadmin`            |
| `S3_SECRET_KEY`       | Secret key.                    | yes       | `minioadmin`            |
| `S3_BUCKET`           | Default bucket.                | yes       | `ctlife-uploads`        |
| `S3_FORCE_PATH_STYLE` | Path-style addressing (MinIO). | yes       | `true`                  |

### Auth flags

| Variable               | Purpose                                                                            | Required | Example |
| ---------------------- | ---------------------------------------------------------------------------------- | -------- | ------- |
| `ENABLE_DEV_AUTH`      | Enables `POST /v1/auth/dev`. Hard-fails at startup if true in `staging` or `prod`. | yes      | `false` |
| `ALLOW_ALIAS_OVERRIDE` | Dev only; lets bots reuse a single alias.                                          | optional | `false` |

### Optional M5+

| Variable            | Purpose                                                                 | Required      | Example |
| ------------------- | ----------------------------------------------------------------------- | ------------- | ------- |
| `PUSH_ENABLED`      | Push notifications. Off until Seeker Google Play services is confirmed. | optional      | `false` |
| `PUSH_PROVIDER`     | `fcm` \| `apns`.                                                        | optional      | `fcm`   |
| `FCM_SERVER_KEY`    | FCM server key.                                                         | optional      | —       |
| `LLM_ENABLED`       | Enable LLM NPCs.                                                        | optional      | `false` |
| `ANTHROPIC_API_KEY` | API key for LLM NPCs (M7).                                              | optional (M7) | —       |
| `LLM_MODEL`         | LLM provider's flagship model id.                                       | optional (M7) | —       |
| `X_LINK_ENABLED`    | Verified X (Twitter) link.                                              | optional (M7) | `false` |
| `X_CLIENT_ID`       | X OAuth client id.                                                      | optional      | —       |
| `X_CLIENT_SECRET`   | X OAuth client secret.                                                  | optional      | —       |
| `X_REDIRECT_URI`    | X OAuth redirect URI.                                                   | optional      | —       |

### Optional M8

| Variable                 | Purpose         | Required | Example |
| ------------------------ | --------------- | -------- | ------- |
| `SENTRY_DSN`             | Error tracking. | optional | —       |
| `RAILWAY_TOKEN`          | Deploy bot.     | optional | —       |
| `RAILWAY_PROJECT_ID`     | Project id.     | optional | —       |
| `RAILWAY_ENVIRONMENT_ID` | Environment id. | optional | —       |

### Test safe-mode

| Variable                       | Purpose                                                 | Required | Example |
| ------------------------------ | ------------------------------------------------------- | -------- | ------- |
| `RUN_MAINNET_TESTS`            | Enable tests that move mainnet value. Default `0`.      | optional | `0`     |
| `ENABLE_E2E`                   | Enable E2E that hits external services.                 | optional | `0`     |
| `SGT_OVERRIDE`                 | Dev only; force `isSeeker=true`. Never in staging/prod. | optional | —       |
| `ORE_DEVNET_USE_MAINNET_CACHE` | Dev only; ORE on devnet uses cached mainnet values.     | optional | `false` |

## Documentation

- `docs/PROGRESS.md` — milestone status, last commands, blockers
- `docs/DECISIONS.md` — quick log of decisions and deviations
- `docs/UNVERIFIED.md` — claims that cannot be checked in this environment
- `docs/TEST_REPORT.md` — milestone gate evidence (commands + output)
- `docs/HANDOVER.md` — what the teammate and ops need at hand-off
- `docs/ARCHITECTURE.md` — system overview, data flow diagrams, composition roots
- `docs/DATA_MODEL.md` — every table, column, index, constraint
- `docs/ECONOMY.md` — every faucet/sink, formula, parameter
- `docs/REALTIME.md` — every room, message, validation
- `docs/NPCS.md` — every archetype state machine
- `docs/ONCHAIN.md` — every program, PDA, instruction, event
- `docs/SECURITY.md` — threat model, authz matrix
- `docs/OPERATIONS.md`, `docs/RUNBOOK.md` — deploy, incident playbooks
- `docs/TESTING.md` — how to run every test layer
- `docs/adr/NNNN-title.md` — architecture decision records
- `CONTRIBUTING.md` — coding standards, branch and commit conventions

## License

[MIT](./LICENSE) — Copyright (c) 2026 deviykee. See [LICENSE](./LICENSE) for the full text.
