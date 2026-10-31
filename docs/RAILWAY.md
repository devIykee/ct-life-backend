# Railway deployment — CT Life backend

This file describes how to deploy the CT Life backend to Railway.
The repo contains three processes that the backend runs:

| Service  | Entry point               | Dockerfile            | Default port |
| -------- | ------------------------- | --------------------- | ------------ |
| api      | `server/api/main.ts`      | `Dockerfile.api`      | 4010         |
| realtime | `server/realtime/main.ts` | `Dockerfile.realtime` | 2567         |
| workers  | `server/workers/main.ts`  | `Dockerfile.workers`  | 8080         |

The teammate (Unity client) deploys separately and points at the
Railway URLs.

## One-time setup

```bash
# 1. Auth (already done in the dev CLI as of M8 prep).
railway login

# 2. Create the project once.
railway init --name ctlife-backend
```

## Per-service provisioning

```bash
# Create each service and link it to the same repo. We use the
# multi-service deploy pattern: each service is a separate Railway
# service with its own Dockerfile and env.
railway add --name ctlife-api      --dockerfile Dockerfile.api
railway add --name ctlife-realtime --dockerfile Dockerfile.realtime
railway add --name ctlife-workers  --dockerfile Dockerfile.workers
```

Railway will give each service a URL like
`https://ctlife-api.up.railway.app`. Set `PUBLIC_API_URL`,
`PUBLIC_REALTIME_URL` to those values in the teammate's
configuration.

## Add-on services

Provision the managed services from the Railway dashboard or CLI:

- **Postgres** — Railway Postgres 16. Copy the connection string
  into `DATABASE_URL` for each of the three services.
- **Redis** — Railway Redis 7. Copy the connection string into
  `REDIS_URL`.

## Environment variables

Each service must define the env vars listed in `.env.example`. The
critical ones are:

- `APP_ENV=staging` (or `prod`)
- `NODE_ENV=production`
- `DATABASE_URL` (Railway Postgres connection string)
- `REDIS_URL` (Railway Redis connection string)
- `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` (RS256 PEM, base64-encoded is
  fine via `openssl base64 -A < jwt-private.pem`)
- `HELIUS_API_KEY` (production tier key, not the dev one)
- `HELIUS_WEBHOOK_SECRET`
- `HELIUS_RPC_URL_DEVNET` / `HELIUS_RPC_URL_MAINNET`
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` /
  `LIVEKIT_WEBHOOK_SECRET`
- `TREASURY_PUBKEY_MAINNET` (the on-chain treasury)
- `SETTLE_AUTHORITY_KEYPAIR_MAINNET` (the on-chain escrow signer —
  base58 secret key as a single env var; never check in)
- `ADMIN_KEYPAIR_MAINNET`
- `S3_*` (Cloudflare R2 or AWS S3 for ad creative uploads)
- `SENTRY_DSN` (optional)
- `RAILWAY_TOKEN` (only needed for CI deploys)
- `ORE_READER_ENABLED=1` on `ctlife-api` (read-only mainnet ORE board;
  off answers `GET /v1/ore/board` with 503 and lists `ore_reader` as
  degraded in `/v1/config`)

`ctlife-workers` runs the market simulation: it ticks every live coin
and launches a house coin every `launchIntervalSec` from
`contract/config/market.json` while fewer than `maxActiveCoins` are
alive. Without the workers service the market stays empty.

The build **must hard-fail at startup** if `ENABLE_DEV_AUTH=true`
while `APP_ENV` is `staging` or `prod`. See the `Config` loader.

**Mainnet guard.** `APP_ENV=prod` selects the Solana mainnet cluster for
every on-chain feature (payments, paid calls, Factory launches, mints).
All three services refuse to boot on mainnet unless `ALLOW_MAINNET=1`
is also set. Keep `APP_ENV=staging` (devnet) until the mainnet legal
review is done.

**Capabilities.** Finished features merge dark. Each one turns on when
its name is added to `CAPABILITIES_ON` on `ctlife-api` (comma list, for
example `worldEvents,districtStandings`; names and the derived
`cabalInvites` are listed in `.env.example`). Empty means everything is
off. Add a name only after its PR has deployed; a route whose capability
is off answers `503 CAPABILITY_OFF`. Unknown names are ignored and
logged at boot. Changing the list needs a redeploy (it is read once).

## Web clients and platform rules (be-web)

Code lands dark: with none of these set, the API and realtime behave exactly as before
(no CORS headers, no browser can join, every platform gets the 1.0.0 floor and the full
`CAPABILITIES_ON`). Rollout, staging first:

1. **`WEB_ORIGINS`** on **both** `ctlife-api` and `ctlife-realtime`, e.g.
   `https://staging.play.ctlife.fun` on staging, `https://play.ctlife.fun` on prod (add
   `http://localhost:8080` on staging only if someone tests a local WebGL build against it).
   Exact origins, comma list, no `*` (the boot refuses a wildcard). This turns on REST CORS,
   lets those origins join Colyseus, and makes them valid SIWS domains.
2. **`CAPABILITIES_OFF_BY_PLATFORM`** on `ctlife-api`, _before_ the web build is public. It
   is the switch for the real-money question (casino, coin launches, paid calls, top-ups on
   web); the legal answer is not an engineering call. A conservative start:
   `{"web":["paidCalls","seasonPassPurchase","factory","creatorMode"]}`. Names are the
   `CAPABILITIES_ON` names; unknown ones are ignored and logged at boot.
3. **`MIN_CLIENT_VERSION_BY_PLATFORM`** on `ctlife-api` when a release must force an update,
   e.g. `{"android":"1.6.0","web":"1.6.0"}`. Web clients are told to reload; apps to update.
   Android builds that predate `X-Client-Platform` count as `android`.
4. **`LATEST_WEB_BUILD`** on `ctlife-api` after each web deploy (the build number the release
   script stamps), so running web clients offer a reload mid-session.
5. Check: `curl -si -H 'Origin: https://staging.play.ctlife.fun' -H 'X-Client-Platform: web'
https://<api>/v1/config` shows `access-control-allow-origin`, `clientPlatform: "web"` and the
   web `capabilities`; a preflight `curl -si -X OPTIONS -H 'Origin: ...' -H
'Access-Control-Request-Method: POST' https://<api>/v1/auth/verify` answers `204`.

All four are read once at boot (redeploy to change). `trustProxy` is already on in the API
(Railway's proxy), so `req.ip` is the client address for the login rate limits.

## Health and readiness

Each service exposes `/healthz` (liveness) and `/readyz` (readiness).
Railway uses the healthcheck path declared in `railway.json`
(`/healthz`). Readiness checks Postgres, Redis, Helius, and LiveKit
and is the one we wire into Railway's load balancer.

## Migrations

Migrations run automatically on api startup via `pnpm db:migrate`,
but we run them as a one-shot job before deploying the api/realtime
upgrades:

```bash
railway run --service ctlife-api pnpm db:migrate
```

`pnpm db:status` and `pnpm db:verify` are also wired up; CI runs
`pnpm db:verify` to assert the schema invariants.

## Rollback

```bash
# Re-deploy a previous commit.
railway up --service ctlife-api --commit <sha>
railway up --service ctlife-realtime --commit <sha>
railway up --service ctlife-workers --commit <sha>
```

The realtime process drains on shutdown (clients reconnect within
the 20 s window) and the workers process is idempotent on every
job. The api process is stateless.

## Cost

- Postgres: $5/mo (Hobby)
- Redis: $5/mo (Hobby)
- api: $5/mo (1 vCPU, 1 GB)
- realtime: $5/mo (1 vCPU, 1 GB, 2 replicas)
- workers: $5/mo (1 vCPU, 1 GB)
- Helius: $49/mo (Developer)
- LiveKit: $50/mo (Build)

Hard caps are configured on Helius, LiveKit, and Railway; the kill
switch `degraded.ledger_freeze` halts money writes when the spend
exceeds budget. See `docs/OPERATIONS.md` for the full list.

## Where to find logs / metrics

- `railway logs --service ctlife-api`
- `railway logs --service ctlife-realtime`
- `railway logs --service ctlife-workers`

Each service exposes `/metrics` in Prometheus text format
(`GET /v1/metrics`). Railway's metrics dashboard pulls from these.

## Devnet SOL drip (unlock WP-C)

`POST /v1/devnet/drip` sends 0.02 devnet SOL a day to a player's wallet from an **ops
treasury**: a throwaway devnet keypair that holds only devnet SOL and is used for nothing
else. To turn it on:

1. Make a fresh keypair on your own machine (`solana-keygen new -o drip.json`), fund its
   public address with devnet SOL (faucet.solana.com with GitHub sign-in, or `devnet-pow`).
   5 SOL covers about 250 drips.
2. Set `DEVNET_DRIP_KEYPAIR` on the **api** service to the file's contents in base58 (or
   mount the JSON file and give its path). Optional: `DEVNET_DRIP_LAMPORTS`,
   `DEVNET_DRIP_DAILY_CAP_LAMPORTS`.
3. Add `devnetDrip` to `CAPABILITIES_ON`.

The drip refuses to send unless the RPC's genesis hash is devnet's, keeps 0.01 SOL in the
treasury, and answers `503 CAPABILITY_OFF {reason: treasury_low}` when it needs a refill.
