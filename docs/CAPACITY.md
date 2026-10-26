# Capacity

> Measured concurrent players per realtime process and per API instance, the first bottleneck at each scale, CPU and memory per 1,000 players, bandwidth per client, the Postgres write ceiling, and the monthly cost per 1,000 concurrent at each tier.

This file is filled in at the M8 gate. Until then it is a target document with the assumptions and the test plan, and a table that the load tests will populate.

## Targets (assumptions the owner can change)

- **Design** for 20,000 concurrent players across the realtime and API tiers.
- **Load-test** to 5,000 on staging.
- **Measure** real per-process capacity and publish it here.

## Test plan

`tools/load/`:

- `staged-ramp.js` — 200, 1,000, 5,000 bots. Run from a separate machine, not the server host.
- `spike.js` — 0 to 2,000 logins in 60 s. Expects `SERVER_BUSY` for the overflow.
- `soak.js` — 1 h at 50% of the measured ceiling.
- `chaos/*.js` — Helius down, LiveKit down, price feed down, Redis restart, Postgres failover, kill processes.

The output of each run appends to this file: the number of bots, the per-process CPU, the per-process memory, the p50/p95/p99 REST latency, the room tick lag, the Postgres pool wait, the Redis latency, the bytes/s per client, the error rate, the first bottleneck.

## Scaling recipe (target)

| Concurrent | api replicas | realtime replicas | workers replicas | Postgres plan                              | Redis plan   | LiveKit plan                                   |
| ---------- | ------------ | ----------------- | ---------------- | ------------------------------------------ | ------------ | ---------------------------------------------- |
| 1,000      | 2            | 2                 | 2                | Hobby (1 vCPU, 1 GB)                       | 1 GB         | Build (5,000 participant-min, 100 concurrent)  |
| 5,000      | 4            | 4                 | 2                | Standard (2 vCPU, 4 GB)                    | 2 GB         | Scale (50,000 participant-min, 500 concurrent) |
| 20,000     | 16           | 16                | 8                | Performance (8 vCPU, 32 GB) + read replica | 8 GB cluster | Enterprise (custom)                            |

The numbers above are placeholders. They will be replaced with measured values from `staged-ramp.js`.

## Cost per 1,000 concurrent (placeholder, USD/month)

| Tier   | Railway | LiveKit       | Helius          | Postgres | Redis | S3   | Total |
| ------ | ------- | ------------- | --------------- | -------- | ----- | ---- | ----- |
| 1,000  | TBD     | $50           | $49 (Developer) | TBD      | TBD   | < $5 | TBD   |
| 5,000  | TBD     | $50 + overage | TBD             | TBD      | TBD   | TBD  | TBD   |
| 20,000 | TBD     | Enterprise    | TBD             | TBD      | TBD   | TBD  | TBD   |

Real values come from the cost dashboard, not the spec. The kill switches in `docs/OPERATIONS.md` enforce a hard cap so we never exceed budget by accident.

## First bottleneck (predicted)

At each scale, the predicted first bottleneck (to be confirmed by the load test):

- **1,000** — Postgres write ceiling on the ledger. Mitigation: `pgbouncer` transaction-pooling, monthly partitioning of `ledger_entries`, no global hot rows.
- **5,000** — realtime event loop lag. Mitigation: sharded city, sharded market, NPC density kill switch, `degraded.feed = "stale"`.
- **20,000** — Redis pub/sub for market ticks. Mitigation: per-coin channel, sharded market rooms, market leader with deterministic seed replay.

## Bandwidth per client (target 3–5 KB/s in a full venue)

The contract estimates 3–5 KB/s per client in a full venue. We will measure this at the M2 load test and again at the M3 sharded market test.

## Postgres write ceiling (placeholder)

TBD. The metric `pg_stat_database_tup_inserted` per database is the upper bound; the leaderboard inserts and the ledger inserts are the dominant load. The expectation is ~5,000 ledger writes/s on a 4-vCPU Postgres, which is well above 1,000-concurrent peak.

## See also

- `docs/LOAD-TEST.md` — the 100-300 player load test (Oct 2026): bottlenecks found and fixed, Railway sizing for the private test.

- `docs/ARCHITECTURE.md` — deployment topology.
- `docs/OPERATIONS.md` — kill switches and cost caps.
- `docs/TESTING.md` — load, spike, soak, chaos.
- `docs/SECURITY.md` — rate limits and `SERVER_BUSY`.

### Staged ramp — 2026-10-06T03:31:08.933Z

- target: `http://localhost:4010`
- bots: 50, duration: 10s, concurrency: 8
- p50/p95/p99/max (ms): 34 / 54 / 63 / 98
- requests: 17480, rps: 844.4, failures: 1, error rate: 0.01%

### Staged ramp — 2026-10-06T03:31:34.638Z

- target: `http://localhost:4010`
- bots: 100, duration: 10s, concurrency: 16
- p50/p95/p99/max (ms): 29 / 114 / 152 / 184
- requests: 17742, rps: 844.9, failures: 1, error rate: 0.01%

### Staged ramp — 2026-10-06T03:32:00.509Z

- target: `http://localhost:4010`
- bots: 200, duration: 10s, concurrency: 16
- p50/p95/p99/max (ms): 40 / 260 / 305 / 339
- requests: 17302, rps: 801.0, failures: 0, error rate: 0.00%
