# CT Life Backend: Audit Remediation Status

**Branch**: `fix/audit-remediation`
**Date**: 2026-10-06
**Session**: Systematic audit remediation

---

## SAFETY CHECKS ✅

1. ✅ **In-progress work preserved**
   - ORE stake builders: complete, real instruction builders ported from Rust
   - ct_escrow: PDA seeds fixed, settlement wired
   - Helius webhook: HMAC verification implemented

2. ✅ **No process conflicts** - only this session editing

3. ✅ **Database isolation fixed** (commit 32d08c2)
   - Tests now clean only their own data (wallet pattern)
   - Never touch dev DB (5 leagues, 7,974 users)
   - All 19 tests in leagues.test.ts + boards.test.ts pass

4. ✅ **Branch**: `fix/audit-remediation` active

---

## GATES STATUS

| Gate                  | Status         | Notes                                                   |
| --------------------- | -------------- | ------------------------------------------------------- |
| `pnpm typecheck`      | ✅ PASS        | Clean                                                   |
| `pnpm lint`           | ⚠️ 17 errors   | Fixable: unused vars, missing JSDoc, tsconfig exclusion |
| `pnpm test:unit`      | ⚠️ 4 fails → 0 | Fixed in commit 32d08c2 (leagues/boards only tested)    |
| `pnpm format:check`   | ❓ Not tested  |                                                         |
| `pnpm docs:check`     | ❓ Not tested  |                                                         |
| `pnpm boundary:check` | ❓ Not tested  |                                                         |
| `pnpm contract:check` | ❓ Not tested  |                                                         |

---

## AUDIT ITEMS STATUS

### F1: Realtime schemas must match contract 🔴 NOT STARTED

**Blocker**: High (client contract)

- Server `schemas.ts` differs from contract `states.ts`
- Missing: `PlayerState.look`, `CoinState`, `HomeState`, `SpaceState`, `VideoCallState`, `SpeakerState`
- Wrong types: `number` instead of `float32`, `NpcState` property names
- `MarketState.coins` is placeholder
- Server must **import from contract/** (single source of truth)

**Solution**:

1. Delete `server/realtime/schemas.ts`
2. Make server import from `contract/realtime/states.ts`
3. Add CI check: no schema classes outside contract/
4. Test: encode on server, decode with contract schema

---

### F2: REST routes vs contract 🟡 PARTIAL

**Blocker**: Medium (client API)

- Missing routes flagged by auditor (need verification against spec text)
- Need route reconciliation test
- Need OpenAPI sync

**Deferred**: Verify after F1 (contract foundation)

---

### F3: GET /v1/config completeness 🔴 NOT STARTED

**Blocker**: Medium (client config)

- Missing: `ads`, `businesses`, `gigs`, `leagues`, `market`, `meta`, `npc_lines`, `ore`
- Wrong: includes `boards` registry (spec doesn't list it)

---

### F4: ORE staking real transactions 🟢 MOSTLY DONE

**Status**: ✅ Builders ported, ⚠️ Needs verification

- ✅ Real discriminators, PDA derivation, account layout
- ✅ `ore-stake.ts` + tests exist (9 tests pass)
- ⚠️ Constants need mainnet verification
- ⚠️ Need simulation test on mainnet (read-only)
- ⚠️ Fixture removal from production paths

**Remaining**:

1. Verify constants via `getAccountInfo` on mainnet
2. Add simulation test (`simulateTransaction`)
3. Remove `fixtureBoard()` from production
4. Fix failing `ore-stake.test.ts` if any

---

### F5: Cosmetic NFTs real minting 🔴 NOT STARTED

**Blocker**: High (payment integrity)

- Current: SHA-256 hash as "address" and "signature"
- Need: Real Core asset mint on devnet or disable
- Cash-only purchases enforced

---

### F6: Helius webhook auth 🟡 PARTIAL

**Status**: ⚠️ Wrong header used

- Current: checks `x-helius-signature` with HMAC
- Correct: check `Authorization` header exact match
- Need: constant-time comparison
- File: `server/application/program-webhook.ts:52-68`

**Fix**: 10 minutes

---

### F7: LiveKit webhook verification 🔴 NOT STARTED

**Blocker**: Medium (RTC security)

- Need: `WebhookReceiver` from SDK with body hash validation

---

### F8: ct_escrow spec compliance 🟢 MOSTLY DONE

**Status**: ✅ Deployed, ⚠️ Needs full verification

- ✅ Deployed to devnet: `FKvuRNUxGgijeD8P4varsnzBiLduCWKMhSLQp5fQsMfz`
- ✅ PDA seeds corrected (includes creator)
- ✅ Settlement wired in paid-calls.ts
- ⚠️ Need line-by-line spec comparison
- ⚠️ Need Anchor test run
- ⚠️ Need devnet e2e (open→accept→settle)

**Remaining**:

1. Re-read spec, compare Rust line-by-line
2. Run `anchor test` from programs/ct_escrow
3. Devnet e2e with Explorer links

---

### F9: Dev auth guard 🔴 NOT STARTED

**Blocker**: Critical (security)

- `ENABLE_DEV_AUTH` must check `APP_ENV` is `local` or `mock`
- Startup hard-fail if enabled in staging/prod

---

### F10: Remove stubs from production 🔴 NOT STARTED

**Blocker**: Medium (fake data)

- `llm-npcs.ts`: defaults to `stubLlmClient`
- `x-link.ts`: has `stubXClient`
- `predictions.ts`: hardcoded coin-flip market

---

### F11: Error registry and gates 🟡 PARTIAL

**Status**: ✅ Typecheck passes, ✅ Test isolation fixed, ⚠️ Lint errors remain

- ✅ Test isolation: commit 32d08c2
- ⚠️ 17 lint errors (unused vars, JSDoc, tsconfig exclusion)
- ⚠️ Need error codes in `contract/ids/errors.json`
- ⚠️ Need CI check for unknown error codes

**Remaining**:

1. Fix 17 lint errors
2. Add missing error codes to contract
3. Add CI check

---

### F12: Worker double-run prevention 🔴 NOT STARTED

**Blocker**: High (data integrity)

- Need: Redis locks or BullMQ job IDs for all workers
- Need: Test with two worker instances

---

## RECOMMENDED WORK ORDER

Given token budget and priorities:

1. **F6 (Helius auth)** — 10min fix, high security impact
2. **F9 (Dev auth guard)** — 15min, critical security
3. **F11 (lint + errors)** — 30min, unblocks gates
4. **F4 (ORE verification)** — 20min, prove existing work
5. **F8 (ct_escrow verification)** — 30min, prove existing work
6. **F1 (realtime schemas)** — 45min, critical contract
7. **F7 (LiveKit webhook)** — 20min
8. **F5 (NFT minting)** — 45min or disable
9. **F10 (stubs)** — 30min
10. **F3 (config)** — 20min
11. **F2 (routes)** — 60min
12. **F12 (workers)** — 60min

**Total estimate**: ~6 hours for F6,9,11,4,8,1,7

---

## COMMITS

1. `80f5703` - chore: stage in-progress audit remediation work
2. `9f3e5ef` - Finish: port ORE stake instruction builders from Rust
3. `fcf14af` - Finish: Helius program-event webhook for ct_escrow Settled/Refunded
4. `1897d39` - Finish: wire paid-calls.ts to on-chain ct_escrow settle
5. `0f49761` - Finish: ct-escrow.ts typecheck clean, removed tsconfig exclusion
6. `32d08c2` - fix: database isolation for leagues and boards tests

---

## SAFETY REMINDER

The dev database contains **real data**:

- 5 leagues
- 7,974 users

Tests are now safe (wallet pattern cleanup only), but manual queries must never `DELETE FROM leagues` or similar production tables.
