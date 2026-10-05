# Unverified

> Claims in the spec or in this repo that we cannot verify in the current environment, with what would be needed to verify them. Anything in this list is a risk the team has agreed to ship with.

## M0

1. **Helius API key is missing from the environment.** We cannot run the M0 smoke (`getHealth`) or any M3 payment verification without it. Need: `HELIUS_API_KEY`.
2. **LiveKit credentials are missing.** We cannot run the M0 smoke (token mint + room create/delete) without them. Need: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. The LiveKit dev server is bundled in `docker-compose.yml`, but the SDK still needs API credentials to mint tokens.
3. **Solana devnet airdrop smoke is unverified.** `solana airdrop` is rate-limited and often returns `429`; in that case the test will retry with a small amount. If airdrop fails repeatedly, fund the devnet wallet from a faucet or pre-load it with SOL. Need: a funded `SETTLE_AUTHORITY_KEYPAIR_DEVNET` or `ADMIN_KEYPAIR_DEVNET` on devnet, plus `SOLANA_RPC_URL_DEVNET`.
4. **SKR devnet mint.** The contract says "if no devnet mint, SKR payments are enabled only when `APP_ENV=prod`". We will check this on devnet at M3 by querying `getAccountInfo` for the SKR mint. If it is missing on devnet, the SKR currency handler refuses to start and the SKR top-up SKU is hidden.
5. **ORE on devnet.** The contract marks this as `[Unverified] ORE has no devnet deployment`. We will confirm by querying the ORE program account on devnet at M3. We expect no account; the ORE module on devnet is a stub that returns the last cached mainnet value.
6. **Seeker Genesis Token group on devnet.** The group `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te` is mainnet. On devnet, the SGT check is bypassed but `isSeeker` is forced to false unless a `SGT_OVERRIDE` env var is set for local testing.
7. **`@anchor-lang/core` 1.2.0 was found on npm but is not yet exercised.** The package is real per `npm view`, but we have not built code against it. If the API has shifted, M4 Anchor client code will need adjustments. Verifiable at M3 when we generate IDL bindings.
8. **openapi-generator 7.25.0 needs Java.** `which java` returned nothing in this environment. CI must either install Java or use the Docker image `openapitools/openapi-generator-cli:v7.25.0`. Recorded for follow-up.
9. **LiveKit server v1.13.7 binary.** The release tag is real on GitHub but we have not pulled and started it locally. Verifiable when credentials arrive.
10. **Anchor 1.2.0 does not exist.** Recorded in `DECISIONS.md`. We will re-check at M3 when the Anchor upgrade might have shipped.
11. **Solana CLI 4.1.2 not present.** Installed is 3.1.10. Latest 4.x stable is 4.3.0. We will install 4.3.0 at M3 if `anchor build` against `solana-program 5.x` is required.

## M3 and beyond (anticipated)

- Real ORE mainnet stake test (gated by `RUN_MAINNET_TESTS=1`).
- LiveKit voice round-trip with two real Seeker phones (manual, not automated).
- Push notifications on Seeker (requires Google Play services confirmation).
- X OAuth 2.0 PKCE (requires `X_CLIENT_ID` and `X_CLIENT_SECRET`).
- League promotion, Elo, and LLM filters will get adversarial tests at M7.
