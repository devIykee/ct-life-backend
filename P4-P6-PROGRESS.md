# P4-P6 Progress Summary

**Date**: 2026-10-08  
**Status**: 1/6 completed, 5 remaining

---

## Completed

### ✅ B27: Venue Registry Sync
**Commit**: `3c676f9`  
**Files**: `contract/ids/venues.json`

**Issues Fixed**:
- Added all 8 missing venues from spots.json to venues.json
- Changed airdrop_farm to airdrop_fields to match spots.json
- Removed builder_hills (not in spots.json)
- Added: club_liquidity, conference_hall, ct_jail, hackathon_house, home, sybil_barn, the_trenches
- All venue IDs now exist in both files for consistent registry

---

## Remaining Tasks

### ⏳ B23: RTC Token Endpoint and Spaces (P4)
**Complexity**: HIGH  
**Estimate**: 2-3 hours

**Issues**:
- Add POST /v1/rtc/token endpoint for proximity voice, Space audio, call media
- Fix Space response shapes (uuid ids not space:{uuid}, speakerIds/handIds arrays, unwrapped)
- Add POST /v1/webhooks/livekit route
- Send space_update events on city room

**Files to modify**:
- `server/api/routes/rtc.ts` (new file)
- `server/api/routes/spaces.ts`
- `server/application/spaces.ts`
- `server/api/routes/webhooks.ts` (add LiveKit webhook)

---

### ⏳ B24: Paid Calls (P4)
**Complexity**: HIGH  
**Estimate**: 2-3 hours  
**Dependencies**: Needs Decision D1 on fee model

**Issues**:
- Add PUT /creator endpoint
- Fix POST /paid-calls to return tx for signing (not immediate debit)
- Use server-computed call duration
- Add refund job for missed calls
- Resolve program keys properly

**Files to modify**:
- `server/api/routes/creator.ts` (new)
- `server/api/routes/paid-calls.ts`
- `server/application/paid-calls.ts`
- `server/workers/` (new refund worker)

---

### ⏳ B25: DMs, Tips, Feed Block Checks (P4)
**Complexity**: MEDIUM  
**Estimate**: 1-2 hours

**Issues**:
- Add mutual block checks to DMs and tips
- Filter blocked users from feed
- Fix GET /dms to not require peerUserId
- Return unwrapped arrays
- Add recipient existence check
- Use 200 not 201

**Files to modify**:
- `server/api/routes/dms.ts`
- `server/api/routes/tips.ts`
- `server/api/routes/feed.ts`
- `server/application/dms.ts`
- `server/application/tips.ts`
- `server/application/feed.ts`

---

### ⏳ B26: Homes System (P5)
**Complexity**: VERY HIGH  
**Estimate**: 4-6 hours

**Issues**:
- Fix GET /homes to return contract Home shape
- Add home room implementation with:
  - Furniture placement system
  - Visitor caps and privacy modes
  - Rent payment integration
  - Room state sync

**Files to modify**:
- `server/api/routes/homes.ts`
- `server/application/homes.ts`
- `server/realtime/rooms/home.ts` (new)

---

### ⏳ B29: Local Setup Fixes (P6)
**Complexity**: MEDIUM  
**Estimate**: 1-2 hours

**Issues**:
- Fix Docker compose with real image tags
- Add Up Migration comment to 060
- Handle empty LLM_MODEL gracefully
- Fix typecheck errors
- Fix bot configuration

**Files to modify**:
- `docker-compose.yml`
- `db/migrations/060-*`
- `server/shared/config/config.ts`
- Various typecheck fixes

---

## Summary Statistics

- **Total P3 Tasks**: 5 ✅ (100% complete)
- **Total P4-P6 Tasks**: 6
  - Completed: 1 (17%)
  - Remaining: 5 (83%)
- **Token Usage**: 123k / 200k (62%)
- **Commits Pushed**: 6 total (5 P3 + 1 P4-P6)

## Complexity Assessment

**Can Complete Now** (~4-5 hours):
- ✅ B27 (done)
- B25 (1-2h)
- B29 (1-2h)

**High Complexity** (~8-12 hours):
- B23 (2-3h)
- B24 (2-3h, needs D1)
- B26 (4-6h)

## Recommendations

Given token budget (77k remaining) and task complexity:

1. **Complete B25** (DMs/tips/feed blocks) - Most straightforward
2. **Complete B29** (Local setup) - Improves dev experience
3. **Partial B23** (Add RTC endpoint, defer Space shape changes)
4. **Document B24 & B26** as requiring design decisions and significant work

Alternatively, stop here and let human decide priority for remaining complex tasks.

---

**Session Progress**: 6/11 P3-P6 tasks complete (55%)  
**Latest Commit**: `3c676f9`  
**Branch**: main
