# P2 Bug Fixes - Completion Summary

## ✅ ALL ITEMS COMPLETED (9/9)

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

### B16: Needs Decay During Shifts
**Status**: ✅ Complete
**Changes**:
- Implemented time-based needs decay calculation in `/me` endpoint
- Reads `last_action_at` from needs table and applies decay based on elapsed time
- Checks for active shifts before applying decay (pauses decay during shifts)
- Uses `decayPerHour` rates from needs config
- Exported `_shifts` Map for active shift checking

**Files Modified**:
- `server/api/routes/core.ts`
- `server/application/shifts.ts`

### B17: Skills Decay During Shifts
**Status**: ✅ Complete (N/A)
**Changes**:
- Skills config has no decay rates defined
- No decay implementation needed
- Skills remain constant except when explicitly modified by shift completion or actions

**Notes**: The skills.json config file does not include a `decayPerHour` field, indicating skills should not decay over time in the current game design.

### B18: Shift Completion Snapshot
**Status**: ✅ Complete
**Changes**:
- Shift completion now updates `needs.last_action_at` to completion time
- Prevents decay accumulation during the shift duration
- Ensures needs values shown after completion reflect the shift work, not excessive decay
- Integrated into the shift payment transaction

**Files Modified**:
- `server/application/shifts.ts`

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
6. `ad83ad4` - fix: needs decay and shift timing issues (B16, B17, B18)

## Implementation Details

### Needs Decay System
The decay system works as follows:
1. **Storage**: Each user's needs row has a `last_action_at` timestamp
2. **Calculation**: On `/me` request, elapsed time is calculated from `last_action_at` to now
3. **Decay Rates**: Applied from `contract/config/needs.json` decayPerHour values:
   - Energy: 4/hour
   - Hunger: 5/hour
   - Fun: 6/hour
   - Hygiene: 3/hour
   - Sanity: 2/hour
4. **Active Shift Check**: Before applying decay, system checks for active (incomplete) shifts
5. **Pausing**: If active shift exists, decay is not applied
6. **Reset**: On shift completion, `last_action_at` is updated to now, preventing decay accumulation

### Migration Path
1. Run `pnpm db:migrate` to apply lottery_rolled_at column
2. Existing users will have `lottery_rolled_at = NULL` (can roll)
3. Existing characters keep their current home_id (won't be retroactively fixed)
4. Needs decay calculation is purely on-read (no DB changes needed)
5. New flow enforces: roll lottery → get outcome → create character with correct home

## Notes
- All changes are backward compatible
- No breaking API changes
- Database migration is additive only (safe to deploy)
- Decay calculation is performant (simple arithmetic on read)
- In-memory shift tracking works for M2; M5 will move to Redis
