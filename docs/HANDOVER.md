# Handover

> What the teammate (Unity client) and ops need to know at hand-off.
> Living document.

## TL;DR

The backend is in production-ready shape. Eight milestones
(M0..M8) have shipped; every milestone's gate passes in CI; the
local stack boots with `pnpm dev:up` and the dev auth path is
enabled. The Unity client pulls `contract/openapi.yaml` and
`contract/realtime/*.ts` from this repo, runs codegen, and points
at the api/realtime URLs.

## What the teammate (Unity client) needs

1. **Repository layout.** They pull `contract/` from this repo
   (submodule, subtree, or CI sync — their choice). Codegen:
   - Realtime (C#): `pnpm contract:codegen`, output in
     `contract/realtime/generated/csharp/`.
   - REST models (C#): `openapi-generator-cli generate -i
     contract/openapi.yaml -g csharp -o
     client/Assets/Generated/Rest --global-property
     models,modelTests=false,apiTests=false,supportingFiles=false`.
2. **First step.** `pnpm contract:check && pnpm contract:codegen`,
   then read `contract/README.md`.
3. **Tag.** After M1 the contract was tagged `contract-v1.0.0-rc1`.
   No breaking changes since — all M2..M7 work was additive and
   `pnpm contract:check` stays green. M8 confirmed no contract
   drift.
4. **Provisional FE-owned files.** `contract/ids/spots.json`,
   `contract/ids/anims.json`, `contract/ids/sfx.json`,
   `contract/config/mini_games.json` ship with `_provisional:
   true, _owner: "FE"`. The teammate replaces them by PR.
   Additions only after publication, never renames.

## Environment URLs

Set after first staging deploy. Until then, the local stack is:

| Service       | URL                                |
| ------------- | ---------------------------------- |
| REST API      | `http://localhost:4010`            |
| Realtime WS   | `http://localhost:2567`             |
| Postgres      | `postgres://localhost:5434/ctlife` |
| Redis         | `redis://localhost:6381`           |
| LiveKit HTTP  | `http://localhost:7880`            |
| MinIO         | `http://localhost:9000`            |

On Railway, the equivalent URLs are issued per service
(`https://ctlife-api.up.railway.app` etc.). See `docs/RAILWAY.md`.

## Dev token

- **Local / mock:** `POST /v1/auth/dev { wallet: "<solana base58
  pubkey>" }` returns `{ accessToken, refreshToken, id, wallet,
  isSeeker, hasCharacter }`. The endpoint only exists when
  `ENABLE_DEV_AUTH=true` and the process is not `production` /
  `staging` / `prod` — the build hard-fails at startup if those
  combine. See `server/shared/config/config.ts`.
- **Staging / prod:** real SIWS via Mobile Wallet Adapter on
  Seeker.

## What the FE-built mock is

- The `mock` Compose profile runs the **real** stack on the same
  ports (REST `:4010`, realtime `:2567`) with `ENABLE_DEV_AUTH=true`
  and a 20-bot population in Timeline Square. No fake data, no
  canned responses.
- Wallet flows (top-ups, ORE stake, paid calls) still sign devnet
  transactions in mock — the mock stack has real signing.

## Verified milestones

| Milestone | Status | Gate                                  |
| --------- | ------ | ------------------------------------- |
| M0        | DONE   | `pnpm smoke` 7/7 green                |
| M1        | DONE   | `pnpm contract:check` green            |
| M2        | DONE   | 32 unit tests, e2e with 20 bots        |
| M3        | DONE   | 47 unit tests, market engine + ORE   |
| M4        | DONE   | 99 unit tests, paid calls + LiveKit   |
| M5        | DONE   | 169 unit tests, Phase 4 + 5          |
| M6        | DONE   | covered by M5 (decision in DECISIONS)  |
| M7        | DONE   | 265 unit tests, Phase 6 competition  |
| M8        | DONE   | 295 unit tests, authz matrix, fuzz    |

Run the full gate locally:

```bash
pnpm install
pnpm dev:up              # Postgres + Redis + LiveKit + MinIO
pnpm db:migrate          # all 58 migrations
pnpm smoke               # 7/7 external dep checks
pnpm typecheck           # 0 errors
pnpm lint                # 0 errors
pnpm format:check        # clean
pnpm docs:check          # env vars + error codes + links
pnpm boundary:check      # layering OK
pnpm contract:check      # OpenAPI + C# codegen + response validation
pnpm test:unit           # 295/295 passed
pnpm db:verify           # 143/143 schema invariants
```

`pnpm exec tsx tools/load/staged-ramp.ts --bots 200 --duration 10`
exercises a 200-bot REST ramp and appends the result to
`docs/CAPACITY.md`. The 1k / 5k / 20k ramps are staging-only.

## Known limitations (at handover time)

| Item                                          | Where tracked                       | Workaround / next step                                 |
| --------------------------------------------- | ----------------------------------- | ------------------------------------------------------ |
| `helius-sdk` incompatible with @solana/kit 8  | `docs/UNVERIFIED.md` M0 #14         | Thin fetch client in `server/shared/solana/helius.ts`  |
| LiveKit + MinIO Docker Hub pulls blocked      | `docs/UNVERIFIED.md` M0 #12         | Run from `.runtime/` binaries locally                   |
| Anchor 1.2.0 CLI not published                | `docs/UNVERIFIED.md` M0 #10         | Installed 1.1.2; IDL works either way                  |
| Solana CLI 4.x not installed                  | `docs/UNVERIFIED.md` M0 #11         | 3.1.10 in env; 4.3.0 stable if upgrade needed          |
| Push notifications                            | `docs/UNVERIFIED.md` M3+             | Flag defaults off until Seeker Play services confirmed |
| X OAuth requires client creds                 | `docs/UNVERIFIED.md` M3+             | `X_LINK_ENABLED=false` if `X_CLIENT_ID` absent         |
| Mainnet ORE stake transaction                 | `docs/UNVERIFIED.md` M3+             | Gated by `RUN_MAINNET_TESTS=1`                         |
| LLM NPCs require Anthropic key               | `docs/UNVERIFIED.md` M7              | `LLM_NPCS_ENABLED=false` if `ANTHROPIC_API_KEY` absent  |

## Provisional FE-owned files (must replace)

The teammate is responsible for replacing these with real
values; the server treats them as read-only:

| File                                  | Status   |
| ------------------------------------ | -------- |
| `contract/ids/spots.json`            | provisional |
| `contract/ids/anims.json`            | provisional |
| `contract/ids/sfx.json`              | provisional |
| `contract/config/mini_games.json`    | provisional |

The PR they open must keep every existing ID and only add new
ones.

## Items in `docs/UNVERIFIED.md`

Every item in `docs/UNVERIFIED.md` is a known gap. They are not
blockers for the milestone gates but are listed so nothing falls
through. Read that file before opening issues.

## Where to look next

- `docs/ARCHITECTURE.md` — process boundaries, layering, data
  flows.
- `docs/ONCHAIN.md` — Solana accounts, escrow program, payment
  verification.
- `docs/ECONOMY.md` — every faucet and sink, the tax brackets,
  the formulas.
- `docs/SECURITY.md` — authz matrix, threat model.
- `docs/RUNBOOK.md` — incident playbooks.
- `docs/RAILWAY.md` — deploy steps.
- `docs/TESTING.md` — how to run each test layer.