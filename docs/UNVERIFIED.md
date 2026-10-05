# Unverified

> Claims in the spec or in this repo that we cannot verify in the current environment, with what would be needed to verify them. Anything in this list is a risk the team has agreed to ship with.

## M0

1. **Helius API key is missing from the environment.** Resolved in M0: `HELIUS_API_KEY=047020a7-…` was supplied. The smoke now reports `helius: getHealth -> ok`. The Helius devnet RPC URL must include the api-key as a query parameter (`?api-key=…`); the .env sets this. Without it the RPC returns 401.
2. **LiveKit credentials are missing.** Resolved in M0: dev creds are `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=devsecret_please_change`. The LiveKit server itself is downloaded as a binary from the GitHub release v1.13.7 (Docker Hub image is pull-restricted in this environment — see #11 below) and run from `.runtime/livekit-server`. The smoke test connects via Bearer JWT and creates + deletes a room.
3. **Solana devnet airdrop smoke is unverified.** Public devnet airdrop returns 429 from this IP: `"You've either reached your airdrop limit today or the airdrop faucet has run dry. Please visit https://faucet.solana.com"`. The Helius devnet RPC also rejected airdrop (the Helius RPC node is for read/write, not the faucet). The M0 smoke treats the airdrop as informational and does not block the gate. Workarounds: visit https://faucet.solana.com once per wallet, or use the `@solana/test-validator` local validator for CI. We will need a funded settle authority on devnet for the M2 and M4 e2e. Recorded here so the next session knows.
4. **SKR devnet mint.** The contract says "if no devnet mint, SKR payments are enabled only when `APP_ENV=prod`". Will check on devnet at M3 by querying `getAccountInfo` for the SKR mint. If missing on devnet, the SKR currency handler refuses to start and the SKR top-up SKU is hidden.
5. **ORE on devnet.** The contract marks this as `[Unverified] ORE has no devnet deployment`. We will confirm by querying the ORE program account on devnet at M3. We expect no account; the ORE module on devnet will fall back to the last cached mainnet value.
6. **Seeker Genesis Token group on devnet.** The group `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te` is mainnet. On devnet, the SGT check is bypassed but `isSeeker` is forced to false unless a `SGT_OVERRIDE` env var is set for local testing.
7. **`@anchor-lang/core` 1.2.0 was found on npm but is not yet exercised.** The package is real per `npm view`, but we have not built code against it. If the API has shifted, M4 Anchor client code will need adjustments. Verifiable at M3 when we generate IDL bindings.
8. **openapi-generator 7.25.0 needs Java.** `which java` returned nothing in this environment. CI installs Java 21 (Temurin) before running `pnpm contract:check`. Recorded for follow-up.
9. **LiveKit server v1.13.7 binary.** Verified — downloaded from GitHub release, runs in `.runtime/livekit-server`. The HTTP API authenticates with a Bearer JWT minted by `livekit-server-sdk`, not Basic auth. (Initial attempt used Basic auth and failed with 401; switched to Bearer.)
10. **Anchor 1.2.0 does not exist.** Recorded in `DECISIONS.md`. We will re-check at M3 when the Anchor upgrade might have shipped.
11. **Solana CLI 4.1.2 not present.** Installed is 3.1.10. Latest 4.x stable is 4.3.0. We will install 4.3.0 at M3 if `anchor build` against `solana-program 5.x` is required.
12. **Docker Hub pull restrictions in this dev environment.** `minio/minio`, `minio/mc`, and `livekit/livekit` images cannot be pulled (registry returns 401). Workaround: download MinIO and LiveKit binaries from their GitHub releases and run as processes under `.runtime/`. The compose file still references the docker images so CI (which has unblocked Docker Hub) and the user's host (which presumably has the same restrictions lifted) work the standard way. Postgres and Redis pull fine.
13. **Compose port conflicts.** Existing containers `nairastock-postgres` (5433) and `nairastock-redis` (6380) plus unnamed `postgres` and `redis` containers on 5432/6379 meant the CT Life compose had to use 5434/6381. `.env` and `docker-compose.yml` are aligned.
14. **Helius SDK dropped at M2.** `helius-sdk@3.2.0` has an incompatible peer dep on `@solana/kit ^6.9` but we pin 8.4. Replaced with a thin fetch-based client in `server/shared/solana/helius.ts` that supports `getHealth`, generic `rpc()`, and `sgtMintsFor` (the SGT check via `getTokenAccountsByOwnerV2`). M3 webhook helpers (parsed transactions, signature verification, Enhanced Webhooks) will need either a `@solana/kit ^6.x` downgrade branch or a port. Recorded here so M3 picks it up.

## M3 and beyond (anticipated)

- Real ORE mainnet stake test (gated by `RUN_MAINNET_TESTS=1`).
- LiveKit voice round-trip with two real Seeker phones (manual, not automated).
- Push notifications on Seeker (requires Google Play services confirmation).
- X OAuth 2.0 PKCE (requires `X_CLIENT_ID` and `X_CLIENT_SECRET`).
- League promotion, Elo, and LLM filters will get adversarial tests at M7.
