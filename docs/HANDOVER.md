# Handover

> What the teammate and ops need to know at hand-off. Living document.

## What the teammate (Unity client) needs

1. **Repository layout.** They pull `contract/` from this repo (submodule, subtree, or CI sync — their choice). Codegen commands:
   - Realtime (C#): `pnpm contract:codegen` then look in `contract/realtime/generated/csharp/`.
   - REST models (C#): `openapi-generator-cli generate -i contract/openapi.yaml -g csharp -o client/Assets/Generated/Rest --global-property models,modelTests=false,apiTests=false,supportingFiles=false`.
2. **First step.** Run `pnpm contract:check` and `pnpm contract:codegen` once, then look at `contract/README.md`.
3. **Tag for FE.** After M1 we tag `contract-v1.0.0-rc1`. They sign v1.0.0, then we move on.
4. **Provisional FE-owned files.** `contract/ids/spots.json`, `contract/ids/anims.json`, `contract/ids/sfx.json`, `contract/config/mini_games.json` ship with `_provisional: true, _owner: "FE"`. They replace them by PR. Additions only after publication, never renames.

## What the FE-built mock is

- The `mock` Compose profile runs the **real** stack on the same ports (REST `:4010`, realtime `:2567`) with `ENABLE_DEV_AUTH=true` and a 20-bot population in Timeline Square. No fake data, no canned responses. It is the live server with dev auth and bots.
- Wallet flows (top-ups, ORE stake, paid calls) always go to staging even in mock mode, because the mock stack signs devnet transactions.
- See `tools/bots/world.ts` (M2).

## Environment URLs

TBD at M8 (Railway deploy).

## Dev token

- Local / mock: `POST /v1/auth/dev { wallet: "..." }` returns a pair of tokens (RS256, 15 min / 30 day). This endpoint only exists when `ENABLE_DEV_AUTH=true` and the process is not in `production` / `staging` / `prod` mode.
- Staging / prod: real Sign In With Solana via MWA.

## Known limitations (at handover time)

Filled in at the end of M8. Sections: wallet flows, push notifications, X link, mainnet ORE.

## Items in `UNVERIFIED.md`

Every item in `docs/UNVERIFIED.md` is a known gap. They are not blockers for the milestone gates that don't depend on them, but they are listed so nothing falls through.
