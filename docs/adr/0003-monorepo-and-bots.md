# 0003 — Monorepo and bots

## Context

The contract lives in this repo; the client lives in a separate repo. The backend has four deployable processes plus a pure library plus three tooling areas. The contract is versioned in `contract/`; generated code in `contract/openapi/generated/` and `contract/realtime/generated/` is committed and checked for drift.

## Decision

- pnpm workspaces; root has dev tooling, apps are `server/*` and `packages/*`, tooling is `tools/*`.
- Codegen output is committed so the FE can pin a commit. CI runs the codegen and fails if the committed output is stale.
- The bot population (`tools/bots`) is a real-keypair headless client that hits the real REST API and joins real Colyseus rooms. It runs as a long-lived service under the `mock` Compose profile, providing a 20-bot population in Timeline Square (walk, emote, chat, trade).
- For staging, the same bots run on demand for the integration checklist.

## Alternatives considered

- **Two separate repos** (one for contract, one for server). Rejected: drift between contract and implementation is too easy; we want one CI to fail the build when codegen is stale.
- **Submodule for `contract/`**. The prompt allows submodule, subtree, or CI sync. We commit the source of truth in this repo and let the FE choose the sync mechanism.
- **A separate `mock` package**. Rejected: the mock is the real stack with `ENABLE_DEV_AUTH=true` and bots. No separate service to maintain.

## Consequences

- One repo, one CI, one deploy.
- The FE can pull `contract/` from a tag and trust the codegen output.
- A `mock` profile is a real-world local server, not a Prism+fake shim.
