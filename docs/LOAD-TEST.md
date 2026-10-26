# Load test: 100-300 players (private test readiness)

> Backlog item 43. What we ran, what broke first, what we fixed, and how to size Railway for
> ~100 private testers. Measured 2026-10-25 on a dev Mac (see "Caveats"). Re-run with
> `tools/load/run.sh` after any change to a hot path.

## What a "player" does

Each simulated player is one REST session (k6) plus one realtime client (Node, real
`@colyseus/sdk`), started together and climbing the same staircase: 1/3, 2/3, then all of `PEAK`
players, each plateau reached over 60 s and held for `HOLD_S`.

**REST** (`tools/load/k6/rest-players.js`, k6): sign up like a new install (`POST /v1/auth/dev`,
lottery roll, character, then `GET /v1/me` and `GET /v1/config`), then loop a play session with
real think time (about 30 s per loop): quests, daily streak status and claim, casino state and 1-3
slot spins (inside the 2/s per-player limit), shop catalogue and owned items, sometimes one shop
order, and claiming finished quests. About 0.25 requests/s per player.

**Realtime** (`tools/load/street-players.ts`): joins `city`, `market` and `vehicles` and the
`street` room of its district, as the Unity client does (`Net/Realtime/IslandChannels.cs`,
`World/Island/StreetNetworkBridge.cs`). It sends `move` at the client's real rate: every frame,
throttled to one per 0.1 s by `StreetChannel.Move`, so a steady **10 Hz per player, even when
standing still**. Bots walk at 4 m/s inside their district polygon (the server's own geometry
code). 60% of players are downtown (`timeline`), the rest spread over the other districts
(`HOT=1` puts everyone in one district).

Measured: per-endpoint p50/p95/p99, 5xx, pool waiters, event-loop delay (new `/metrics` gauges on
the API and realtime processes), Postgres top queries (`pg_stat_statements`), process CPU and
RSS, room join latency, **move-to-visible** latency (time from sending a move to seeing your own
new position in a state patch) and downstream bytes per player.

## How to run

```bash
brew install k6                 # k6 v2.x (https://grafana.com/docs/k6/latest/set-up/install-k6/)
# A throwaway Postgres with pg_stat_statements (never production: the run resets the stats).
docker run -d --name ctlife-pg-load -p 5436:5432 --cpus 2 --memory 2g \
  -e POSTGRES_USER=ctlife -e POSTGRES_PASSWORD=ctlife -e POSTGRES_DB=ctlife_load \
  postgres:16-alpine -c shared_preload_libraries=pg_stat_statements
DATABASE_URL=postgres://ctlife:ctlife@localhost:5436/ctlife_load pnpm db:migrate:env
# Start api, realtime and workers against it with ENABLE_DEV_AUTH=true, then:
API=http://localhost:4010 WS=ws://localhost:2567 PEAK=300 HOLD_S=120 \
  PG_URL=postgres://ctlife:ctlife@localhost:5436/ctlife_load OUT=./load-results tools/load/run.sh
```

`OUT` gets `rest.json` (k6 summary), `street.json` (realtime, per plateau), `metrics.json`
(worst event-loop delay, pool waiters, memory) and `pg-top.txt`. `THINK=0.25` makes every player
4x busier; `HOT=1` is the everyone-downtown case. Dev auth must be on, so this never runs against
production; on staging, set `ENABLE_DEV_AUTH=true` there for the run only.

## Results

Same run both times: `PEAK=300`, `HOLD_S=120`, fresh database, api + realtime + workers on the
host (`node --import tsx`, as in the Dockerfiles), Postgres 16 limited to 2 vCPU / 2 GB, Redis 7
limited to 1 vCPU.

### Before (main at 40019ce)

| Metric                             | Value                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| REST requests                      | 25,375 (42/s)                                               |
| REST latency p50 / p95 / p99       | 6 / **5,012** / 8,332 ms                                    |
| 5xx                                | **6.8%** of requests (1,071)                                |
| Postgres serialization failures    | 1,495 (`could not serialize access`), 20 statement timeouts |
| API pool waiters (max)             | **250** (`timeout exceeded when trying to connect`: 951)    |
| Realtime players connected at 300  | 279 (21 failed to sign in: 500s)                            |
| Move-to-visible p95 at 100/200/300 | 168 / 101 / 435 ms                                          |

Errors came in two bursts of about 100 s each (at 100 and at 300 players), with clean periods in
between, so the cause was not raw load.

### After (this PR)

| Metric                                 | Value                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| REST requests                          | 26,810 (45/s)                                                                              |
| REST latency p50 / p95 / p99           | 3 / **47** / 1,174 ms (whole run, client side)                                             |
| Server latency at 200 / 300 players    | p95 15 / 16 ms, p99 25 / 30 ms, max 118 / 104 ms, 0 errors                                 |
| 5xx                                    | **0.06%** (17), all in one 60 s stall in the first 2 minutes (below)                       |
| Postgres serialization failures        | 51, all retried successfully; 0 statement timeouts                                         |
| Realtime players connected at 300      | 299 of 300                                                                                 |
| Move-to-visible p95 at 100 / 200 / 300 | 166 / 100 / 99 ms (the 100 ms patch interval)                                              |
| Downstream per player                  | 6 / 14 / 12 KB/s at 100 / 200 / 300 players                                                |
| Realtime egress at 300 players         | 3.5 MB/s                                                                                   |
| CPU, average (max) of one core         | api 7% (12%), realtime 19% (33%), workers 0.2%, Postgres 13% (bursts to 2 cores), Redis 4% |
| RSS (max)                              | api 260 MB, realtime 274 MB, workers 115 MB                                                |

Per endpoint, k6 client side, p50 / p95 / p99 in ms:

| Endpoint                     | Before                | After              |
| ---------------------------- | --------------------- | ------------------ |
| `POST /v1/auth/dev`          | 9.1 / 5,010 / 9,058   | 8.9 / 89 / 567     |
| `POST /v1/lottery/roll`      | 6.6 / 344 / 451       | 6.6 / 60 / 538     |
| `POST /v1/characters`        | 5.9 / 64 / 236        | 6.0 / 55 / 359     |
| `GET /v1/me`                 | 8.4 / 7,750 / 9,976   | 4.7 / 61 / 968     |
| `GET /v1/config`             | 2.7 / 23 / 48         | 2.2 / 14 / 53      |
| `GET /v1/quests`             | 3.4 / 5,022 / 5,142   | 1.5 / 23 / 357     |
| `GET /v1/daily/status`       | 2.8 / 3,406 / 5,227   | 1.9 / 29 / 678     |
| `POST /v1/daily/claim`       | 9.1 / 30 / 86         | 8.0 / 226 / 7,944  |
| `GET /v1/casino/state`       | 4.7 / 5,021 / 5,693   | 3.3 / 44 / 1,259   |
| `POST /v1/casino/slots/spin` | 14.3 / 5,024 / 14,743 | 11.5 / 122 / 2,546 |
| `GET /v1/shop/catalog`       | 1.7 / 1,743 / 5,027   | 1.4 / 25 / 491     |
| `GET /v1/me/items`           | 2.0 / 2,435 / 5,036   | 1.6 / 25 / 662     |
| `POST /v1/shop/orders`       | 6.2 / 1,098 / 6,487   | 5.3 / 44 / 3,068   |

The p99 tails in "after" all come from the one stall in the first two minutes (most daily claims
and first orders happen then). With the process warm (the 200 and 300 plateaus) no endpoint went
over 120 ms on the server.

## Bottlenecks found

1. **SERIALIZABLE predicate-lock storm in the casino (fixed).** Every casino bet ran SERIALIZABLE and
   read ranges: today's casino ledger rows (stake and loss caps) and the session's rounds (up to
   500). Postgres keeps SSI read locks per tuple, but promotes them to page locks after 2 tuples on
   a page and to a **relation** lock after 32 pages (`max_pred_locks_per_page`,
   `max_pred_locks_per_relation`). A player's ledger rows are spread over many pages, so after a
   few dozen spins each bet held a relation-wide read lock on `ledger_entries` and
   `casino_rounds`. Every other SERIALIZABLE writer then conflicted with it: bursts of hundreds of
   `could not serialize access` errors. Each retry held a pooled connection through a sleep, the
   20-connection pool drained, and unrelated reads (`GET /v1/quests`, `/v1/me`) failed after 5 s
   waiting for a connection.
   **Fix:** the single-player casino transactions (slots, coinflip vs the house, crash bet and
   cash-out, the crash reaper) run at READ COMMITTED. They already take `casino_players ... FOR
UPDATE` first ("serializes a player's bets and keeps the caps race-free"), and the balance check
   is under `balances ... FOR UPDATE`, so SSI added nothing but the predicate locks. A new test
   fires six concurrent spins against the stake cap and checks exactly two pass. Head-to-head
   challenges stay SERIALIZABLE.
2. **Retry backoff held the connection (fixed).** `runInTransaction` slept between serialization
   retries while still holding its pooled client. It now releases first.
3. **Two to four wasted round trips per transaction and connection (fixed).** Every transaction sent
   `BEGIN`, `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE` and a session-level
   `SET statement_timeout` (which also leaked a custom timeout onto the pooled connection). Now one
   `BEGIN ISOLATION LEVEL ...`, plus a `SET LOCAL` only for a non-default timeout. New connections
   get `statement_timeout` and `lock_timeout` as startup parameters instead of two un-awaited
   `SET`s (which raced the first query; pg 8.x warns about that).
4. **Duplicate query on sign-in (fixed).** `POST /v1/auth/dev` and `/v1/auth/verify` looked up the
   character twice; the route now uses the service's answer.
5. **Realtime `/healthz` threw on every probe (fixed).** The health handler and Colyseus both
   answered the same request (`ERR_HTTP_HEADERS_SENT` per probe). The ops paths (`/healthz`,
   `/readyz`, and a new `/metrics`) now sit in front of Colyseus.
6. **Not a bottleneck:** query time. Postgres spent about 16 s of execution in total over the
   10-minute "after" run (top: ledger inserts, 0.4 ms mean). No missing index showed up; the
   per-player reads all use `(user_id, created_at)` indexes. Pool size 20 per process was enough
   once the storm was gone (waiters average 0.4).

### Still open

- **One ~60 s stall in the first two minutes of both runs** (17 pool timeouts in "after"; API
  event-loop delay up to 0.8 s while the API used 7% CPU, transactions "idle in transaction" and
  Postgres waiting on WAL sync). [Unverified] cause. Candidates: first-request work in a fresh
  process (tsx transpiles each lazily imported module on first use; first-call catalogue seeding),
  or the dev host itself (the Mac's load average went above 50 during the runs, and Docker Desktop
  networking stalled later). Re-run on Railway staging to tell them apart.
- **Realtime egress grows with players per room.** Street rooms send every moving player's
  position to everyone in the room at 10 Hz (no interest filter), so per-player downstream rises
  with room size: 6-14 KB/s at these mixes. [Inference] A full 100-player room is about 30 KB/s
  per player. The `vehicles` room already uses `StateView` interest management; the street rooms
  could do the same if bandwidth matters.
- `server/workers/district-rollover.ts` fails every day: `column p.district_slug does not exist`
  (seen in the Postgres log during the run). Unrelated to load; not touched here.
- `api` and `workers` cannot have more than one replica (see sizing).

## Railway sizing for ~100 private testers

[Inference] 100 testers will rarely be more than 30-50 online at once; the run above held 300 with
room to spare. Prices are from Railway's pricing page
(https://docs.railway.com/reference/pricing/plans, read 2026-10-25): usage is billed per minute at
$20 per vCPU-month, $10 per GB-month of RAM, $0.05 per GB of egress and $0.15 per GB-month of
volume. Hobby ($5) and Pro ($20) include that much usage.

| Service  | Replicas      | Limits (Railway caps, not reservations) | Measured at 300 players    | Why                                                                                                                                                                                                                                  |
| -------- | ------------- | --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| api      | **1**         | 1 vCPU, 1 GB                            | 0.07 vCPU avg, 260 MB      | `ShiftsService` keeps open shifts in process memory (`_shifts` in `server/application/shifts.ts`): with two replicas a shift started on one cannot be finished on the other. Make that Postgres- or Redis-backed before scaling out. |
| realtime | **1**         | 1 vCPU, 1 GB                            | 0.19 vCPU avg, 274 MB      | Rooms live in one process. Colyseus can run several processes with the Redis driver and presence that are already wired, but [Unverified] clients must then reach the specific process that holds their room; untested on Railway.   |
| workers  | **exactly 1** | 0.5 vCPU, 512 MB                        | ~0 vCPU, 115 MB            | The market sim and police referee are in-process timers; a second replica would tick them twice.                                                                                                                                     |
| Postgres | 1             | 1 vCPU, 1 GB, 5 GB volume               | 0.13 vCPU avg, bursts to 2 | Connections: 3 pools x `DB_POOL_MAX` (20) = 60, under the stock `max_connections` of 100 [Inference: Railway's image is the official Postgres image, whose default is 100]. Lower `DB_POOL_MAX` if replicas are added.               |
| Redis    | 1             | 0.5 vCPU, 256 MB                        | 0.04 vCPU, tens of MB      | Presence, rate limits, idempotency, BullMQ.                                                                                                                                                                                          |

**Expected bill** [Inference, from the measurements above]: RAM dominates. About 1.2 GB resident
across the five services is about $12/month; CPU averages well under 0.5 vCPU, so $2-8/month.
Realtime egress is about 42 MB per player-hour at these room sizes, so 100 testers x 1 h/day is
about 125 GB, or $6/month. That puts the whole stack around **$20-30/month**: Pro's included $20
covers most of it, and Hobby works too (per-service caps of 48 vCPU / 48 GB are far above need).

**Settings to check on Railway:**

- `DB_POOL_MAX=20` (new; default 20) on api, realtime and workers.
- `ENABLE_DEV_AUTH` must stay off in production (the config refuses it in staging and prod anyway).
- `pg_stat_statements` is the fastest way to see a slow query. [Unverified] whether Railway's
  default Postgres template loads it: their Postgres guide says extensions are not added to the
  default templates and points to custom images
  (https://docs.railway.com/guides/postgresql). Without it, use the API's `/metrics`
  (`ct_life_pg_pool{state="waiting"}`, `ct_life_event_loop_delay_ms`) and slow-request logs.
- Watch `/metrics` on api and realtime: pool `waiting` > 0 for more than a few seconds, or
  event-loop p99 > 100 ms, means it is time to look again.

## Caveats

- Everything ran on one shared dev Mac (12 cores, 32 GB) that was also running Unity lanes, two
  Solana validators and Chrome; the load generators ran on the same host as the servers. Absolute
  tails are pessimistic, and the stalls noted above may be the host. The SSI storm is not: it is
  deterministic Postgres behaviour and would happen on any host once players spin enough.
- Postgres ran in Docker Desktop with a virtualised disk; Railway volumes will have different
  fsync times.
- Bots do not send chat, emotes or vehicle traffic, and do not visit venues or homes. Street
  movement, the persistent rooms and the main REST screens are covered.
- The earlier `tools/load/staged-ramp.ts` (only `/v1/me`) and its numbers in `docs/CAPACITY.md`
  predate the casino and are superseded by this.
