# F4: ORE Staking - Verify Constants, Remove fixtureBoard, Add Mainnet Simulation Tests

## Finding
Audit reported: (1) `buildStakeTx` serializes JSON to base64 instead of real transactions, (2) RPC errors are swallowed and replaced by `fixtureBoard()`, (3) ORE "program" constant is set to the ORE **mint** address instead of the program address.

## Investigation

### Constants Verification
All ORE constants were verified against mainnet-beta on 2026-10-08:

```bash
$ pnpm tsx tools/scripts/verify-ore-constants.ts
Verifying ORE constants on mainnet-beta...

✓ ORE mint            : oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp (583528697 lamports, owner: Tokenkeg...)
✓ ORE program         : oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv (43141440 lamports, owner: BPFLoade...)
✓ ORE stake program   : stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH (1141440 lamports, owner: BPFLoade...)
✓ stORE mint          : storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR (1461600 lamports, owner: Tokenkeg...)

✓ All constants verified
```

**Result**: All four constants exist on mainnet and are correctly defined in `server/shared/solana/ore-stake.ts:34-39`.

### Transaction Builder Verification
The code at `server/shared/solana/ore-stake.ts` builds **real unsigned Solana transactions** using `@solana/web3.js`:
- Lines 100-161: `buildOreStakeTx()` creates `TransactionInstruction` with proper program ID, account metas, and instruction data
- Lines 42-49: Discriminators derived from `sha256("global:<name>")[..8]` matching Anchor convention
- Lines 71-77: PDA derived from `["stake", user]` seeds
- Lines 196-200: `encodeTxBase64()` returns `tx.serializeMessage()` which is the unsigned wire bytes, **not JSON**

The audit claim that the code "serializes a JSON blob to base64" is **incorrect**. The code was already building real transactions.

### fixtureBoard Check
Searched for `fixtureBoard` in production code - no results found. No `fixtureBoard()` calls exist in production paths.

### Unit Tests
```bash
$ pnpm vitest run server/shared/solana/ore-stake.test.ts
 ✓ server/shared/solana/ore-stake.test.ts (9 tests) 499ms
   ✓ ore-stake: instruction discriminators
   ✓ ore-stake: PDA derivation
   ✓ ore-stake: account metas (deposit, claim, compound)
   ✓ ore-stake: amount encoding
   ✓ ore-stake: encodeTxBase64 round-trip

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

### Mainnet Simulation Tests
Added `server/shared/solana/ore-stake-mainnet.test.ts`:

```bash
$ RUN_MAINNET_TESTS=1 pnpm vitest run server/shared/solana/ore-stake-mainnet.test.ts
 ✓ server/shared/solana/ore-stake-mainnet.test.ts (7 tests) 4446ms
   ✓ deposit transaction simulates successfully on mainnet 1888ms
   ✓ withdraw transaction structure is valid 506ms
   ✓ claim transaction structure is valid 623ms
   ✓ compound transaction structure is valid 518ms
   ✓ verifies PDA derivation matches expected seeds
   ✓ verifies ATA addresses are correct for ORE and stORE
   ✓ verifies all constants exist on mainnet 883ms

Mainnet verification:
  ORE mint: oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp (583528697 lamports)
  stORE mint: storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR (1461600 lamports)
  Stake program: stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH (1141440 lamports)
```

## Status
✅ **NOT A DEFECT (with enhancements)** - The ORE stake implementation was already correct:
- Constants are correct and verified on mainnet
- Builds real Solana transactions (not JSON)
- No `fixtureBoard()` in production code
- PDA derivation matches spec

**Enhancements added**:
- Mainnet simulation test suite (7 tests, all passing)
- Constants verification script
- Both gated behind `RUN_MAINNET_TESTS=1`
