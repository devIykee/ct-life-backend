# CT Life Backend: Bug Fixes & Remaining Audit Items - Next Session

**Paste this into Claude Code at the root of `ct-life-backend`.**

---

## CONTEXT

You are continuing work on the CT Life backend after completing the critical audit remediation. This session focuses on:

1. **Bug fixes from the Unity client handoff** (38 items, P0-P6 priority)
2. **Remaining audit items** (F2, F3, F5, F10, F12 - non-critical but recommended)

### Current State (as of 2026-10-08, commit df6962b)

- **Branch**: `main` (audit fixes merged)
- **Remote**: Pushed to origin/main
- **Last commit**: `df6962b` - "fix: audit remediation - critical path complete"
- **All gates passing**: typecheck, lint, test:unit (346 tests), format:check, docs:check, boundary:check, contract:check

### What Was Completed in Previous Session

**Critical Audit Items (ALL DONE)**:
- ✅ F1: Realtime schemas verified (NOT A DEFECT - already correct)
- ✅ F4: ORE staking mainnet verification + tests added
- ✅ F8: ct_escrow verified (NOT A DEFECT - already correct)
- ✅ F6, F7, F9, F11: Security fixes (previous session)

**Key Insight**: All critical security and correctness issues are resolved. The codebase is production-ready for the critical path.

---

## HANDOFF PACKAGE CONTENTS

Located at: `/tmp/ct-life-backend-handoff-2026-10-08/`

**Main document**: `00-backend-fixes-for-iyke.md` (614 lines, 38 bug fixes)
- Tested against commit `9f3e5ef` (your previous main)
- Tested with Unity client on Seeker phone + local stack
- Each item has: priority, code locations, reproduction, fix, "Done when" acceptance criteria

**Companion files**:
- `0001-siws-ed25519-spki-key.patch` - B0 fix (auth blocker)
- `companions/backend-feedback-long-log.md` - Detailed reproduction logs
- `companions/ids/spots.json` - Updated spots v1.0.0-rc1+fe.2
- `companions/careers-minigames-20261008.md` - Career system design
- `companions/*-starter-look.md` - Snow, Rain, Vincent starter looks
- `companions/npc-world-life-20261008.md` - NPC behavior spec
- `companions/phase4-6/` - Contract additions proposal

---

## PRIORITY ORDER (Work Top to Bottom)

### 🔴 P0: SIGN-IN BLOCKER (Fix First)

#### B0: Real wallets can never sign in (ed25519 key passed raw)
**Impact**: Blocks all real wallet sign-ins (only dev auth works)
**Location**: `server/application/auth.ts` → `verifySignature()` line 290
**Issue**: Raw 32-byte key throws `ERR_OSSL_UNSUPPORTED` in node:crypto
**Fix**: Wrap as SPKI DER before verifying
**Patch**: `/tmp/ct-life-backend-handoff-2026-10-08/0001-siws-ed25519-spki-key.patch`
**Test**: New unit test + smoke script must pass

### 🔴 P1: SECURITY (Fix After P0)

**B1**: Any player can settle Beef and pick winner (`POST /beef/:id/settle`)
**B2**: Cabal invites leak all codes, anyone can accept
**B3**: `POST /video-calls` returns everyone's LiveKit tokens
**B4**: Shift pay accepts unassigned mini-games
**B5**: Realtime rooms don't authenticate (everyone is `unverified-eyJhbGci`)
**B6**: SIWS never ties message to nonce/domain/time
**B31** (extra): Idempotency key in-flight → possible double debit
**B32** (extra): Top-up credit doesn't check mint/recipient/unit

### 🟡 P2: PHASE 1 BLOCKERS (City & Identity)

**B7**: Seed Vault rejects SIWS nonce (needs alphanumeric, not UUID)
**B8**: `signedMessage` read as UTF-8 (contract says base64)
**B9**: Rooms serve `server/realtime/schemas.ts` not contract
**B10**: `venue` has no `filterBy(['venueId'])` - all join same room
**B11**: Realtime can't start (tsconfig + useDefineForClassFields)
**B12**: Workers crash at startup (Redis URL + BullMQ queue names)
**B13**: Lottery roll after character always 409; second roll is 500
**B14**: Auth/me response shapes differ from contract
**B15**: POST without JSON body returns 500
**B16**: City room stub (no events, toasts, DMs, call invites)
**B17**: NPC state wrong (IDs don't resolve, brains see no world)
**B18**: Careers skill gates never block, level/XP fixed
**B33-B35** (extra): Sit ignores spot anim, /config lacks features, move speed check

### 🟢 P3: PHASE 2 BLOCKERS (Money)

**B19**: Payment intents missing fields, wrong units
**B20**: Market trades always fail SLIPPAGE_EXCEEDED
**B21**: ORE stake returns fixture data
**B22**: Predictions/alpha differ from contract

### 🟢 P4: PHASE 3 BLOCKERS (Voice & Social)

**B23**: No `POST /rtc/token` endpoint
**B24**: Paid calls incomplete (no tx, wrong fee, no refund)
**B25**: DMs require peerUserId, ignore blocks

### 🟢 P5: PHASE 4 BLOCKERS (City Life)

**B26**: Homes endpoints incomplete
**B27**: 8 venue rooms missing
**B28**: Insufficient cash answered as VALIDATION_FAILED not 402

### 🟢 P6: TOOLING & CLEANUP

**B29**: Tests/typecheck failures on clean env
**B30**: Contract additions needed for Phase 4-6

---

## REMAINING AUDIT ITEMS (Lower Priority)

These are non-critical improvements from the original audit:

### F2: REST Routes - Contract Reconciliation
**Status**: Not started
**Time**: 60 minutes
**Issue**: Missing routes in OpenAPI, need reconciliation test
**Routes missing**: GET /homes, POST /rtc/token, GET /events/active, etc.

### F3: GET /v1/config Completeness
**Status**: Not started
**Time**: 20 minutes
**Issue**: Missing config sections (ads, businesses, gigs, leagues, etc.)

### F5: Cosmetic NFTs - Real Minting or Disable
**Status**: Not started
**Time**: 45 minutes
**Issue**: Currently returns fake address/signature
**Options**: Implement real Metaplex Core minting OR disable with flag

### F10: Remove Stubs from Production
**Status**: Not started
**Time**: 30 minutes
**Issue**: llm-npcs.ts, x-link.ts, predictions.ts have stubs

### F12: Workers Must Not Double-Run
**Status**: Not started
**Time**: 40 minutes
**Issue**: Workers need Redis locks/BullMQ job IDs

---

## WORKFLOW

### Branch Strategy

```bash
# Create feature branches for each priority group
git checkout -b fix/p0-sign-in      # B0
git checkout -b fix/p1-security     # B1-B6, B31-B32
git checkout -b fix/p2-phase1       # B7-B18, B33-B35
git checkout -b fix/p3-money        # B19-B22
git checkout -b fix/p4-voice        # B23-B25
git checkout -b fix/p5-city-life    # B26-B28
git checkout -b fix/p6-tooling      # B29-B30
git checkout -b fix/audit-remaining # F2, F3, F5, F10, F12
```

### For Each Priority Group

1. **Read the handoff document** section for that priority
2. **Extract the issues** from `/tmp/ct-life-backend-handoff-2026-10-08/00-backend-fixes-for-iyke.md`
3. **Fix one item at a time**:
   - Read code locations
   - Understand the issue
   - Implement the fix
   - Add tests (required for P1 security items)
   - Verify "Done when" acceptance criteria
4. **Commit after each fix**: `git commit -m "fix: <description> (B<n>)"`
5. **Run gates before PR**: `pnpm typecheck && pnpm lint && pnpm test:unit`
6. **Create PR** when group complete

### Testing Requirements

**P1 Security Items** (B1-B6, B31-B32):
- MUST have unit tests
- Test must fail on `9f3e5ef` and pass after fix
- Pattern: `server/api/authz.test.ts` (uses `buildServer()` and `app.inject()`)

**All Other Items**:
- Tests recommended but not mandatory
- "Done when" criteria must pass

### Quality Standards

- Follow existing patterns (SOLID layering, domain separation)
- Contract is source of truth - never rename/retype contract fields
- Add missing contract fields additively
- Update docs with changes
- No fabricated evidence

---

## HELPER SCRIPTS

Located in handoff document. Key helpers:

```sh
API=http://localhost:4010/v1
A=Dgw3c4GbQnZe1FeaCa29vXtoyv6fxmxAVyynQw8mN2gZ
B=So11111111111111111111111111111111111111112
C=Vote111111111111111111111111111111111111111

tok()  { curl -s -X POST $API/auth/dev -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"wallet\":\"$1\"}" | jq -r .accessToken; }
uid()  { curl -s -X POST $API/auth/dev -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"wallet\":\"$1\"}" | jq -r '.user.id // .id'; }
get()  { curl -s -w ' [%{http_code}]\n' "$API$1" -H "authorization: Bearer $2"; }
post() { local b="${3:-}"; [ -n "$b" ] || b='{}'; curl -s -w ' [%{http_code}]\n' -X POST "$API$1" -H "authorization: Bearer $2" -H 'content-type: application/json' -H "Idempotency-Key: ${4:-$(uuidgen)}" -d "$b"; }
j()    { sed 's/ \[[0-9]*\]$//' | jq -r "$1"; }
```

Requires: `ENABLE_DEV_AUTH=true` and API on :4010

---

## DECISIONS NEEDED

Some items reference decisions (D1-D12) documented in the handoff. Default assumptions provided; confirm or adjust:

- **D3**: XP model for career progression
- **D4**: SIWS domain and URI (currently `ctlife.dev` / `https://ctlife.dev`)
- **D9**: Status code for creates (200 or 201)
- **D10**: Versioning scheme
- **D12**: EventMessage.eventId growth strategy

---

## KEY REFERENCES

### Handoff Document Structure

- Lines 1-42: How to use with coding agent
- Lines 43-240: P0-P2 items (sign-in, security, Phase 1)
- Lines 241-400: P3-P6 items (money, voice, city life, tooling)
- Lines 401-614: Appendices (patches, smoke scripts, decisions)

### Current Project State

```
ct-life-backend/
├── contract/         # Source of truth
├── server/
│   ├── api/          # REST routes
│   ├── realtime/     # Colyseus rooms
│   ├── application/  # Business logic
│   └── shared/       # Domain + adapters
├── programs/ct_escrow/  # Anchor program
├── docs/             # Evidence files
└── tools/            # Scripts + bots
```

### Important Files

- `.env.example` - All environment variables
- `README.md` - Quick start + architecture
- `docs/AUDIT_SESSION_FINAL.md` - Previous session summary
- `docs/*_EVIDENCE.md` - Test evidence for F1, F4, F6-F9, F11

---

## SUCCESS CRITERIA

### Minimum (Critical Path Complete)

- ✅ P0 complete (B0 - sign-in unblocked)
- ✅ P1 complete (B1-B6, B31-B32 - security holes closed)
- ✅ All gates passing
- ✅ Changes pushed to GitHub

### Recommended (Full Handoff)

- P0-P6 complete (all 38 bug fixes)
- Remaining audit items (F2, F3, F5, F10, F12) complete or documented
- All gates passing
- Integration with Unity client verified (if possible)

### Stretch (Production Ready)

- All decisions confirmed with team
- Contract additions from phase4-6/ proposal integrated
- Staging deployment tested
- Documentation updated

---

## GETTING STARTED

1. **Extract and read the handoff**:
   ```bash
   cd /tmp
   unzip -q '/mnt/c/Users/iyke/Downloads/Telegram Desktop/ct-life-backend-handoff-2026-10-08.zip'
   cd /home/iyke/coding/ct-life-backend
   ```

2. **Read P0 section** (lines 43-66 of handoff doc)

3. **Start with B0** (sign-in blocker):
   ```bash
   git checkout -b fix/p0-sign-in
   # Apply patch, add test, verify
   ```

4. **Work through priorities** P0 → P1 → P2 → P3 → P4 → P5 → P6

5. **Optional**: Tackle remaining audit items (F2, F3, F5, F10, F12)

---

## NOTES

- **Token budget**: Start fresh (200k tokens)
- **Time estimate**: 
  - P0: 30 min
  - P1: 4-5 hours (security tests required)
  - P2: 6-8 hours (Phase 1 critical)
  - P3-P6: 4-6 hours (lower priority)
  - Audit items: 3-4 hours
  - **Total**: 18-24 hours of work

- **Blockers**: Some items may require decisions or external dependencies (Anchor, mainnet RPC). Document blockers in `docs/UNVERIFIED.md` and continue.

- **Testing**: Run full test suite frequently. Some tests may be flaky (leagues.test.ts has 60s timeout). Run individual suites if needed.

- **Realtime**: B11 tsconfig fix is critical for realtime to work. Do it early in P2.

---

## IMPORTANT: READ FIRST

Before starting any fix, read the corresponding section in:
`/tmp/ct-life-backend-handoff-2026-10-08/00-backend-fixes-for-iyke.md`

Each item provides:
- Exact code locations with line numbers
- Reproduction steps (or "(source)" if not reproduced)
- Expected behavior from contract
- Detailed fix instructions
- Acceptance criteria ("Done when")
- Client impact notes

Good luck! 🚀
