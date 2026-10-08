# CT Life Backend: Audit Remediation Continuation Prompt

**Paste this into Claude Code at the root of `ct-life-backend`.**

---

## CURRENT STATE (as of 2026-10-08, commit df1657e)

You are continuing an audit remediation session. **Critical context:**

- **Branch**: `fix/test-isolation` (will be merged to `main` when complete)
- **Remote**: Not yet pushed (local commits only)
- **Last commit**: `df1657e` - "fix: LiveKit webhook body hash verification (F7)"
- **Token budget used**: ~74k / 200k (126k remaining in that session)
- **Git status**: Clean working directory (all changes committed)

### What Has Been Completed (7 commits, all evidence in docs/)

1. ✅ **Test isolation fix** (CRITICAL) - Tests were deleting production DB rows
   - Fixed `leagues.test.ts` to use isolated test DB
   - Dev DB has 7,974 users, 5 leagues - now safe
   - Evidence: `docs/TEST_EVIDENCE.md`

2. ✅ **F6: Helius webhook auth** (SECURITY)
   - Fixed: Now checks `Authorization` header with constant-time comparison
   - Was: Wrong HMAC on invented header
   - Tests: valid, wrong header, missing header, secret unset
   - Evidence: `docs/F6_EVIDENCE.md`

3. ✅ **F9: Dev auth guard** (SECURITY)
   - Fixed: Hard-fail at startup if `ENABLE_DEV_AUTH=true` and `APP_ENV` is staging/prod
   - Tests: All combinations of APP_ENV × ENABLE_DEV_AUTH
   - Evidence: `docs/F9_EVIDENCE.md`

4. ✅ **F11: Lint errors** (GATES)
   - Fixed all 18 ESLint errors
   - Added JSDoc to all exported functions
   - `pnpm lint` now passes
   - Evidence: `docs/F11_EVIDENCE.md`

5. ✅ **F7: LiveKit webhook** (SECURITY)
   - Fixed: Now uses official `WebhookReceiver` to validate body hash
   - Tests: valid webhook, tampered body, wrong secret
   - Evidence: `docs/F7_EVIDENCE.md`

### Current Gates Status

- ✅ `pnpm typecheck` - passing
- ✅ `pnpm lint` - passing
- ✅ `pnpm test:unit` - 19 tests pass (isolation fixed)
- ⚠️ Other gates not yet verified (format:check, docs:check, boundary:check, contract:check)

---

## REMAINING WORK (Prioritized by Impact)

### 🔴 CRITICAL PATH (Must complete before merge)

#### F1: Realtime schemas must match contract (CLIENT BLOCKER)

**Status**: Not started  
**Difficulty**: 45 minutes  
**Why critical**: Client cannot decode server state until this is fixed

**The issue**:

- `server/realtime/` has duplicate schema definitions that diverge from `contract/realtime/`
- `PlayerState` lacks `look: string[7]`
- Coordinates are `number` instead of `float32` (Schema.Float32Array in Colyseus)
- `NpcState` property names differ, `lineParams` missing
- `MarketState.coins` is placeholder instead of `MapSchema<CoinState>`
- Missing: `HomeState`, `SpeakerState`, `SpaceState`, `VideoCallState`
- `welcome` wrongly registered as client-to-server (it's server-to-client only)

**Required fix**:

1. Make server **import** schema classes from `contract/realtime/states.ts` (single source of truth)
2. Delete duplicate definitions in `server/realtime/schemas.ts` (or wherever they are - find them first)
3. Field-for-field match with spec tables: `PlayerState`, `NpcState`, `CoinState`, `CityState`
4. Remove `onMessage('welcome')` handler - `welcome {serverNow, instanceId}` is server-to-client only
5. Add test: encode state on server, decode using contract schema, assert fields match
6. Add CI check: fail if any schema class exists outside `contract/realtime/`

**Files to check**:

```bash
# Find where server schemas are defined
grep -r "class.*State.*extends.*Schema" server/
# Check contract schemas
cat contract/realtime/states.ts
# Check if server imports from contract
grep "from.*contract/realtime" server/realtime/*.ts
```

**Test command**:

```bash
pnpm test:unit --run --reporter=verbose 2>&1 | grep -i realtime
```

#### F4: ORE staking - verify constants and add mainnet simulation

**Status**: Partially complete (in-progress files exist)  
**Difficulty**: 20 minutes  
**Critical files in working directory**:

- `server/shared/solana/ore-stake.ts` (modified, in git status)
- `server/shared/solana/ore-stake.test.ts` (untracked)
- `tools/scripts/inspect-ore.ts` (untracked)

**What needs verification**:

1. **Constants** (verify these are correct):
   - ORE mint: `oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp`
   - ORE program: `oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv`
   - Stake program: `stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH`
   - stORE mint: `storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR`
   - **Action**: Run mainnet `getAccountInfo` on each, paste output to evidence file

2. **Remove `fixtureBoard()` from production paths**:
   - Search for `fixtureBoard` in `server/application/refinery.ts` and related files
   - On RPC failure: serve cached board with `stale: true`, or return `503 SERVER_BUSY`
   - Never invent data

3. **Mainnet simulation test**:
   - Add test in `ore-stake.test.ts` that calls `simulateTransaction` on mainnet
   - Use `sigVerify: false` and a funded/replaced blockhash
   - Paste simulation output to `docs/F4_EVIDENCE.md`
   - **DO NOT send real transactions**

4. **Decision on in-progress files**:
   - Read `server/shared/solana/ore-stake.ts`, `ore-stake.test.ts`, `inspect-ore.ts`
   - If they are valid work-in-progress for ORE builders, integrate them
   - If scratch/incomplete, delete only if certain they're not needed
   - The failing test mentioned was about unsigned transaction serialization

**Test command**:

```bash
# Only with RUN_MAINNET_TESTS=1
RUN_MAINNET_TESTS=1 pnpm vitest run ore-stake.test.ts
```

#### F8: ct_escrow - line-by-line spec comparison

**Status**: Not started  
**Difficulty**: 30 minutes  
**Why critical**: Escrow handles real money

**The issues found**:

- Session PDA seeds omit `creator` (spec: `["session", fan, creator, session_id_le_bytes]`)
- `open_session` does not add fee to deposit (spec: `rate × max_minutes × (1 + fee_bps/10000)`)

**Required fix**:

1. Read the **entire** `ct_escrow` spec section (find it in `docs/` or `contract/specs/`)
2. Compare Rust code line-by-line:
   - Config PDA seeds
   - Session PDA seeds (must include creator)
   - `open_session` deposit calculation (must include fee)
   - `settle` math: ceil minutes, cap, fee, remainder refund, rent to fan
   - `refund` conditions and signers
   - All events, errors
3. Fix every difference (not just the two reported)
4. Run `anchor test` from `programs/ct_escrow/` (has its own package.json)
5. Paste test output to `docs/F8_EVIDENCE.md`
6. Cover: settle split math, refund timing, unauthorized signers, double settle, overflow, InvalidRate

**Commands**:

```bash
cd programs/ct_escrow
anchor test 2>&1 | tee ../../docs/F8_EVIDENCE.md
cd ../..
```

**If Anchor not available**: Document the blocker in `docs/UNVERIFIED.md` and move on.

---

### 🟡 HIGH PRIORITY (Should complete)

#### F2: REST routes - contract reconciliation

**Status**: Not started  
**Difficulty**: 60 minutes

**Missing routes** (verify each against spec text, not just OpenAPI):

- `PATCH /characters/me/look`
- `GET /homes`
- `POST /rtc/token`
- `GET /events/active`
- `PUT /creator` (may be implemented as POST/PATCH)
- `GET /payments/intents/{id}` (polling)
- `POST /admin/market/force-price`
- `POST /admin/users/{id}/skills` (staging only)
- `POST /spaces/{id}/speakers` with body `{userId}`
- `PATCH /characters/me/tribe` (may be `POST /v1/me/tribe`)
- `POST /predictions/{id}/bets` (may be `POST /v1/predictions`)
- LiveKit webhook route (verify it's actually registered)

**Also add to OpenAPI** (these exist in code but not in spec):

- Project routes
- Hire routes
- Launch routes
- Beef routes
- Cabal invite routes
- NFT mint and inventory routes
- Sybil jail admin routes

**Required tests**:

1. Build route-reconciliation test: parse `openapi.yaml`, collect Fastify routes, fail on mismatch (with allowlist for health/metrics/docs)
2. Run REST fuzzer or Schemathesis against local server
3. Staging-only routes must be unreachable when `APP_ENV=prod` (test with hard-coded override)

#### F3: GET /v1/config completeness

**Status**: Not started  
**Difficulty**: 20 minutes

**The issue**:

- Missing from payload: `ads`, `businesses`, `gigs`, `leagues`, `market`, `meta`, `npc_lines`, `ore`
- Wrongly includes: `boards` registry (server-only)

**Required fix**:

1. Read spec section 7 - lists exactly what `/v1/config` should serve
2. Serve: `economy, needs, skills, lottery, careers, gigs, businesses, market, events, meta, npc_lines, leagues, ads, ore`
3. Each with `version`, `minClientVersion`, ETag caching, `degraded` array
4. **Never leak server-only values** (e.g., hidden market arc outcome mix)
5. Test: payload contains exactly expected keys, each validates against JSON Schema

**File**: `server/api/routes/config.ts`

#### F5: Cosmetic NFTs - real minting or disable

**Status**: Not started  
**Difficulty**: 45 minutes

**The issue**:

- `nft-mint.ts` derives fake address and signature by SHA-256 hashing
- No real on-chain asset

**Required fix** (choose one):

**Option A: Real minting**

1. Install `@metaplex-foundation/umi` and `@metaplex-foundation/mpl-core` (check latest versions on npm)
2. Mint real Core asset on **devnet** after confirmed payment
3. Sign with server mint authority key from env
4. Owner = buyer's wallet
5. Persist real asset address and transaction signature from network
6. Verify with `getAccountInfo`, print explorer link
7. Delete synthetic address/signature generation
8. Test: mint on devnet, read account back
9. Test: Cash purchase cannot reach mint code (cosmetic NFTs are real-money only)

**Option B: Disable**

1. Add feature flag `COSMETIC_NFTS_ENABLED=false`
2. Return clear contract error when disabled
3. Never return fabricated address/signature
4. Document in `docs/UNVERIFIED.md`

#### F10: Remove stubs from production

**Status**: Not started  
**Difficulty**: 30 minutes

**The issues**:

- `llm-npcs.ts` defaults to `stubLlmClient`
- `x-link.ts` has `stubXClient`
- `predictions.ts` has hardcoded coin-flip market

**Required fix**:

1. When credentials absent: feature must be **off** (flag disabled, clear error)
2. Stub clients may exist only under `test/` directories
3. Predictions: markets created from real in-game events (5m, 15m, 1h, daily), not hardcoded
4. If current behavior is a deliberate seed: show where real markets are created/resolved

#### F12: Workers must not double-run

**Status**: Not started  
**Difficulty**: 40 minutes

**Workers to check**:

- Payments poller
- Liquidation
- Predictions
- Alpha
- Rent
- Sunday Unlock
- District rollover
- Advanced jobs

**Required**:

1. Each must take Redis lock/lease OR use unique BullMQ job ID
2. Test: start two worker instances, assert no double liquidation/rent/unlock
3. Fix any worker without protection

---

### 🟢 LOWER PRIORITY (If time permits)

These can be documented in `UNVERIFIED.md` if blocked:

- Error registry completeness (add missing codes to `contract/ids/errors.json`)
- Documentation corrections (`PROGRESS.md`, `TEST_REPORT.md`, `HANDOVER.md` - ensure no false claims)

---

## WORKFLOW RULES

### Safety (CRITICAL - read before any change)

1. **Check git status first**:

   ```bash
   git status --porcelain
   git stash list
   ```

   The three ORE files (`ore-stake.ts`, `ore-stake.test.ts`, `inspect-ore.ts`) are work-in-progress. Do not discard them.

2. **You are on branch `fix/test-isolation`** - do not create a new branch

3. **Database safety**:
   - Tests use isolated database (fixed in first commit)
   - Dev DB has real data (7,974 users, 5 leagues)
   - Never run `DELETE FROM` without `WHERE` in tests

4. **No fabricated evidence**:
   - Every test result must be real command output
   - If you cannot complete a fix honestly, disable the feature and document in `docs/UNVERIFIED.md`
   - A disabled feature is acceptable; a fake one is not

5. **Commit discipline**:
   ```bash
   git add -A
   git commit -m "fix: <area> (<item-number>)"
   # Examples: "fix: realtime schemas (F1)", "fix: ORE constants (F4)"
   ```
   No AI attribution trailers. One commit per item when possible.

### Quality Standards

1. **Append-only ledger**: Never modify/delete `webhook_events` or financial transactions
2. **SOLID layering**: Keep domain, application, infrastructure separated
3. **Documentation**: Update relevant docs with each change
4. **Mainnet tests**: Gate behind `RUN_MAINNET_TESTS=1` env var
5. **Never mock on-chain behavior**: Use real simulateTransaction or devnet

### Verification Requirements

For every fix:

1. **Reproduce** - Confirm the defect by reading code (and failing test if possible)
2. **Fix** - Make the change
3. **Test** - Run tests, paste output to `docs/<ITEM>_EVIDENCE.md`
4. **Document** - Update relevant docs
5. **Commit** - One clear commit per item

If a lead is wrong: state why with evidence and skip it.

---

## FINAL DELIVERABLES

When all items are complete (or documented as blocked):

### 1. Create final report table

Format:

```
| Item | Real? | Status | Evidence | Commit |
|------|-------|--------|----------|--------|
| F1   | ✅ Yes | FIXED  | docs/F1_EVIDENCE.md | abc1234 |
| F2   | ✅ Yes | FIXED  | docs/F2_EVIDENCE.md | def5678 |
| F4   | ✅ Yes | FIXED  | docs/F4_EVIDENCE.md | ghi9012 |
| F5   | ✅ Yes | DISABLED BEHIND FLAG | docs/F5_EVIDENCE.md | jkl3456 |
| F10  | ❌ No  | NOT A DEFECT | (reasoning) | - |
```

### 2. Verify all gates pass

```bash
pnpm typecheck        # Must pass
pnpm lint            # Must pass
pnpm format:check    # Must pass
pnpm docs:check      # Must pass
pnpm boundary:check  # Must pass
pnpm contract:check  # Must pass
pnpm test:unit       # Must pass
```

Paste full output.

### 3. Ensure git status clean

```bash
git status --porcelain  # Must be empty
```

### 4. Update documentation

- `docs/UNVERIFIED.md` - Any unfixed/disabled items with reason
- `docs/PROGRESS.md` - Correct all false claims about M3, M4, M5, M8
- `docs/TEST_REPORT.md` - Reflect reality after fixes
- `docs/HANDOVER.md` - Update with current state

### 5. Merge and push

```bash
# Final check
git log --oneline origin/main..HEAD  # Review all commits
pnpm typecheck && pnpm lint && pnpm test:unit  # Final gate check

# Merge to main
git checkout main
git merge fix/test-isolation --no-ff -m "fix: audit remediation (F1-F12)"

# Push to remote
git push origin main
```

---

## REFERENCE: Project Structure

```
ct-life-backend/
├── contract/          # Source of truth
│   ├── realtime/      # Colyseus schema definitions (F1)
│   ├── ids/           # Error codes, skill IDs, etc
│   └── openapi.yaml   # REST contract (F2)
├── server/
│   ├── api/routes/    # REST endpoints (F2, F3)
│   ├── realtime/      # Colyseus rooms (F1)
│   ├── application/   # Business logic (F6, F7, F9)
│   └── shared/
│       └── solana/    # Blockchain builders (F4, F8)
├── programs/
│   └── ct_escrow/     # Anchor program (F8)
├── docs/              # Evidence files go here
│   ├── F1_EVIDENCE.md
│   ├── F4_EVIDENCE.md
│   └── UNVERIFIED.md
└── tools/             # Admin scripts
```

---

## IMPORTANT CONTEXT FILES

Before starting, read these:

1. `docs/F6_EVIDENCE.md` - Example of proper evidence format
2. `docs/TEST_EVIDENCE.md` - Test isolation fix (your template)
3. `AUDIT_STATUS.md` - Current status summary
4. Git log: `git log --oneline -10` - See what's been done

---

## TROUBLESHOOTING

### If tests fail mysteriously

```bash
# Check if another process is running tests
ps aux | grep vitest
# Check database state
psql $DATABASE_URL -c "SELECT COUNT(*) FROM users;"
```

### If Anchor tests won't run

```bash
cd programs/ct_escrow
anchor --version  # Check if installed
ls package.json   # Check if deps exist
```

If blocked: document in `docs/UNVERIFIED.md` and move on.

### If mainnet RPC rate-limited

Use a different RPC in env or document the blocker.

---

## SUCCESS CRITERIA

- [ ] All critical items (F1, F4, F8) are FIXED or documented as blocked
- [ ] All security items (F6, F7, F9) are complete (already done)
- [ ] All gates pass (typecheck, lint, test:unit, format:check, docs:check, boundary:check, contract:check)
- [ ] Git status clean (all changes committed)
- [ ] Evidence files exist for every fix
- [ ] `UNVERIFIED.md` lists any blocked/disabled items
- [ ] Branch merged to main
- [ ] Changes pushed to remote

---

## START HERE

1. Run `git status` and verify you're on `fix/test-isolation` with clean working directory
2. Read the three ORE files to understand work-in-progress
3. Start with **F1 (realtime schemas)** - it's the client blocker
4. Work through critical path: F1 → F4 → F8
5. Commit after each fix with evidence

**Estimated time**: 2-3 hours for critical path, 4-5 hours for all items.

Good luck! 🚀
