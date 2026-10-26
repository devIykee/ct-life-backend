# CT Life Backend

**A 3D multiplayer crypto life simulation on Solana, built for the Solana Seeker phone.**

CT Life is a social metaverse where players build their identity, earn through mini-games, interact in voice/video calls, and manage their crypto assets. This repository contains the complete backend infrastructure: REST API, realtime multiplayer rooms, background workers, on-chain escrow program, and deployment configurations.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-22-green)](https://nodejs.org/)
[![Postgres](https://img.shields.io/badge/Postgres-16-blue)](https://www.postgresql.org/)
[![Solana](https://img.shields.io/badge/Solana-Devnet%20%7C%20Mainnet-purple)](https://solana.com/)

---

## Features

### Core Gameplay

- Character creation with customizable looks, tribes, dreams, and traits
- Lottery-based home assignment system
- Work shifts with mini-game scoring and crypto rewards
- Needs system (energy, hunger, fun, hygiene, sanity) with decay mechanics
- Skill progression across 6 categories

### Economy & Payments

- Multi-currency support (USDC, SOL, SKR, ORE)
- Secure payment flows with webhook verification
- Ledger-based transaction system with ACID guarantees
- Topup system with bonus rewards
- Debt management

### Social Features

- Direct messaging between players
- Friend system with requests and acceptance
- Bidirectional blocking for privacy
- Public profiles and user discovery

### Voice & Video

- Voice Spaces (audio-only group calls)
- Video calls with up to 10 participants
- Proximity voice in game venues
- LiveKit-powered real-time communication
- Secure per-user token minting

### Advanced Features

- Venue system with entrance spawning
- NPC interactions with state machines
- Admin tools for ratio arena and airdrops
- LLM-powered NPCs (optional)
- X (Twitter) account linking (optional)

---

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

---

## Quick Start

### Prerequisites

- **Node.js 22+** ([nvm](https://github.com/nvm-sh/nvm) recommended)
- **pnpm** (via `corepack enable`)
- **Docker & Docker Compose** (for local stack)
- **Postgres 16**, **Redis 7** (or use Docker Compose)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/devIykee/ct-life-backend.git
cd ct-life-backend

# 2. Install dependencies
nvm use
corepack enable
pnpm install

# 3. Set up environment
cp .env.example .env
# Edit .env with your credentials (see Environment Variables section)

# 4. Start local services (Postgres, Redis, MinIO)
pnpm dev:up

# 5. Run database migrations
pnpm db:migrate

# 6. Verify setup
pnpm smoke
pnpm typecheck
pnpm lint
```

### Running the Server

```bash
# Terminal 1: Start API server (default port: 4010)
tsx server/api/main.ts

# Terminal 2: Start realtime server (default port: 2567)
tsx server/realtime/main.ts

# Terminal 3: Start background workers
tsx server/workers/main.ts
```

---

## API Documentation

**Base URL**: `http://localhost:4010` (or your configured `PORT_API`)

### Authentication

All authenticated endpoints require:

```
Authorization: Bearer YOUR_ACCESS_TOKEN
```

All write operations (POST/PUT/PATCH/DELETE) require:

```
Idempotency-Key: UNIQUE_UUID_V4
```

### Key Endpoints

**Authentication**

- `POST /v1/auth/nonce` - Get SIWS nonce
- `POST /v1/auth/verify` - Sign in with wallet signature
- `POST /v1/auth/refresh` - Refresh access token

**Core Gameplay**

- `GET /v1/config` - Get all game configuration
- `GET /v1/me` - Get current user profile
- `POST /v1/lottery/roll` - Roll lottery (once per user)
- `POST /v1/characters` - Create character
- `POST /v1/shifts/start` - Start work shift
- `POST /v1/shifts/:id/complete` - Complete shift
- `POST /v1/needs/actions` - Apply needs action

**Social**

- `POST /v1/dms` - Send direct message
- `POST /v1/friends/:userId/request` - Send friend request
- `POST /v1/blocks/:userId` - Block user

**Voice/Video**

- `POST /v1/spaces` - Start voice space
- `POST /v1/video-calls` - Start video call
- `POST /v1/rtc/token` - Get RTC participant token

**Payments**

- `POST /v1/payments/intents` - Create payment intent
- `POST /v1/payments/verify` - Verify payment

**Full API documentation**: See [`docs/POSTMAN_ENDPOINTS.md`](docs/POSTMAN_ENDPOINTS.md)

---

## Security Features

### Authentication & Authorization

- Sign-In with Solana (SIWS) implementation
- Redis-backed nonce validation with 10-minute TTL
- JWT tokens with RS256 signing
- Admin wallet allowlist for protected endpoints

### Payment Security

- Recipient address verification on webhooks
- Base-unit amount validation
- HMAC signature verification (Helius webhooks)
- Idempotency keys prevent double-spend

### Rate Limiting

- Token bucket algorithm (20 req/s per user)
- Redis-backed for distributed systems
- Automatic 429 responses with `Retry-After` header

### Realtime Security

- JWT authentication on all 5 realtime rooms
- Per-user RTC token minting
- Participant validation for voice/video calls
- DB-backed profile verification

### Database Integrity

- SERIALIZABLE transaction isolation
- CHECK constraints prevent negative balances
- UNIQUE constraints on idempotency keys
- BigInt arithmetic eliminates floating-point errors

**Security documentation**: See [`docs/SECURITY.md`](docs/SECURITY.md)

---

## Repository Structure

```
ct-life-backend/
├── contract/         # Source of truth (OpenAPI, schemas, IDs, config)
├── server/
│   ├── api/          # Fastify 5 REST API
│   ├── realtime/     # Colyseus 0.18 multiplayer rooms
│   ├── workers/      # BullMQ background jobs
│   └── shared/       # Domain logic & adapters
├── packages/
│   └── npc-brain/    # NPC state machines
├── programs/
│   └── ct_escrow/    # Anchor 0.31 on-chain program
├── tools/
│   ├── bots/         # Headless test clients
│   ├── contract-check/ # Schema validation & codegen
│   └── scripts/      # Utilities (keygen, smoke tests)
├── db/migrations/    # SQL migrations (node-pg-migrate)
└── docs/             # Documentation
```

---

## Environment Variables

### Required

| Variable                 | Purpose                      | Example                                      |
| ------------------------ | ---------------------------- | -------------------------------------------- |
| `APP_ENV`                | Deployment environment       | `local`, `staging`, `prod`                   |
| `DATABASE_URL`           | PostgreSQL connection string | `postgres://user:pass@localhost:5432/ctlife` |
| `REDIS_URL`              | Redis connection string      | `redis://localhost:6379/0`                   |
| `JWT_PRIVATE_KEY`        | RS256 private key (PEM)      | `/path/to/jwt-private.pem`                   |
| `SOLANA_RPC_URL`         | Solana RPC endpoint          | `https://api.mainnet-beta.solana.com`        |
| `SOLANA_TREASURY_PUBKEY` | Treasury wallet address      | `YOUR_TREASURY_PUBKEY`                       |
| `HELIUS_WEBHOOK_SECRET`  | Webhook HMAC secret          | `your-webhook-secret`                        |
| `LIVEKIT_API_KEY`        | LiveKit API key              | `your-livekit-key`                           |
| `LIVEKIT_API_SECRET`     | LiveKit API secret           | `your-livekit-secret`                        |

### Optional

| Variable                               | Purpose                                                                                                 | Default |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| `PORT_API`                             | API server port                                                                                         | `4010`  |
| `PORT_REALTIME`                        | Realtime server port                                                                                    | `2567`  |
| `ENABLE_DEV_AUTH`                      | Enable dev auth (local only)                                                                            | `false` |
| `LLM_ENABLED`                          | Enable LLM NPCs                                                                                         | `false` |
| `ANTHROPIC_API_KEY`                    | Anthropic API key                                                                                       | -       |
| `X_LINK_ENABLED`                       | Enable X account linking                                                                                | `false` |
| `TRIPO_API_KEY`                        | Server-only key for an explicitly authorized operator likeness trial; does not enable public generation | unset   |
| `LIKENESS_PRICE_USDC_CENTS`            | Approved retail price in integer USDC cents; never a client-supplied price                              | 300     |
| `LIKENESS_GENERATION_ENABLED`          | Allow configured generation; requires all other gates and owned entitlement                             | false   |
| `TRIPO_END_USER_AGREEMENT_CONFIRMED`   | Verified written Tripo end-user authorization                                                           | false   |
| `LIKENESS_OPERATOR_EVALUATION_ENABLED` | Separately authorized account-owner evaluation only                                                     | false   |
| `LIKENESS_OPERATOR_USER_IDS`           | Exact server user UUID allowlist for that evaluation                                                    | unset   |
| `LIKENESS_RUNTIME_PROFILE_CONFIRMED`   | Actual Unity/mobile acceptance of the supported Mixamo profile                                          | false   |
| `LIKENESS_PRIVATE_STORAGE_CONFIRMED`   | Verified dedicated private bucket policy/encryption                                                     | false   |
| `LIKENESS_PRIVATE_BUCKET`              | Private likeness bucket, distinct from advertising storage                                              | unset   |
| `LIKENESS_REFERENCE_MANIFEST`          | Absolute path to reviewed body-reference paths and hashes                                               | unset   |
| `LIKENESS_LOCAL_DIRECTORY`             | Private local development storage; refuses production                                                   | unset   |

**Complete list**: See [`.env.example`](.env.example)

---

### Optional and tuning

| Variable                          | Purpose                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                        | `development` or `production`; follows `APP_ENV`                                                                                                                                                 |
| `LOG_LEVEL`                       | Log level (`info` default)                                                                                                                                                                       |
| `JWT_PUBLIC_KEY`                  | JWT verification key (PEM), pairs with `JWT_PRIVATE_KEY`                                                                                                                                         |
| `HELIUS_API_KEY`                  | Helius API key                                                                                                                                                                                   |
| `HELIUS_RPC_URL_DEVNET`           | Helius devnet RPC URL                                                                                                                                                                            |
| `HELIUS_RPC_URL_MAINNET`          | Helius mainnet RPC URL                                                                                                                                                                           |
| `SOLANA_RPC_URL_DEVNET`           | Solana devnet RPC URL                                                                                                                                                                            |
| `SOLANA_RPC_URL_MAINNET`          | Solana mainnet RPC URL                                                                                                                                                                           |
| `TREASURY_PUBKEY_DEVNET`          | Devnet treasury wallet address                                                                                                                                                                   |
| `SETTLE_AUTHORITY_KEYPAIR_DEVNET` | Devnet escrow settle-authority keypair                                                                                                                                                           |
| `ADMIN_KEYPAIR_DEVNET`            | Devnet escrow admin keypair                                                                                                                                                                      |
| `LIVEKIT_URL`                     | LiveKit server URL                                                                                                                                                                               |
| `LIVEKIT_WEBHOOK_SECRET`          | LiveKit webhook secret                                                                                                                                                                           |
| `S3_ENDPOINT`                     | S3/MinIO endpoint                                                                                                                                                                                |
| `S3_ACCESS_KEY`                   | S3 access key                                                                                                                                                                                    |
| `S3_SECRET_KEY`                   | S3 secret key                                                                                                                                                                                    |
| `ADMIN_WALLETS`                   | Comma-separated wallets allowed on admin routes                                                                                                                                                  |
| `WIRE_V3_KINDS`                   | `true` once the client sends the v3 vehicle kinds (default `false`)                                                                                                                              |
| `CASINO_DAILY_STAKE_CAP_CENTS`    | Rug Room daily stake cap per player, cents (default 50000)                                                                                                                                       |
| `CASINO_DAILY_LOSS_CAP_CENTS`     | Rug Room daily net-loss cap per player, cents (default 25000)                                                                                                                                    |
| `EVENT_IRL_BONUS_CENTS`           | One-time Cash bonus for an IRL event check-in, cents (default 10000)                                                                                                                             |
| `TIP_FEE_BPS`                     | Fee burned on every Cash tip, basis points (default 300 = 3%, 0 turns it off)                                                                                                                    |
| `LIVE_PHASE`                      | Release phase the deployment has opened, 1 to 6 (default 1). Sent as `livePhase` in `GET /config`; the client opens the apps of every phase up to it. Set 6 to open all apps for private testers |
| `LLM_MODEL`                       | LLM model id for the AI NPCs                                                                                                                                                                     |
| `X_CLIENT_ID`                     | X (Twitter) OAuth client id                                                                                                                                                                      |
| `X_CLIENT_SECRET`                 | X OAuth client secret                                                                                                                                                                            |
| `X_REDIRECT_URI`                  | X OAuth redirect URI                                                                                                                                                                             |
| `X_AUTHORIZE_URL`                 | X OAuth authorize URL                                                                                                                                                                            |
| `X_TOKEN_URL`                     | X OAuth token URL                                                                                                                                                                                |
| `X_ME_URL`                        | X API "me" URL                                                                                                                                                                                   |
| `PORT_WORKERS`                    | Workers healthz port (`0` = no HTTP listener)                                                                                                                                                    |
| `TEST_DATABASE_URL`               | Postgres used by tests                                                                                                                                                                           |
| `TEST_SCHEMA`                     | Schema name used by tests                                                                                                                                                                        |
| `RUN_MAINNET_TESTS`               | `1` runs the read-only mainnet tests (off by default)                                                                                                                                            |

## Testing

```bash
# Type checking
pnpm typecheck

# Linting
pnpm lint

# Unit tests
pnpm test:unit

# Integration tests (requires Docker)
pnpm test:integration

# E2E tests (requires ENABLE_E2E=1)
pnpm test:e2e

# Smoke test all external dependencies
pnpm smoke

# Contract validation
pnpm contract:check
```

---

## Deployment

### Environments

| Environment    | API              | Realtime         | Blockchain                 |
| -------------- | ---------------- | ---------------- | -------------------------- |
| **Local**      | `localhost:4010` | `localhost:2567` | Devnet                     |
| **Staging**    | Railway          | Railway          | Devnet + Mainnet (testing) |
| **Production** | Railway          | Railway          | Mainnet                    |

### Database Migrations

```bash
# Apply migrations
pnpm db:migrate

# Rollback last migration
pnpm db:rollback

# Check migration status
pnpm db:status
```

---

## Documentation

- [`docs/POSTMAN_ENDPOINTS.md`](docs/POSTMAN_ENDPOINTS.md) - API testing guide
- [`docs/SECURITY.md`](docs/SECURITY.md) - Security features & threat model
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - System architecture
- [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) - Database schema
- [`docs/ECONOMY.md`](docs/ECONOMY.md) - Economy & formulas
- [`docs/REALTIME.md`](docs/REALTIME.md) - Realtime rooms & messages
- [`docs/NPCS.md`](docs/NPCS.md) - NPC state machines
- [`docs/ONCHAIN.md`](docs/ONCHAIN.md) - On-chain programs
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) - Operations guide
- [`docs/handoff/STATUS.md`](docs/handoff/STATUS.md) - Implementation status

---

## Contributing

We welcome contributions! Please see [`CONTRIBUTING.md`](CONTRIBUTING.md) for:

- Coding standards
- Branch and commit conventions
- Pull request process
- Testing requirements

---

## Tech Stack

**Backend**

- [Fastify 5](https://fastify.dev/) - High-performance REST API
- [Colyseus 0.18](https://colyseus.io/) - Multiplayer game server
- [BullMQ 6](https://bullmq.io/) - Background job processing
- [PostgreSQL 16](https://www.postgresql.org/) - Primary database
- [Redis 7](https://redis.io/) - Caching & rate limiting

**Blockchain**

- [Solana](https://solana.com/) - Layer 1 blockchain
- [Anchor 0.31](https://www.anchor-lang.com/) - Solana smart contracts
- [@solana/web3.js](https://solana-labs.github.io/solana-web3.js/) - Solana SDK

**Real-time Communication**

- [LiveKit](https://livekit.io/) - Voice & video infrastructure

**TypeScript**

- Strict mode enabled
- ESLint + Prettier
- Vitest for testing

---

## Support

- **Issues**: [GitHub Issues](https://github.com/devIykee/ct-life-backend/issues)
- **Documentation**: [`docs/`](docs/)
- **Security**: See [`SECURITY.md`](SECURITY.md)

---

## License

[MIT](./LICENSE) - Copyright (c) 2026 deviykee

---

**Built for Solana Seeker | Powered by Solana**
