# 0002 — Version pinning and deviations

## Context

The spec lists pinned versions, some of which are wrong or unreleased. Per the prompt's rule 3, every pinned version must be verified, and any deviation recorded.

## Decision

Pinned exactly where the version exists; otherwise the nearest compatible, with rationale:

- Node 22+. Use `engines.node >= 22` and `.nvmrc` of `22`.
- TypeScript 5.9.3. The spec requires 5 or 6 for colyseus/schema 5.0.36; TS 7 exists but is not yet in colyseus/schema's matrix. Pin latest 5.x.
- Fastify 5.12.5, Colyseus 0.18.9, `@colyseus/redis-presence` 0.18.5, `@colyseus/redis-driver` 0.18.4, `@colyseus/schema` 5.0.36, `@colyseus/sdk` 0.18.5, `@colyseus/testing` 0.18.6, BullMQ 6.3.11, `@solana/kit` 8.4.0, `@anchor-lang/core` 1.2.0, `livekit-server-sdk` 2.19.1, openapi-generator v7.25.0 (via `@openapitools/openapi-generator-cli` wrapper).
- Anchor CLI: spec says 1.2.0; only 1.1.2 (installed) and 2.0.0-rc.1 (cargo) exist. Use installed 1.1.2.
- Solana CLI: spec says 4.1.2; installed 3.1.10. Latest 4.x stable is 4.3.0. M0 uses installed 3.1.10; M3 may install 4.3.0 if required.
- `@coral-xyz/anchor` (npm) — spec's "Anchor 1.2.0" doesn't exist; latest is 0.32.1. Use 0.32.1 client-side.
- `anchor-lang` Rust crate: use 0.31.1 (compatible with installed Solana CLI and anchor-cli 1.1.2).
- Helius SDK: official is `helius-sdk@3.2.0` (built on `@solana/kit`). Use that.

## Consequences

- Versions are pinned exactly via `package.json` `engines` and `pnpm` overrides; CI fails on a version that doesn't match.
- A pre-commit hook and CI step warn when a "TODO bump Anchor 1.2.0" appears in code.
- `docs/DECISIONS.md` M0 section is the single source of truth for what was actually verified.
