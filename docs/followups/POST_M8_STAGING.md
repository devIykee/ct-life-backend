# CT Life backend: post-M8 follow-up prompt

This prompt picks up the work that **could not be completed in the
local dev environment**. M0..M8 have shipped; the dev gate is green;
this is the staging-and-mainnet work that needs real credentials
and a Railway project to run.

## TL;DR — what is and isn't done

| Work item                                               | Local    | Staging  | Mainnet  |
| ------------------------------------------------------- | -------- | -------- | -------- |
| M0..M8 code (api/realtime/workers, db, contract)        | DONE     | DONE     | DONE     |
| Static gate (typecheck/lint/format/docs/boundary)       | DONE     | n/a      | n/a      |
| Unit + integration + chaos tests                        | DONE     | n/a      | n/a      |
| Fuzz harness + authz matrix                             | DONE     | n/a      | n/a      |
| 200-bot staged ramp                                     | DONE     | n/a      | n/a      |
| **1k + 5k + 20k staged ramp**                           | TODO     | TODO     | n/a      |
| **Spike test (0 → 2k logins / 60 s)**                   | TODO     | TODO     | n/a      |
| **Soak (1 h at 50% of measured ceiling)**               | TODO     | TODO     | n/a      |
| **Dependency failure tests** (Helius/LK/Redis/PG)       | TODO     | TODO     | n/a      |
| **Real Railway deploy**                                 | partial  | TODO     | TODO     |
| **Mainnet ORE stake transaction** (RUN_MAINNET_TESTS=1) | n/a      | n/a      | TODO     |
| **Push notifications on Seeker**                        | flag-off | flag-off | flag-off |
| **X OAuth end-to-end**                                  | flag-off | flag-off | flag-off |

## Read first

1. `docs/MASTER_PROMPT` — the source of truth.
2. `docs/PROGRESS.md` — every milestone's status, last command, blockers.
3. `docs/HANDOVER.md` — env URLs, dev token flow, mock profile,
   known limitations.
4. `docs/RAILWAY.md` — Railway-specific deploy guide.
5. `docs/UNVERIFIED.md` — every gap, with workaround.

## Re-run the dev gate as a smoke check

```bash
pnpm install
pnpm dev:up
pnpm db:migrate
pnpm smoke                 # 7/7 required checks
pnpm typecheck             # 0 errors
pnpm lint                  # 0 errors
pnpm format:check          # clean
pnpm docs:check            # OK
pnpm boundary:check        # layering OK
pnpm contract:check        # all green
pnpm test:unit             # 298/298
pnpm db:verify             # 143/143
```

All of these should already be green. If any fails, fix it
before moving to staging work.

## Staging work to complete

### 1. Provision the Railway project

```bash
railway login                          # already authenticated as eokorie1911@gmail.com
railway init --name ctlife-backend     # one-time
railway add --name ctlife-api      --dockerfile Dockerfile.api
railway add --name ctlife-realtime --dockerfile Dockerfile.realtime
railway add --name ctlife-workers  --dockerfile Dockerfile.workers
railway add --name ctlife-postgres  # managed Postgres 16
railway add --name ctlife-redis     # managed Redis 7
```

Copy `DATABASE_URL` and `REDIS_URL` from the managed services into
each of `ctlife-api`, `ctlife-realtime`, `ctlife-workers`.

Provision production-tier env vars per `docs/RAILWAY.md`:

- `APP_ENV=staging`
- `NODE_ENV=production`
- `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (RS256, base64-encoded is fine)
- `HELIUS_API_KEY` (production key — not the dev one)
- `HELIUS_WEBHOOK_SECRET`
- `HELIUS_RPC_URL_DEVNET` / `HELIUS_RPC_URL_MAINNET`
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` /
  `LIVEKIT_WEBHOOK_SECRET`
- `TREASURY_PUBKEY_MAINNET`
- `SETTLE_AUTHORITY_KEYPAIR_MAINNET` (base58, never check in)
- `ADMIN_KEYPAIR_MAINNET`
- `S3_*` (R2 or S3 for ad creative uploads)

### 2. First staging deploy

```bash
railway up --service ctlife-workers
railway up --service ctlife-api
railway up --service ctlife-realtime
railway run --service ctlife-api pnpm db:migrate
```

Verify `/healthz` and `/readyz` on each service URL. Confirm
`degraded` field in `GET /v1/config` is empty.

### 3. Staged ramp to 5,000 bots (master prompt M8)

The 200-bot ramp is already measured (`docs/CAPACITY.md`). Run the
same harness from a separate machine (not the server host) at
1,000 then 5,000:

```bash
# On the load host, NOT on Railway.
ENABLE_DEV_AUTH=true \
  pnpm exec tsx tools/load/staged-ramp.ts \
    --api https://<your-api>.up.railway.app \
    --bots 1000 --duration 120 --concurrency 64

ENABLE_DEV_AUTH=true \
  pnpm exec tsx tools/load/staged-ramp.ts \
    --api https://<your-api>.up.railway.app \
    --bots 5000 --duration 300 --concurrency 128
```

Append each run to `docs/CAPACITY.md`. The first bottleneck,
predicted p95, and the error rate per scale are the output.

### 4. Spike test (master prompt M8)

0 → 2,000 logins in 60 s. Expected result: `SERVER_BUSY` for the
overflow, no crashes, no ledger errors, recovery to normal latency
within a defined time.

The staged-ramp harness can be wrapped in a "spike" mode (start
all 2,000 bots at once instead of staggering). Add a `--spike` flag
to `tools/load/staged-ramp.ts`:

```bash
ENABLE_DEV_AUTH=true \
  pnpm exec tsx tools/load/staged-ramp.ts \
    --api https://<your-api>.up.railway.app \
    --bots 2000 --duration 60 --concurrency 1 --spike
```

### 5. Soak (master prompt M8)

1 hour at 50% of the measured ceiling. The harness has no soak
mode; add `--mode soak` that loops the bots for the full duration
and reports memory growth and connection-pool wait:

```bash
ENABLE_DEV_AUTH=true \
  pnpm exec tsx tools/load/staged-ramp.ts \
    --api https://<your-api>.up.railway.app \
    --bots 2500 --duration 3600 --concurrency 32 --mode soak
```

Record the result in `docs/CAPACITY.md` under "Soak".

### 6. Dependency failure tests

Kill each external dependency in turn and verify the game
degrades, not crashes:

- **Helius down.** Add an iptables rule (or a custom proxy that
  503s) on the API host. Run a 50-bot ramp for 60 s. Assert: 0
  5xx, login still works (isSeeker defaults to false on Helius
  failure), payments queue up and reconcile on recovery.
- **LiveKit down.** Same pattern. Voice fails soft; the game loop
  continues.
- **Redis down.** The presence/boards collapse; clients
  reconnect. Assert the ledger is intact (`sum(ledger.delta_cents)
== balances.cash_cents`).
- **Postgres failover.** Trigger a Railway Postgres failover
  mid-ramp. Api/workers reconnect via DATABASE_URL; in-flight
  transactions retry; idempotency prevents double-credit.

### 7. Kill tests

- Kill one `ctlife-realtime` replica under load. Clients
  reconnect within 20 s (Colyseus reconnection token verified).
- Kill one `ctlife-api` replica under load. The remaining
  replicas absorb the load; p95 latency may briefly rise but
  there must be no ledger or auth gaps.
- Kill the `ctlife-workers` replica mid-tick. The BullMQ
  repeat-job lock TTL expires; another replica resumes from the
  last persisted tick state.
- Restart Redis. The leaderboards rebuild from Postgres on the
  next read; rate limits reset (acceptable).

### 8. Real mainnet ORE stake

`server/application/refinery.ts` builds the unsigned v0
transaction from the Rust `ore-stake-api` reference. To exercise
the real flow:

```bash
RUN_MAINNET_TESTS=1 pnpm test:unit --grep "ore"
```

This runs the stake transaction simulation against mainnet via
`simulateTransaction` (no send). For a real tiny stake, fund a
test wallet with 0.001 ORE on mainnet and call the devnet-signed
`POST /v1/ore/stake/tx` with that wallet.

### 9. Push notifications

Default off. To enable: confirm Seeker Play services are
operational, set `PUSH_ENABLED=true`, deploy, register a test
device via `POST /v1/push/register`. The sender is in
`server/application/push.ts`.

### 10. X OAuth end-to-end

Set `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`,
`X_LINK_ENABLED=true`, deploy. Run the OAuth 2.0 PKCE flow from a
test app; verify the access + refresh tokens round-trip
(`POST /v1/x-link/start`, `POST /v1/x-link/callback`).

### 11. Final handover update

Once all of the above has run, update `docs/HANDOVER.md` with
real staging URLs and replace the "TODO" entries in this prompt's
matrix with measured values from `docs/CAPACITY.md`. Update
`docs/UNVERIFIED.md` to remove items that have been resolved.

If a contract change was needed (none expected), tag
`contract-v1.0.0-rc2` and notify the teammate.

## Reporting

At the end, append to `docs/TEST_REPORT.md` a section with:

1. The real Railway URLs.
2. The 1k/5k/20k ramp measurements (p50/p95/p99, rps, error rate,
   first bottleneck).
3. The spike test result.
4. The soak result (memory growth, connection-pool wait).
5. Each dependency-failure test (which provider, what degraded,
   recovery time).
6. Each kill test (which process, recovery time, ledger
   invariant assertions).
7. Any new `docs/adr/` entries made.
8. A final closing note: the codebase is in production-ready
   shape on staging + mainnet.

## Constraints

- Do not invent capacity numbers. Measure them. Update
  `docs/CAPACITY.md` from real output, not from the spec.
- Do not put a mainnet signing key in a file in the repo. Use
  Railway secrets (or env vars).
- Do not skip the cheap rules (multi-process realtime, market
  leader failover, sharded rooms). They are part of M3 already;
  staging must prove they hold up under load.
- Commit at the end of every milestone step with a clear
  message.
- Append to `docs/PROGRESS.md` so the next session can resume
  from `PROGRESS.md` alone.
