# Security

> Threat model, authorization matrix per endpoint, secret handling, rate limits, anti-cheat assumptions, and known residual risks.

## Threat model

The game moves real money (USDC, SOL, SKR, ORE) for top-ups, cosmetics, tips, paid calls and ads. The game server is the trust boundary. Players, network and external dependencies are untrusted. Bots are part of the test system, not the attack surface.

### Who can attack what

| Attacker              | What they want                       | What can stop them                                                                               |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Impersonator          | Sign in as another user              | Ed25519 signature, SGT mint uniqueness, JWT with `sub` claim                                     |
| Free-loader           | Get Cash without paying              | Idempotency on signature, ledger invariants, payment verification                                |
| Money printer         | Mint Cash via the API                | Server-authoritative ledger, append-only, no `number` floats                                     |
| Faucet farmer         | Spam account creation to drain drops | Per-IP and global login-concurrency caps, `SERVER_BUSY`                                          |
| Impersonator on chat  | Spam, harass, scam                   | Block + report + profanity filter + admin moderation                                             |
| Replayer              | Replay a webhook to double-credit    | Idempotency on `(source, signature)`; replay returns the first response                          |
| Replayer on REST      | Replay a POST to duplicate           | `Idempotency-Key` header, 24 h Redis + Postgres cache                                            |
| Out-of-order tx       | Confirmed before `finalized`         | Confirm at `confirmed`, re-verify at `finalized`                                                 |
| Malicious room        | Take over a Colyseus room            | JWT verified in `onAuth`, sandboxed message handlers, rate limits per session                    |
| Bot net               | DDoS the API                         | Per-IP token bucket, `SERVER_BUSY` with `Retry-After`, CDN on shared reads                       |
| Insider (admin)       | Rug, ban, drain                      | Audit log for every admin action, separate admin role claim, two-person rule on key actions (M8) |
| Settle authority (us) | Cheat on time or split               | Audit log + reconciliation, public explorer link on every settlement, M8 external monitor        |
| Compromised dev key   | Sign anything                        | Env-only, never committed, gitleaks in CI, automatic rotation documented in `RUNBOOK.md`         |

## Authentication

- Sign In With Solana via MWA. No email login in v1.
- Ed25519 signature on a server-issued nonce (single-use, 5 min, Redis-backed per B6).
- RS256 JWT, 15 min access, 30 day refresh with rotation and revocation.
- Public key served at `/v1/auth/jwks`. Key rotation supported via `kid`.
- Seeker Genesis Token check via `getTokenAccountsByOwnerV2` against the group `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`. The specific token mint is stored so one phone cannot verify two accounts (`SGT_ALREADY_LINKED`).

### D4: SIWS Domain Placeholder **[SECURITY RISK]**

**Current values**: `SIWS_DOMAIN=ctlife.fun`, `SIWS_URI=https://ctlife.fun/`

⚠️ **WARNING**: These are placeholder values for a domain we do not control. This weakens phishing resistance because:
- The domain is owned by the team, so it cannot be registered by an attacker
- Users cannot verify domain ownership
- The SIWS message cannot be trusted to prove the correct service

**Required before production**:
1. Purchase and control a real domain (e.g., ctlife.app, ctlife.io)
2. Update SIWS_DOMAIN and SIWS_URI environment variables
3. Ensure domain matches the actual deployed service
4. Remove this warning

**Configured via**: Environment variables (never hardcoded)
- `SIWS_DOMAIN` - bare hostname
- `SIWS_URI` - absolute https URI


## Authorization matrix

| Endpoint                         | Anonymous | User (own) | User (other) | Admin                  |
| -------------------------------- | --------- | ---------- | ------------ | ---------------------- |
| `GET /v1/config`                 | yes       | yes        | yes          | yes                    |
| `GET /v1/ore/board`              | yes       | yes        | yes          | yes                    |
| `GET /v1/ads/live`               | yes       | yes        | yes          | yes                    |
| `POST /v1/auth/challenge`        | yes       | yes        | yes          | yes                    |
| `POST /v1/auth/verify`           | yes       | —          | —            | —                      |
| `POST /v1/characters`            | —         | yes        | —            | —                      |
| `GET /v1/me`                     | —         | yes        | —            | —                      |
| `GET /v1/users/{id}`             | —         | yes        | yes          | yes                    |
| `POST /v1/blocks/{userId}`       | —         | yes        | —            | —                      |
| `POST /v1/reports`               | —         | yes        | —            | —                      |
| `POST /v1/lottery/roll`          | —         | yes (once) | —            | —                      |
| `POST /v1/needs/actions`         | —         | yes        | —            | —                      |
| `POST /v1/careers/{id}/apply`    | —         | yes        | —            | —                      |
| `POST /v1/shifts`                | —         | yes        | —            | —                      |
| `POST /v1/shifts/{id}/complete`  | —         | yes        | —            | —                      |
| `GET /v1/leaderboards/{boardId}` | —         | yes        | yes          | yes                    |
| `GET /v1/payments/intents/{id}`  | —         | yes (own)  | —            | yes                    |
| `POST /v1/market/trades`         | —         | yes        | —            | —                      |
| `POST /v1/perps`                 | —         | yes        | —            | —                      |
| `POST /v1/alpha-calls`           | —         | yes        | —            | —                      |
| `POST /v1/tips`                  | —         | yes        | —            | —                      |
| `POST /v1/paid-calls`            | —         | yes        | —            | —                      |
| `POST /v1/dms/{userId}`          | —         | yes        | —            | —                      |
| `POST /v1/feed/posts`            | —         | yes        | —            | —                      |
| `POST /v1/push/register`         | —         | yes        | —            | —                      |
| `POST /v1/admin/*`               | —         | —          | —            | yes (admin role claim) |

Every route handler declares its auth policy in code. The contract validator fails CI if a route returns a different shape than `openapi.yaml`.

## Secrets

- All secrets are env vars. `commit only .env.example`.
- Treasury, settle authority and admin keys are loaded from env (or a secret store). Never in repo files.
- Devnet and mainnet keys are separate variables (`*_DEVNET` and `*_MAINNET`).
- `gitleaks` runs in CI on every push. The CI rule is `sk-ant-[A-Za-z0-9_-]{20,}` plus Solana keypair base58 detection plus PEM private keys plus generic AWS-style keys.

## Rate limits (enforced in `server/shared/rate-limit/`)

| Scope                                    | Limit                            | Error                          |
| ---------------------------------------- | -------------------------------- | ------------------------------ |
| REST, per user                           | 20 req/s, token bucket           | `RATE_LIMITED`                 |
| REST, per IP, login                      | 5 in 60 s                        | `RATE_LIMITED`                 |
| REST, per IP, account/character creation | 3 in 60 s                        | `RATE_LIMITED`                 |
| Global login concurrency                 | 200 in flight                    | `SERVER_BUSY` + `Retry-After`  |
| Move                                     | 10/s                             | `rejected` with `RATE_LIMITED` |
| Say                                      | 1 per 2 s                        | `rejected` with `RATE_LIMITED` |
| Emote                                    | 1/s                              | `rejected` with `RATE_LIMITED` |
| Webhook ingest                           | unlimited per source, idempotent | n/a                            |

## Anti-cheat assumptions

- The client is fully untrusted. All positions, prices, scores, and amounts are server-validated.
- The server clock is authoritative; clients correct via `serverNow` from the realtime `welcome` message.
- Cash math uses `bigint` cents. No `number` floats. No `Number.parseFloat` of money strings.
- All market state is server-derived. Clients never set the price; they submit trades, the engine fills.
- NPC brains run on the server; clients only animate.
- Block / report actions are server-side. The chat filter is server-side.

## Idempotency

- `Idempotency-Key` header on every POST/PUT/PATCH/DELETE.
- Key stored in Redis + Postgres for 24 h. Same key replays the first response and status.
- Same key with a different body hash returns `VALIDATION_FAILED`.
- Concurrent requests with the same key are serialized to prevent double-execute.
- Payment crediting is idempotent on `(source, signature)` via a `UNIQUE` index.

## Known residual risks

1. **Trusted settle authority.** The backend's settle authority can settle paid calls for any duration. The mitigation is the audit log + public on-chain transactions + the external monitor (M8).
2. **Web faucet reliance.** Devnet airdrops are rate-limited per IP. Production does not rely on airdrops; the issue is dev only.
3. **Helius SGT result is cached briefly.** If a user sells their SGT, the cache may briefly show them as a Seeker. The cache TTL is short and the result is best-effort.
4. **LiveKit plan limits.** The Build plan caps at 100 concurrent participants. If we exceed that, voice fails soft. Documented in `docs/CAPACITY.md`.
5. **Mainnet ORE.** Even on staging, ORE flows hit mainnet. We never send without `RUN_MAINNET_TESTS=1` or a manual approval.
6. **Push notifications.** Unverified until Seeker Google Play services is confirmed. The in-app inbox is the default path.
7. **Mempool-based sandwiching.** Out of scope; the game's tokens (USDC, SOL, SKR) are mainstream and Slippage is bounded by `maxSlippageBps`.

## See also

- `docs/OPERATIONS.md` and `docs/RUNBOOK.md` — incident playbooks.
- `docs/ARCHITECTURE.md` — auth sequence diagram.
- `docs/REALTIME.md` — chat filter and rate limits.
- `docs/ONCHAIN.md` — payment verification algorithm.
