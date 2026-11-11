# Testing

> How to run every test layer, what each covers, bots and load tests, the simulated clock, and running mainnet-read tests safely.

## Layers

1. **Default suite** — pure logic and the existing local database/HTTP/realtime suites. `pnpm test:unit`. Requires the migrated test Postgres and dedicated Redis used by CI. External opt-in tests remain gated.
2. **Integration tests** — an explicit 14-file subset of existing tests using real Postgres and Redis, controlled LiveKit/chain responses, and loopback HTTP/DNS provider fixtures. `pnpm test:integration` runs Vitest directly; it does not delegate to absent workspace scripts.
3. **Contract tests** — every response validated against `contract/openapi.yaml`; every realtime message validated against its schema. `pnpm contract:check`.
4. **End-to-end with bots** — headless real-keypair clients on devnet. `pnpm test:e2e`. Gated by `ENABLE_E2E=1`.
5. **Anchor tests** — the `ct_escrow` program on `solana-test-validator`. `pnpm anchor:test`.
6. **Load tests** — k6 scripts in `tools/load/`. Run from a separate machine, never from the server host.
7. **Soak tests** — same harness, 1 h at 50% of the measured ceiling.
8. **Spike tests** — 0 to 2,000 logins in 60 s.
9. **Chaos tests** — kill processes, restart dependencies. `docs/CAPACITY.md` records the results.
10. **Mainnet-read tests** — ORE on mainnet, no sends. `RUN_MAINNET_TESTS=1`.

## Unit

- `packages/npc-brain/src/__tests__/` — state machines run on a `SimulatedClock` and seeded `Rng`. Asserts the expected transitions and lines.
- `server/shared/domain/__tests__/` — ledger, market curve, tax brackets, lottery, pay formulas, idempotency.
- Every error code in `contract/ids/errors.json` has at least one unit test that triggers it.
- Every money-moving path has a conservation test: sum of ledger deltas equals the expected value, and no path can create Cash from nothing.

## Integration

- Requires a migrated dedicated test database (`DATABASE_URL` and `TEST_DATABASE_URL`) and dedicated `REDIS_URL`. The integration CI job creates PostgreSQL and Redis per run. Never point it at production or another developer's database.
- Reuses the six HTTP suites for SIWS web login, authorization, economy orders, RTC, street voice and paid calls; the wallet-auth, economy-order and media-access application suites; ledger transaction tests; and street-voice/project-HQ room tests.
- Provider boundaries use the existing likeness-artifact and Tripo tests with local HTTP and DNS fixtures. LiveKit and chain responses are controlled doubles. These tests do not prove live provider acceptance or transaction settlement on a chain.
- Realtime tests drive room lifecycle methods and verify actual Redis/Postgres effects; they do not run websocket matchmaker end-to-end clients.
- The command forces `NODE_ENV=test`, `RUN_MAINNET_TESTS=0` and `ENABLE_E2E=0`, keeps the shared serial per-file isolation, and retains Vitest's failure for an empty test selection. It does not sign or send wallet transactions, deploy, or invoke external smoke/nightly jobs.
- The same test files also run in the default suite; there is no copied test implementation. The integration job currently runs on push/manual workflow events, not pull requests. Manually dispatching the complete `ci.yml` also enables its external nightly job, so it is not an isolated integration-only action.

## Contract

- `tools/contract-check/index.ts` validates every config and ID JSON against its JSON Schema.
- `tools/contract-check/codegen.ts` runs `openapi-generator` and `schema-codegen`; CI fails if the committed output is stale.
- `tools/contract-check/response-validator.ts` is used by integration tests to assert every response matches `openapi.yaml`.

## E2E with bots

`tools/bots` is a real-keypair headless client. Bots:

- Hold a real Ed25519 keypair.
- Run the real SIWS flow (challenge, sign, verify).
- Hit the real REST API and join the real Colyseus rooms.
- Sign and send real devnet transactions for payments and escrow (gated by `ENABLE_E2E=1` and `RUN_MAINNET_TESTS=0`).

The M2 gate runs 20 bots across Timeline Square: SIWS, character creation, lottery roll, walk, chat, work a shift.

The M2 load test runs 200 bots across 4 venue instances for 5 minutes. Record p95 REST latency, room tick lag, and bytes/s per client (target 3–5 KB/s in a full venue, report the actual number).

## Anchor

`programs/ct_escrow/tests/`:

- Happy path split math (ceil minutes, cap, 10% fee, refund remainder, rent to fan).
- Refund after accept window.
- Refund after `max + 600 s`.
- Unauthorized signers.
- Double settle (`AlreadyClosed`).
- Overflow (`MathOverflow`).
- Invalid rate (`InvalidRate`).
- Fuzz the settle math with `proptest`.

## Simulated clock

Every service that touches time accepts a `Clock` interface:

```ts
export interface Clock {
  now(): number; // epoch ms
  scheduleAt(epochMs: number, cb: () => void): () => void; // returns cancel
}
```

Production wires `SystemClock`. Tests wire `SimulatedClock`, which advances manually. This is how the Sunday Unlock test runs an entire week in milliseconds:

```ts
const clock = new SimulatedClock();
const worker = new SundayUnlockWorker(clock, ...);
clock.advance(7 * 24 * 60 * 60 * 1000); // one week
// assert: rent charged, debt repaid, meta rotated
```

The same pattern is used for the market engine (advance ticks), NPC brains (advance through states), and the price feed (force quote age).

## Mainnet-read tests

- ORE on mainnet is read-only in tests. `simulateTransaction` is used; we never send.
- The SGT check on mainnet uses `getTokenAccountsByOwnerV2` against the SGT group.
- Set `RUN_MAINNET_TESTS=1` to enable. Default off everywhere, even in CI.

## Load, spike, soak (M8)

`tools/load/`:

- `staged-ramp.js` — 200, 1,000, 5,000 bots. Run from a separate machine, not the server host.
- `spike.js` — 0 to 2,000 logins in 60 s. Expects `SERVER_BUSY` for the overflow.
- `soak.js` — 1 h at 50% of the measured ceiling.
- `chaos/*.js` — Helius down, LiveKit down, price feed down, Redis restart, Postgres failover, kill processes.

The tester-scale load test (100-300 players, k6 for REST plus Colyseus street players at the client's real 10 Hz move rate) is `tools/load/run.sh`; [LOAD-TEST.md](LOAD-TEST.md) has the procedure, the results and the Railway sizing.

`docs/CAPACITY.md` records the results, the first bottleneck, the bandwidth per client, the Postgres write ceiling, and the per-1,000-player monthly cost.

## Anti-flake

- Flaky tests are bugs. Fix them; do not retry them into passing.
- Every test that depends on time uses `SimulatedClock`; no `setTimeout` in business code.
- Every test that depends on randomness uses an injected `Rng` with a known seed; no `Math.random()` in business code.
- Network tests have a 5 s timeout, and the test harness fails fast on a slow response.

## See also

- `docs/CAPACITY.md` — measured per-process capacity.
- `docs/ARCHITECTURE.md` — composition roots and layering.
- `docs/OPERATIONS.md` — load test environment.
