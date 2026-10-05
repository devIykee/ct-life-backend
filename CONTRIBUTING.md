# CT Life backend — contributing

This is a solo-and-pair backend for the CT Life game. Code is read more often than it is written, so the bar is: would a new engineer with no context understand this in a year?

## Stack at a glance

- Node 22+, TypeScript 5.9 `strict`, Fastify 5, Colyseus 0.18, BullMQ 6
- Postgres 16, Redis 7, S3-compatible (MinIO in Compose)
- `@solana/kit` 8.4 for Solana client code, Anchor 0.31 client (no @coral-xyz/anchor 1.x; see `docs/DECISIONS.md`)
- `livekit-server-sdk` 2.19 for media tokens
- `pino` for structured logging

## Coding standards

- TypeScript `strict` is on. No `any` except at validated boundaries (Zod parses, JSON decoders).
- Money is a value object (`Cents`, `TokenAmount` with base units as `bigint`). No `number` for money, no `Math.random()` for randomness in domain logic.
- `Clock` and `Rng` are injected everywhere. Tests use a `SimulatedClock` and a seeded `Rng`.
- Errors are a typed domain hierarchy mapped to contract error codes in exactly one place (the transport boundary). Code throws domain errors, never raw `Error`.
- Idempotency-Key is required on every POST/PUT/PATCH/DELETE. Same key replays the first response.
- Every external call has a timeout. Every retry uses exponential backoff with jitter. No retry loops without a max.

## SOLID and layering

Five layers, dependencies point inward only:

```
transport (server/api, server/realtime, server/workers, programs, webhooks)
  → application services (use cases, orchestration, transactions)
    → domain (entities, value objects, pure rules: ledger, perps, market curve, tax, NPC brain)
      ← infrastructure adapters (Postgres repos, Redis, Helius, LiveKit, Solana, S3, price feeds, LLM)
```

The domain layer **must not** import from transport or infrastructure. Enforced by `tools/scripts/boundary-check.ts` and a `no-restricted-imports` ESLint rule.

Practical rules:

- **SRP.** Route handlers parse, call a service, shape the response. Services hold business rules. Repositories hold SQL. Adapters wrap external systems. A file that mixes HTTP, business logic, and SQL is a defect.
- **OCP.** Adding the 21st NPC archetype or a new currency must be one new file plus a registry line, not edits to existing logic.
- **LSP.** Every implementation of an interface honors its full contract (same error semantics, same invariants). Contract-test suites per interface (`PriceFeed`, `Clock`, `LedgerRepository`).
- **ISP.** Small role-specific interfaces. `BalanceReader`, not the whole ledger. `EventPublisher`, not the whole config.
- **DIP.** Business logic depends on interfaces in the domain layer. Infrastructure implements them. Composition roots: `server/api/main.ts`, `server/realtime/main.ts`, `server/workers/main.ts`.

Soft limits: functions about 40 lines, files about 300 lines, justify exceptions in a header comment.

## Commit and branch conventions

- Branch: `milestone/Mx-short-name` or `feature/short-name`.
- Commit: `milestone Mx: <name>` at the end of every milestone.
- One milestone per branch. Squash-merge to `main`.

## Adding things (worked examples)

### A new endpoint

1. Add the operation to `contract/openapi.yaml` with summary, description, every parameter, every error code, an example response. Run `pnpm contract:check` — CI fails if drift.
2. Add a route file in `server/api/routes/<resource>.ts` that parses, calls a service, shapes the response.
3. Add a service in `server/api/services/<resource>.ts` that holds the business rules.
4. Add a repository method in `server/shared/db/<resource>.ts` for any SQL.
5. Add an integration test in `server/api/__tests__/<resource>.test.ts` that hits the real DB and asserts every error code.
6. Update `docs/REALTIME.md` if the endpoint also pushes a realtime message, or `docs/DATA_MODEL.md` if it changes the schema.
7. Run `pnpm docs:check` to confirm the env-var / error-code / message coverage is still complete.

### A new realtime message

1. Add the type to `contract/realtime/messages.ts` (Zod schema for payload, with limits).
2. Add the handler to the relevant Colyseus room in `server/realtime/rooms/<room>.ts`.
3. Add a description to `docs/REALTIME.md`.
4. The room message's code (if rejected) must come from `contract/ids/errors.json`.

### A new NPC archetype

1. Add the archetype to `contract/ids/archetypes.json` and the lines to `contract/config/npc_lines.json` (30–60 lines).
2. Create a new file in `packages/npc-brain/archetypes/<id>.ts` with a state machine.
3. Register the archetype in `packages/npc-brain/registry.ts`.
4. Add a diagram to `docs/NPCS.md`.

### A new currency

1. Add the mint/decimals/bonus to `contract/config/economy.json`.
2. Create `server/shared/solana/currency/<symbol>.ts` implementing the `CurrencyHandler` interface (decimals, mint, transfer-checked builder, intent verifier).
3. Register it in `server/shared/solana/currency/registry.ts`.
4. Add a row to `docs/ECONOMY.md` (faucet/sink, formula, decimals).

### A new config file

1. Add the JSON file to `contract/config/`.
2. Add a JSON Schema to `contract/config/<file>.schema.json`.
3. Add a `docs/CONFIG.md` (or sibling `*.md`) entry explaining each key, unit, range, and in-game effect.
4. `pnpm contract:check` runs the schema validator.

### A new registry ID

1. Add the ID to the appropriate `contract/ids/<registry>.json`.
2. If FE-owned (`spots.json`, `anims.json`, `sfx.json`, `mini_games.json`), mark `"_owner": "FE"`.
3. IDs are snake_case, never renamed, never reused.

## Secrets

- All secrets are env vars. Commit only `.env.example`.
- Treasury and settle-authority keys are loaded from env (or a secret store). Never in files in the repo.
- Devnet and mainnet keys are separate variables (`*_DEVNET` and `*_MAINNET`).
- `gitleaks` runs in CI on every push. If a secret leaks, rotate immediately and do not try to clean the history.

## Don'ts

- Do not commit a mainnet signing key. Do not commit a private key at all.
- Do not call ORE `deploy` or `automate`. ORE is read-only plus staking via the stake program.
- Do not build features that pay real money from a game outcome. Cash is never withdrawable.
- Do not use the word "jeet" in NPC lines or anywhere in code.
- Do not mock at the test boundary. Tests hit real services via Compose or Testcontainers; only time and randomness are simulated.
- Do not skip the docs. A milestone is not done if its documentation is missing or stale.
