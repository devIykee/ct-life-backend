# F1: Realtime Schemas Must Match Contract

## Finding

Audit reported that `server/realtime/schemas.ts` differed from `contract/realtime/*` with missing fields and type mismatches.

## Investigation

Checked all realtime room implementations and found they **already import from `contract/realtime/states.ts`**:

- `server/realtime/rooms/city.ts:15` - imports `CityState` from contract
- `server/realtime/rooms/market.ts:10` - imports `MarketState, CoinState` from contract
- `server/realtime/rooms/venue.ts:44` - imports `VenueState, NpcState, PlayerState` from contract
- `server/realtime/rooms/space.ts:12` - imports `SpaceState, SpeakerState` from contract
- `server/realtime/rooms/video-call.ts:10` - imports `VideoCallState` from contract

No duplicate schema classes exist in `server/realtime/`.

## Schema Verification

```bash
$ pnpm vitest run server/realtime/schemas.test.ts
 ✓ server/realtime/schemas.test.ts (14 tests) 173ms
   ✓ PlayerState has all required fields from contract
   ✓ NpcState has all required fields from contract
   ✓ CityState has all required fields from contract
   ✓ CoinState has all required fields from contract
   ✓ MarketState has coins MapSchema
   ✓ VenueState has players and NPCs MapSchemas
   ✓ HomeState has all required fields from contract
   ✓ SpeakerState has all required fields from contract
   ✓ SpaceState has all required fields from contract
   ✓ VideoCallState has all required fields from contract
   ✓ all schemas are imported from contract/realtime/
   ✓ PlayerState coordinates use float32 types
   ✓ PlayerState look array has length 7
   ✓ NpcState has lineParams MapSchema

 Test Files  1 passed (1)
      Tests  14 passed (14)
```

## Schema Coverage

All contract schemas are present and correctly typed:

- ✅ `PlayerState` - has `look: string[]` (7 elements), float32 x/z/rotY
- ✅ `NpcState` - has `lineParams: MapSchema<string>`, all properties match spec
- ✅ `CoinState` - all fields match spec
- ✅ `MarketState` - has `coins: MapSchema<CoinState>`
- ✅ `CityState` - all fields match spec
- ✅ `HomeState` - exists in contract
- ✅ `SpeakerState` - exists in contract (M4)
- ✅ `SpaceState` - exists in contract (M4)
- ✅ `VideoCallState` - exists in contract (M4)

## Welcome Message

The audit reported `welcome` was wrongly registered as client-to-server. Verified:

- No `onMessage('welcome')` handler exists in any room
- `welcome` is **only sent server-to-client** in `onJoin` methods:
  - `city.ts:39` - `client.send('welcome', {serverNow, instanceId})`
  - `venue.ts:164` - `client.send('welcome', {serverNow, instanceId})`
  - `space.ts:39` - `client.send('welcome', {serverNow, instanceId})`
  - `video-call.ts:36` - `client.send('welcome', {serverNow, instanceId})`

## Status

✅ **NOT A DEFECT** - The server already imports all schemas from `contract/realtime/states.ts`. There are no duplicates and all fields match the spec. The `welcome` message is correctly server-to-client only.

The test suite verifies field-for-field matching and passes. The architecture already follows the single-source-of-truth pattern requested by the audit.
