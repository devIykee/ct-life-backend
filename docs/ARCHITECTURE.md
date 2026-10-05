# Architecture

> System overview, process boundaries, data-flow diagrams, layering rules, and composition roots. Living document. The contract is in `contract/`, the source-of-truth for both teams.

## Process boundaries

The backend runs as four independently deployable processes. All shared state lives in Postgres or Redis. No in-process caches affect correctness; the only in-memory authoritative state is Colyseus room state, which is disposable or reconstructable.

| Process              | Language                   | Port | Replicas (prod)  | Replicas (local)    | Owns                                                                           |
| -------------------- | -------------------------- | ---- | ---------------- | ------------------- | ------------------------------------------------------------------------------ |
| `server/api`         | TypeScript / Fastify 5     | 4010 | 2+               | 1 (mock profile: 1) | REST                                                                           |
| `server/realtime`    | TypeScript / Colyseus 0.18 | 2567 | 2+ (M3+ sharded) | 1 (M0-M2)           | Realtime rooms                                                                 |
| `server/workers`     | TypeScript / BullMQ 6      | —    | 2+               | 1                   | Market tick, NPC events, Sunday Unlock, ORE reader, webhook ingest, daily clue |
| `programs/ct_escrow` | Rust / Anchor 0.31         | —    | n/a              | n/a                 | Paid-call escrow on Solana                                                     |

Each process has exactly one composition root (`main.ts`) that wires infrastructure adapters into the domain layer.

## Data flow

```mermaid
flowchart LR
  Client[Unity 6.3 client]
  CDN[CDN / static cache]
  API[server/api]
  RT[server/realtime]
  WK[server/workers]
  PG[(Postgres 16)]
  RD[(Redis 7)]
  S3[(S3 / MinIO)]
  Helius[Helius RPC + webhooks]
  Solana[Solana devnet / mainnet]
  ORE[ORE / stake program]
  SGT[Seeker Genesis Token]
  LiveKit[LiveKit Cloud]
  LLM[Anthropic API]

  Client -- HTTPS REST --> API
  Client -- WS Colyseus --> RT
  Client -- WebRTC --> LiveKit
  Client -- cache miss --> CDN
  CDN -- origin --> API

  API -- reads/writes --> PG
  API -- token bucket / cache --> RD
  API -- uploads --> S3
  API -- RPC + webhooks --> Helius
  API -- on-chain intents --> Solana
  API -- LLM calls --> LLM
  RT -- presence --> RD
  RT -- room state (ephemeral) --> RD
  WK -- jobs / pub-sub --> RD
  WK -- writes ledger --> PG
  WK -- reads ORE board --> ORE
  WK -- reads SGT --> SGT
  Helius -- webhook POST --> API
  LiveKit -- signed webhook --> API
```

## Layering

Dependencies point inward only.

```
transport (Fastify routes, Colyseus rooms, BullMQ processors, webhooks)
  -> application services (use cases, orchestration, transactions)
    -> domain (entities, value objects, pure rules: ledger, perps, market curve, tax, NPC brain)
      <- infrastructure adapters (Postgres repos, Redis, Helius, LiveKit, Solana, S3, price feeds, LLM)
```

Rules:

- The domain layer (`server/shared/domain/**`, `packages/npc-brain/**`) imports nothing from transport or infrastructure. Enforced by `tools/scripts/boundary-check.ts` and an ESLint `no-restricted-imports` rule in `eslint.config.mjs`.
- Composition roots (`server/api/main.ts`, `server/realtime/main.ts`, `server/workers/main.ts`) are the only places that wire infrastructure to the domain. They are the only places allowed to import transport.
- Money is a value object (`Cents`, `TokenAmount` with `bigint` base units). No `number` for money in domain code, no floating-point money math. `decimal.js` is allowed at the price-feed boundary only.
- Errors are a typed domain hierarchy. They are mapped to contract error codes in exactly one place, the transport boundary. No `throw new Error("…")` in business logic.
- One `Unit of Work` per ledger transaction. Services cannot forget to commit or roll back; the UoW is the only thing that calls `BEGIN` / `COMMIT` / `ROLLBACK`.
- Soft limits: functions about 40 lines, files about 300 lines, justified exceptions in a header comment.

## Auth flow

```mermaid
sequenceDiagram
  participant C as Client
  participant API as server/api
  participant Auth as Auth service
  participant Helius as Helius
  participant PG as Postgres
  C->>API: GET /v1/auth/challenge
  API->>PG: insert nonce (single-use, 5 min)
  API-->>C: { nonce, domain, statement, uri, version, chainId, issuedAt, expirationTime }
  C->>C: MWA sign-in payload + sign
  C->>API: POST /v1/auth/verify { address, signedMessage, signature, nonce }
  API->>Auth: verify nonce, message, Ed25519 sig
  Auth->>Helius: getTokenAccountsByOwnerV2 (SGT)
  Helius-->>Auth: accounts
  Auth-->>API: { userId, isSeeker, sgtMint? }
  API->>PG: upsert user, link sgtMint if present
  API-->>C: { accessToken (15 min), refreshToken (30 day), user }
  C->>API: every REST call: Authorization: Bearer <accessToken>
```

The refresh token rotates and revokes. The JWT is RS256; the public key is at `/v1/auth/jwks`; rotation is supported via `kid`.

## Top-up payment flow

```mermaid
sequenceDiagram
  participant C as Client
  participant API as server/api
  participant IntentSvc as Intent service
  participant WK as server/workers
  participant Helius as Helius webhook
  participant Solana as Solana
  C->>API: POST /v1/payments/intents { kind, sku, currency }
  API->>IntentSvc: build intent
  IntentSvc->>IntentSvc: lock live quote, apply bonus bps
  IntentSvc-->>API: { intentId, recipient, mint, amount, reference, memo, tx, expiresAt }
  API-->>C: PaymentIntent
  C->>Solana: sign_and_send tx
  Solana->>Helius: observed
  Helius->>API: webhook POST (signed)
  API->>WK: enqueue { intentId, signature }
  WK->>WK: SERIALIZABLE tx, check signature uniqueness, mint, amount, memo, expiry
  WK->>Solana: getTransaction (finalized reconcile)
  WK->>PG: ledger_entries + balances update
  WK-->>C: city room payment_confirmed
```

## Trade and liquidation flow (M3)

```mermaid
sequenceDiagram
  participant C as Client
  participant API as server/api
  participant Market as Market room
  participant Leader as Market engine (leader)
  participant WK as server/workers
  participant PG as Postgres
  C->>API: POST /v1/market/trades { coinId, side, amount, maxSlippageBps }
  API->>Leader: trade request (Redis queue)
  Leader->>Leader: bond-curve quote, slippage check, fee
  Leader->>PG: SERIALIZABLE: ledger entry, position update
  Leader->>Market: tape { coinId, side, cashCents, name } (trades >= $1000 only)
  Leader->>Market: state patch
  Note over Leader: ticks every 2 s, deterministic seed
  C->>API: POST /v1/perps { coinId, side, leverage, marginCents }
  API->>Leader: open perp
  Note over Leader: liquidation engine per tick,<br/>liq price = entry * (1 - 1/leverage) for long
  Leader->>PG: liquidated? insert tombstone, ledger entry
  Leader->>City: liquidated { perpId, coinId, lossCents, at }
  Leader->>API: REKT card
```

## Sunday Unlock flow (M5)

```mermaid
sequenceDiagram
  participant WK as Sunday Unlock worker
  participant PG as Postgres
  participant RD as Redis (flags)
  C->>WK: cron Sun 20:00 UTC
  WK->>PG: rent due (each player)
  WK->>PG: gas bill (each player)
  WK->>PG: debt repayment (each player with debt) + 10% penalty if missed
  WK->>PG: Weekly Meta rotation
  C->>WK: cron Mon 00:00 UTC
  WK->>PG: tax reset, weekly boards reset
  Note over WK: idempotent; safe if run twice or missed (catch-up on boot)
```

## NPC event propagation (M2+)

```mermaid
flowchart LR
  Launcher[Market launcher worker] -- coin_launch event --> Bus[(Redis pub/sub)]
  LiqEngine[Liquidation engine] -- liquidation event --> Bus
  MoodSvc[Market Mood worker] -- mood_change --> Bus
  OREReader[ORE reader worker] -- motherlode event --> Bus
  Bus -- subscribe --> VenueRoom[Venue room]
  Bus -- subscribe --> CityRoom[City room]
  VenueRoom -- Town Crier NPC reacts --> Client
  CityRoom -- city event broadcast --> Client
```

## Paid-call flow (M4)

```mermaid
sequenceDiagram
  participant Fan
  participant Creator
  participant API
  participant Solana
  participant Ctescrow[ct_escrow]
  participant Helius
  participant LiveKit
  Fan->>API: POST /v1/paid-calls { creatorId, minutes }
  API-->>Fan: { callId, sessionPda, tx (open_session) }
  Fan->>Solana: sign_and_send
  Solana->>Ctescrow: open_session
  Helius->>API: SessionOpened event
  API->>API: create LiveKit room, push call_invite to Creator
  Creator->>API: accept
  API->>Ctescrow: accept (settle_authority signs)
  Fan->>LiveKit: join room
  Creator->>LiveKit: join room
  Note over LiveKit: live for `paid_max` minutes or until creator ends
  LiveKit->>API: room_finished webhook (signed)
  API->>Ctescrow: settle(seconds_used)
  Ctescrow-->>Fan: refund
  Ctescrow-->>Creator: rate * minutes
  Ctescrow-->>API: treasury fee
```

## Deployment topology

```mermaid
flowchart TB
  subgraph Railway
    subgraph api
      API1[api instance 1]
      API2[api instance 2]
    end
    subgraph realtime
      RT1[realtime instance 1]
      RT2[realtime instance 2]
    end
    subgraph workers
      WK1[worker 1]
      WK2[worker 2]
    end
    PG[(Postgres)]
    RD[(Redis)]
    LK[LiveKit Cloud]
  end
  subgraph Solana
    Dev[Devnet]
    Main[Mainnet]
  end
  Helius[Helius]
  S3[(S3 / R2)]
  Client --> API1
  Client --> API2
  Client --> RT1
  Client --> RT2
  Client --> LK
  API1 --> PG
  API1 --> RD
  API1 --> S3
  API1 --> Helius
  Helius --> API1
  LK --> API1
  WK1 --> PG
  WK1 --> RD
  WK1 --> Solana
  API1 --> Solana
  API2 -. replicate state via Redis .-> API1
  RT1 -. presence/driver .-> RD
  RT2 -. presence/driver .-> RD
```

## See also

- `docs/DATA_MODEL.md` — tables, columns, indexes, ledger invariants
- `docs/REALTIME.md` — every room, state field, message
- `docs/ONCHAIN.md` — every program, PDA, instruction
- `docs/SECURITY.md` — threat model and authz matrix
- `docs/OPERATIONS.md` — deploy, rollback, migrations
- `docs/adr/` — architecture decision records
