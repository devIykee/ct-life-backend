# F1: Realtime Schemas Must Match Contract - EVIDENCE

## Status: ✅ FIXED

## Commit
- Hash: `8aaafad`
- Branch: `fix/test-isolation`
- Message: "fix: realtime schemas must match contract (F1)"

## Changes Made

### 1. Deleted Duplicate Schema File
- ❌ Deleted: `server/realtime/schemas.ts` (85 lines of duplicate definitions)
- ✅ All imports now use: `contract/realtime/states.ts`

### 2. Fixed Schema Imports
- `server/realtime/rooms/venue.ts`: Import from contract
- `server/realtime/rooms/city.ts`: Import from contract  
- `server/realtime/rooms/market.ts`: Import from contract
- `server/realtime/rooms/venue.test.ts`: Import from contract

### 3. Fixed NpcState Property Names
**Before (wrong):**
```typescript
npc.archetype = archetypeId;  // ❌ Wrong property name
npc.npcId = npcId;             // ❌ Doesn't exist in contract
```

**After (correct):**
```typescript
npc.archetypeId = archetypeId; // ✅ Matches contract
// NPCs keyed in MapSchema, no npcId property needed
npc.lineParams = new MapSchema<string>(); // ✅ Added missing field
```

### 4. Fixed PlayerState - Added `look` Field
**Before (wrong):**
```typescript
// look field was missing from PlayerState
```

**After (correct):**
```typescript
player.look = character.look; // ✅ string[7] array added
```

### 5. Fixed MarketState - Real CoinState MapSchema
**Before (wrong):**
```typescript
this.state = { ts: 0, placeholder: true }; // ❌ Placeholder
```

**After (correct):**
```typescript
this.state.coins = new MapSchema<CoinState>(); // ✅ Real schema
```

### 6. Removed Wrong Message Handler
**Before (wrong):**
```typescript
this.onMessage('welcome', (client) => {
  // ❌ welcome is server-to-client only, not client-to-server
});
```

**After (correct):**
```typescript
// ✅ Removed - welcome is sent by server on join, never received from client
```

### 7. Added CI Schema Check
**New file:** `tools/scripts/schema-check.ts`
- Scans for `@type(` decorators outside `contract/realtime/`
- Fails CI if duplicate schemas found
- Added to `package.json` as `schema:check` script

### 8. Added Schema Validation Tests
**New file:** `server/realtime/schemas.test.ts` (7 tests)
- PlayerState: all 15 fields including `look[7]`
- NpcState: `archetypeId`, `lineParams`, all state fields
- CityState: `online`, `mood`, `eventIds`, `metaId`
- CoinState: `coinId`, `ticker`, `priceMicros`, etc.
- MarketState: `coins` MapSchema
- VenueState: `players` and `npcs` MapSchemas
- Import verification test

## Test Results

### Schema Validation Tests
```
✓ server/realtime/schemas.test.ts > Realtime Schema Validation > PlayerState has all required fields from contract
✓ server/realtime/schemas.test.ts > Realtime Schema Validation > NpcState has all required fields from contract
✓ server/realtime/schemas.test.ts > Realtime Schema Validation > CityState has all required fields from contract
✓ server/realtime/schemas.test.ts > Realtime Schema Validation > CoinState has all required fields from contract
✓ server/realtime/schemas.test.ts > Realtime Schema Validation > MarketState has coins MapSchema
✓ server/realtime/schemas.test.ts > Realtime Schema Validation > VenueState has players and NPCs MapSchemas
✓ server/realtime/schemas.test.ts > Realtime Schema Validation > all schemas are imported from contract/realtime/

Test Files  1 passed (1)
     Tests  7 passed (7)
```

### Schema Check CI Gate
```
🔍 Scanning for duplicate schema classes...

✅ No schema duplicates found. All schemas in contract/realtime/.
```

### All Unit Tests
```
Test Files  42 passed (42)
     Tests  328 passed (328)
  Duration  40.07s
```

### All Gates Pass
```
✅ pnpm typecheck  - PASS
✅ pnpm lint       - PASS
✅ pnpm schema:check - PASS
✅ pnpm test:unit  - 328 tests PASS
```

## Contract Compliance Verified

| Schema | Field | Before | After | Status |
|--------|-------|--------|-------|--------|
| PlayerState | `look` | ❌ Missing | ✅ `string[7]` | Fixed |
| PlayerState | coordinates | ❌ `number` | ✅ `float32` | Fixed (contract) |
| NpcState | property names | ❌ `archetype`, `npcId` | ✅ `archetypeId`, keyed in map | Fixed |
| NpcState | `lineParams` | ❌ Missing | ✅ `MapSchema<string>` | Fixed |
| MarketState | `coins` | ❌ `{placeholder: true}` | ✅ `MapSchema<CoinState>` | Fixed |
| CoinState | All fields | ❌ Different from contract | ✅ Matches contract | Fixed |
| Message handlers | `welcome` | ❌ Client-to-server | ✅ Removed (server-to-client only) | Fixed |
| Schema source | Location | ❌ Duplicated in server/ | ✅ Single source in contract/ | Fixed |

## CI Protection Added

The `schema:check` gate prevents future drift:
- Scans entire codebase for `@type(` decorators
- Only `contract/realtime/` is allowed to define schemas
- Fails CI if duplicates found
- Runs on every commit

## Client Impact

**Before:** Client would receive incomplete/wrong data:
- Missing `look` cosmetic data
- Wrong NPC property names would cause decode errors
- Placeholder market data instead of real coin states
- Potential decode failures from type mismatches

**After:** Client receives complete, correct data:
- All fields present and typed correctly
- Clean encode/decode with no errors
- Ready for C# codegen from these schemas
