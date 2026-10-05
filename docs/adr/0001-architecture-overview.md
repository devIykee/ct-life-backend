# 0001 — Architecture overview

## Context

CT Life is a 3D multiplayer Crypto Twitter life-sim on Solana. The server must be authoritative for money, support hundreds of concurrent realtime players, run background workers (market engine, Sunday Unlock, NPC triggers, LLM chat), expose a Unity client to a stable contract, and deploy on Railway for staging and prod. Two engineers work in parallel against one contract; FE owns how things look, BE owns what is true.

## Decision

Use a single backend in TypeScript 5.9 strict on Node 22, split into four processes:

1. **`server/api`** — Fastify 5 REST.
2. **`server/realtime`** — Colyseus 0.18 rooms (city, venue, market, home).
3. **`server/workers`** — BullMQ 6 jobs (market tick, NPC triggers, Sunday Unlock, Meta rotation, daily clue, ORE reader, econ-sim).
4. **`programs/ct_escrow`** — Anchor 0.31 program for paid calls (separate Rust crate, deployed to Solana).

Cross-cutting:

- **`server/shared`** — domain logic and infrastructure adapters (Postgres repos, Redis, ledger, auth, solana, livekit, logger). Imports nothing from transport.
- **`packages/npc-brain`** — pure deterministic NPC state machines. Imports nothing.
- **`tools/bots`** — headless real-keypair clients for e2e and load.
- **`tools/econ-sim`** — 1,000-player economy simulator.
- **`tools/contract-check`** — schema validators, codegen, response validators, freshness.

## Alternatives considered

- **Nakama** (Go/Lua). Rejected by the build spec: the TypeScript runtime can't load npm Solana libraries, so money logic would need a second server.
- **Express.** Rejected in favor of Fastify for its built-in JSON Schema validation, better performance, and TypeScript ergonomics.
- **Single-process (api + realtime + workers).** Rejected: rooms and workers need to scale independently. A worker restart shouldn't drop connections.
- **A mock service for the FE.** Rejected: the spec's "mock" was a Prism+fake-data shim, but the prompt turns it into a real stack with `ENABLE_DEV_AUTH=true` and a bot population. This is cheaper to maintain and closer to the truth.

## Consequences

- Three deployable processes on Railway, plus the Anchor program.
- Cross-process messages go through Redis pub/sub (rooms ↔ workers) and Postgres (everything else). Latency budget: ≤100 ms for game-relevant signals.
- Composition roots are explicit (`server/api/main.ts`, etc.) and the only place that wires infrastructure to the domain.
- Layering is enforceable by ESLint and a `boundary-check` script in CI.
