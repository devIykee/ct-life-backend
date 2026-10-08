# P2 Bug Fixes - Completion Summary

## Completed Items

### B13: Lottery and Character Creation Flow
**Status**: ✅ Complete
**Changes**:
- Added `lottery_rolled_at` column to users table
- Fixed roll-after-character bug: now checks `lottery_rolled_at` instead of character existence
- Character creation validates tribe/dream/trait/look IDs against contract configs
- Character gets correct home_id from lottery outcome (penthouse/skyrise/parents_basement)
- Added `lotteryRolled` flag to `/me` response
- Validates that lottery is rolled before character creation

**Files Modified**:
- `db/migrations/1700000070000_add_lottery_rolled.sql` (new)
- `server/application/lottery.ts`
- `server/application/character.ts`
- `server/api/routes/core.ts`

### B14: Auth Response Shapes
**Status**: ✅ Complete
**Changes**:
- Added `checkHasCharacter()` helper to AuthService
- Auth responses (verify, devAuth) now return actual `hasCharacter` status
- Added `hasCharacter` to `/me` endpoint flags
- Career apply already returns `careerId` as 'id' field (no change needed)

**Files Modified**:
- `server/application/auth.ts`
- `server/api/routes/core.ts`

### B15: POST Without JSON Body
**Status**: ✅ Complete
**Changes**:
- Enhanced `toErrorEnvelope` to check for `err.statusCode`
- Fastify parser errors (4xx) now return VALIDATION_FAILED instead of 500
- Properly surfaces 400 Bad Request for malformed JSON

**Files Modified**:
- `server/shared/infra/error-envelope.ts`

### B33: Sit Animation Spot
**Status**: ✅ Complete
**Changes**:
- Venue sit handler now uses `spot.anim` from config if present
- Falls back to kind-based animation if `spot.anim` not specified
- Allows spots to define custom animations in spots.json

**Files Modified**:
- `server/realtime/rooms/venue.ts`

### B36: Seat Rejection Matching
**Status**: ✅ Complete
**Changes**:
- Added optional `requestId` to SitMessage schema
- All sit rejection messages include `spotId` and `requestId`
- Enables client-side matching of rejections to requests

**Files Modified**:
- `server/realtime/rooms/venue.ts`

### B34: Config Endpoint Improvements
**Status**: ✅ Complete
**Changes**:
- Added ETag support (returns 304 Not Modified when client cache valid)
- Added `x-client-version` header check, returns 426 Upgrade Required if outdated
- Added `spots` and `emotes` to config response
- Added Cache-Control header (5 min)
- Implemented semver comparison helper

**Files Modified**:
- `server/api/routes/core.ts`

## Remaining Items (Deferred)

### B16: Needs Decay During Shifts
**Status**: ⚠️ Requires Investigation
**Issue**: Needs shouldn't decay while user has an active shift
**Blocker**: Current architecture returns needs directly from DB without decay calculation. The contract mentions decay should be computed on-read based on `last_action_at`, but this isn't implemented in `loadMe()` yet.
**Next Steps**:
1. Implement decay calculation in `/me` endpoint
2. Track active shifts (currently in-memory, may need Redis)
3. Pause decay when active shift exists
4. Consider M5 shift storage strategy

### B17: Skills Decay During Shifts
**Status**: ⚠️ Similar to B16
**Issue**: Skills shouldn't decay during active shifts
**Next Steps**: Same as B16 - requires decay implementation first

### B18: Shift Completion Snapshot
**Status**: ⚠️ Depends on B16/B17
**Issue**: Shift completion should use needs/skills at completion time
**Next Steps**: After B16/B17 decay is implemented, snapshot values at shift completion

## Test Results
- ✅ All typechecks pass
- ⚠️ Unit tests: 2 pre-existing failures in space.test.ts (unrelated to P2 work)
- ⚠️ Integration tests not run (would require full environment setup)

## Git Commits
1. `8377ffb` - fix: lottery roll and character creation issues (B13)
2. `ab0bc71` - fix: auth response shapes - add hasCharacter (B14)
3. `04be25b` - fix: POST without JSON body returns 4xx instead of 500 (B15)
4. `ce429cc` - fix: sit animation and seat rejection matching (B33, B36)
5. `415d355` - fix: config endpoint improvements (B34)

## Recommendations

### B16-B18 Implementation Strategy
These items are interconnected and require:
1. **Decay Implementation**: Implement time-based decay calculation in `/me` endpoint using `last_action_at` from needs/skills tables
2. **Active Shift Tracking**: Add mechanism to check if user has active shift (query in-memory `_shifts` Map or move to Redis)
3. **Pause Logic**: When decay is calculated, check for active shift and skip decay if one exists
4. **Snapshot**: On shift completion, record the needs/skills values at that moment

**Estimated Effort**: 4-6 hours (includes testing and edge cases)

### Migration Path
1. Run `pnpm db:migrate` to apply lottery_rolled_at column
2. Existing users will have `lottery_rolled_at = NULL` (can roll)
3. Existing characters keep their current home_id (won't be retroactively fixed)
4. New flow enforces: roll lottery → get outcome → create character with correct home

## Notes
- All changes are backward compatible
- No breaking API changes
- Database migration is additive only (safe to deploy)
- B16-B18 require more architectural work and should be prioritized in next sprint
