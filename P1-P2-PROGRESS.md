# P1-P2 Security and Phase 1 Blocker Fixes - Progress Report

## Summary

This document tracks the implementation of P1 (security) and P2 (phase 1 blockers) fixes from the handoff document.

## P1 - Security Fixes (COMPLETED ✅)

All P1 items have been implemented and tested. 349/349 tests pass.

### Completed Items:

- **B1** ✅ Beef settlement authorization (hostUserId check)
- **B2** ✅ Cabal invites authorization (callerId required, filter results)
- **B3** ✅ Video call token leak (return only caller's token)
- **B4** ✅ Shift pay validation (mini-game assigned to venue check)
- **B5** ✅ Realtime room JWT verification (all rooms verify tokens)
- **B6** ✅ SIWS message validation (full field-by-field parsing)
- **B7** ✅ Alphanumeric nonce (UUID hyphens removed)
- **B8** ✅ Base64 signedMessage decoding (decode before verification)
- **B31** ✅ Idempotency tracking (in-flight protection added)
- **B32** ✅ Top-up credit validation (mint/recipient/unit checks)

**Branch:** `fix/p1-security`  
**Commit:** `d2388ee` - "fix: P1 security fixes - authorization, token leaks, SIWS validation"

---

## P2 - Phase 1 Blockers (IN PROGRESS 🔄)

### Completed Items:

- **B9** ✅ Rooms serve contract schemas (already using contract/realtime/states.ts)
- **B10** ✅ Venue filterBy implementation (venueId filtering, entrance placement)
- **B11** ✅ Realtime tsconfig fix (useDefineForClassFields: false, include contract/realtime)
- **B12** ✅ Workers startup fix (Redis URL parsing, BullMQ queue names without colons)

**Branch:** `fix/p2-phase1`  
**Commits:**
- `c46b75a` - B11 tsconfig fix
- `8daa4b3` - B10 venue filterBy
- `55dd26e` - B12 workers Redis/BullMQ fix

### Remaining P2 Items:

- **B13** 🔄 Lottery roll issues (409 after character, 500 on second roll)
- **B14** 🔄 Auth response shapes (hasCharacter, careerId in responses)
- **B15** 🔄 POST without JSON body returns 500 (should be 4xx)
- **B16** 🔄 City room stub (events, toasts, DMs, call invites)
- **B17** 🔄 NPC state issues (IDs don't resolve, brains see no world)
- **B18** 🔄 Careers implementation (skill gates, level/XP storage, job checks)
- **B33** 🔄 Sit animation spot (spot anim not applied)
- **B34** 🔄 Config endpoint (/config lacks features, ETag, 426 check)
- **B35** 🔄 Move speed check (trips on normal jitter)
- **B36** 🔄 Seat rejection matching (add spotId, requestId to rejected message)

---

## Next Steps

1. **B13 - Lottery Roll** (Medium complexity)
   - Fix character detection logic (use characters table, not lottery check)
   - Add idempotency for ledger entries
   - Add lotteryRolled flag to user
   - Validate tribe/dream/trait IDs
   - Return proper status codes

2. **B14 - Auth Response Shapes** (Low complexity)
   - Add hasCharacter to auth responses
   - Add careerId to career apply response
   - Update /me endpoint

3. **B15 - POST Error Handling** (Low complexity)
   - Check err.statusCode in error handler
   - Return 4xx for client errors instead of 500

4. **B16-B18** - Complex items requiring more work:
   - City room event system
   - NPC brain improvements
   - Careers skill gates and XP system

5. **B33-B36** - Polish items for better UX

---

## Test Status

- All unit tests passing: **349/349** ✅
- Typecheck: **passing** ✅
- No regressions introduced

---

## Time Estimate for Remaining P2

- **B13-B15**: ~2-3 hours (straightforward fixes)
- **B16**: ~4-5 hours (city room events)
- **B17**: ~3-4 hours (NPC fixes)
- **B18**: ~4-5 hours (careers system)
- **B33-B36**: ~2-3 hours (polish items)

**Total remaining**: ~15-20 hours

---

## Notes

- P1 security fixes are production-ready
- B9 was already fixed (rooms using contract schemas)
- B11 was critical - realtime couldn't start without it
- B12 was critical - workers crashed immediately
- B10 enables multi-venue support (currently all join one room)
