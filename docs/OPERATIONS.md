# Operations

> Deploy, rollback, migrations, key rotation, webhook setup, metrics and alerts, backup and restore.

This is the design document. The step-by-step incident runbook is in `RUNBOOK.md`.

## Deploy

The backend is a TypeScript monorepo with four deployable processes (api, realtime, workers) and the Anchor program. Staging and prod run on Railway.

- `server/api` — Dockerfile, port 4010, healthcheck at `/healthz`, readiness at `/readyz`.
- `server/realtime` — Dockerfile, port 2567.
- `server/workers` — no HTTP port; talks via Redis. Healthcheck via a Redis "I'm alive" key with a 5 s TTL.
- `programs/ct_escrow` — Anchor program, deployed via `anchor deploy` after `anchor build`.

### Railway

Each process is a separate Railway service. The same Dockerfile is used; the entrypoint differs per service.

- `api`: `node --enable-source-maps server/api/dist/main.js`
- `realtime`: `node --enable-source-maps server/realtime/dist/main.js`
- `workers`: `node --enable-source-maps server/workers/dist/main.js`

### Migrations

Expand / contract pattern. Each migration is backward compatible with the previous release.

1. **Expand.** Add new columns / tables / indexes.
2. **Deploy the code that writes the new shape.**
3. **Backfill** if needed.
4. **Contract.** Drop the old shape in a later release.

No destructive change in the same release as the code change. No long table locks. `statement_timeout` and `lock_timeout` are set on every transaction.

## Rollback

- API: rolling deploys. A new release rolls out behind a healthcheck; bad releases auto-roll back.
- Realtime: drain on shutdown. Stop accepting new rooms, let clients reconnect within the 20 s window to another process.
- Workers: idempotent jobs. A failed worker is replaced; the BullMQ queue re-enqueues.
- Migrations: never destructive in the same release. To roll back a feature, deploy the previous version; the migration is forward-only.

## Key rotation

| Key                 | Rotation cadence                        | How                                                                                                                            |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| JWT signing (RS256) | quarterly                               | Add a new key alongside the old. Publish both in JWKS. Old key is removed after clients have rolled over. `kid` distinguishes. |
| Settle authority    | annually or on suspected compromise     | Deploy a new `init_config` on `ct_escrow` with the new authority. Migrate in-flight sessions.                                  |
| Treasury            | rarely; on-chain rotation is a UX event | New treasury pubkey in `TREASURY_PUBKEY_MAINNET`. Bots point at the new wallet.                                                |
| Admin               | rarely                                  | `ADMIN_KEYPAIR_*` env update + redeploy.                                                                                       |
| Helius API key      | on plan change                          | Update `HELIUS_API_KEY`. The webhook secret is independent.                                                                    |
| LiveKit             | on plan change                          | Update `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`.                                                                               |
| S3                  | on credential leak                      | New access key, deploy, drop the old.                                                                                          |

## Webhook setup

- Helius: configured in the Helius dashboard. The webhook URL is `https://<api-host>/v1/webhooks/helius`. The secret is `HELIUS_WEBHOOK_SECRET`. The handler verifies the HMAC, enqueues to BullMQ and returns `200` immediately. Processing is async.
- LiveKit: configured in the LiveKit dashboard. The webhook URL is `https://<api-host>/v1/webhooks/livekit`. The secret is `LIVEKIT_WEBHOOK_SECRET`. The handler verifies the JWT, enqueues, returns `200`.
- ORE: read-only via the ORE program accounts; no webhooks from ORE. We poll every 2 s.

## Metrics and alerts

`pino` for structured logs, `/healthz` and `/readyz` for liveness/readiness, Prometheus metrics at `/metrics`:

- `http_request_duration_seconds` — request latency by route, method, status.
- `http_requests_in_flight` — concurrent requests.
- `ledger_tx_retries_total` — ledger transactions that retried on serialization failure.
- `room_count` — active Colyseus rooms by name.
- `room_tick_lag_seconds` — game loop lag per room.
- `webhook_lag_seconds` — time between webhook received and processed.
- `event_loop_lag_seconds` — Node event-loop lag.
- `db_pool_wait_seconds` — Postgres pool wait.
- `redis_latency_seconds` — Redis command latency.
- `price_feed_staleness_seconds` — quote age.

Alerts (configurable in Railway):

| Alert                               | Threshold                 |
| ----------------------------------- | ------------------------- |
| p99 REST latency > 500 ms for 5 min | page                      |
| `room_tick_lag > 1 s` for 1 min     | warn                      |
| `webhook_lag > 30 s`                | page                      |
| `db_pool_wait > 200 ms` for 1 min   | warn                      |
| `event_loop_lag > 100 ms` for 30 s  | page                      |
| `price_feed_staleness > 60 s`       | page                      |
| LiveKit participant-min burn > plan | warn + auto-disable voice |
| Helius credit burn > plan           | warn + auto-throttle      |

## Backup and restore

- Postgres: automated daily snapshot + 7-day PITR via Railway. Restore is rehearsed monthly and the procedure is in `RUNBOOK.md`.
- Redis: AOF persistence, snapshot every 5 min. Redis is not the source of truth for money; loss is acceptable, presence will be lost.
- S3: bucket versioning enabled. Old versions are kept for 30 days.
- Solflare / Helius: not backed up by us; the chain is the source of truth.

## Cost safety

- LiveKit participant-minutes budget is a kill switch (`degraded.voice = "plan-cap"`).
- Helius credit budget is a token bucket; the API client throttles.
- Railway spend is monitored with a hard cap; over-cap deploys fail.

## See also

- `docs/RUNBOOK.md` — incident playbooks.
- `docs/ARCHITECTURE.md` — deployment topology.
- `docs/SECURITY.md` — secret handling.
