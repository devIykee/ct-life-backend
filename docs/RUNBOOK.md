# Runbook

> Step-by-step incident playbooks. The design is in `OPERATIONS.md`; this file is what you read at 3 a.m.

## Health and readiness

- `GET /healthz` — liveness. Returns 200 if the process is up. Cheap, no DB.
- `GET /readyz` — readiness. Pings Postgres, Redis, Helius, LiveKit. Returns 200 only if all dependencies are reachable. Used by Railway for traffic routing.

## Ledger mismatch

**Symptom:** the nightly reconciliation job reports `sum(delta_cents) != balances.cash_cents` for one or more users, or `Cash totals drift alert` fires.

1. **Freeze writes.** Set the kill switch `degraded.ledger_freeze = "true"` via `GET /v1/config`'s `degraded` field. New payments are accepted but no ledger writes are committed.
2. **Identify the bad user.** Read the reconciliation report. Note the user ID and the diff.
3. **Inspect the ledger.** `SELECT * FROM ledger_entries WHERE user_id = ? ORDER BY created_at`. Look for: missing entries (a transaction committed in code but the row is gone — corruption), duplicate entries (a webhook fired twice), or an out-of-range delta.
4. **Compare with the on-chain receipts.** For payment intents, join `payment_intents.signature` to the on-chain transaction and reconcile.
5. **Repair.** Two options:
   - Insert a compensating ledger entry with `reason = 'reconciliation_adjustment'`. Use sparingly.
   - Restore the database to the last known good snapshot, replay webhooks from the Helius dashboard.
6. **Audit log.** Open a ticket, document the cause, the fix, the diff.
7. **Unfreeze.** `degraded.ledger_freeze = "false"`.

## Stuck paid call

**Symptom:** a paid call session is in `live` for longer than `max_minutes + 5 min`, the LiveKit room has been empty, the LiveKit `room_finished` webhook never arrived.

1. Identify the call: `SELECT * FROM paid_calls WHERE call_id = ?`.
2. Check the LiveKit room status via the LiveKit HTTP API.
3. If the room is empty: trigger `refund` from the backend. The backend has a periodic job that calls `refund` on any session where `max_minutes + 600 s` have passed since `opened_at` and the room is empty.
4. If the room is not empty: ask the participants to disconnect, then trigger `refund` after the grace period.
5. If the backend never settles: the fan can call `refund` directly after the expiry.

## Helius outage

**Symptom:** `getTokenAccountsByOwnerV2` or webhook delivery is slow / failing.

1. The Helius client is a token bucket with a circuit breaker. Check the metrics: `helius_circuit_state` and `helius_credit_burn`.
2. **Login still works** if the SGT check times out — the result is best-effort. `isSeeker` is `false` and the badge is verified asynchronously when Helius recovers.
3. Webhook handling: webhooks are idempotent. Missed webhooks are caught by the polling reconciler that runs every N seconds.
4. If Helius is fully down for > 30 min, set `degraded.helius = "down"` so the client UI shows a banner. The game continues; the badge is delayed.

## Price feed outage

**Symptom:** Pyth Hermes or Jupiter is down or stale.

1. The price feed is stale-while-revalidate. If a quote is older than 60 s, new payment intents return `503 PRICE_FEED_DOWN`. Existing intents continue; they have a locked quote.
2. The market engine falls back to the last cached price for the mood calculation; this is documented and a kill switch exists.
3. If the outage is > 30 min, set `degraded.price_feed = "down"`.

## Redis loss

**Symptom:** Redis is unreachable.

1. **Money is safe.** No ledger data is in Redis.
2. **Presence is lost** — Colyseus room presence evaporates; clients reconnect to a fresh process.
3. **Rate limits are reset.** This is a brief vulnerability window; consider setting `degraded.rate_limit = "down"` and `degraded.login = "ip-only"` to switch to IP-only limits.
4. **Boards are reset** — they rebuild on the next read.

## DB failover

**Symptom:** the primary Postgres is unhealthy; Railway promotes a replica.

1. The api/realtime/workers reconnect to the new primary via PgBouncer. The `DATABASE_URL` is unchanged.
2. In-flight transactions retry. Idempotency on payment signatures ensures no double-credit.
3. If a process is stuck on the old primary, restart it.

## Realtime process kill

**Symptom:** a realtime process is killed (OOM, deploy, host loss).

1. **Clients reconnect within 20 s** to a different process. The reconnection token is verified, state is restored from the room snapshot.
2. **No data loss** — room state is reconstructable from Postgres + Redis presence.
3. **Investigate:** OOM, segfault, panic? Check `docker logs`, the Node process dump, the OS dmesg.

## Market leader kill

**Symptom:** the BullMQ process running the market leader is killed.

1. The lock is released via a TTL (60 s).
2. Another worker takes the lock and resumes from the last persisted tick state. The deterministic seed replays the gap.
3. No double ticks, no lost trades. Verify with the deterministic tape output: every coin's tape is identical to a clean run with the same seed.

## Secret leak

**Symptom:** a secret was committed or printed in logs.

1. **Rotate immediately.** Generate a new key, update env, redeploy.
2. **Audit log.** Find the leaked secret in git history. `gitleaks` should have caught it; if not, the rule is wrong — fix it.
3. **Re-run all signed requests.** JWTs become invalid (rotation, new `kid`).
4. **Notify.** If the leak is a treasury or settle authority key, treat it as a P0: move funds on chain.

## See also

- `docs/OPERATIONS.md` — deploy, rollback, key rotation.
- `docs/SECURITY.md` — secret handling and threat model.
- `docs/ARCHITECTURE.md` — process boundaries.
