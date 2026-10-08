# P3 (Money) Progress Report

**Date**: 2026-10-08
**Status**: 2/5 completed

---

## Completed

### ✅ B20: Spot Trading - Slippage and Reserves Fix
**Commit**: `435e724`

**Issues Fixed**:
- Fixed reserves derivation from coin price so curve spot price matches before trade
- Corrected slippage calculation to use execution price (cashIn/unitsOut), not post-trade marginal
- Applied 1% buy/sell fees from market.json config
- Made slippage check one-sided (only worse prices fail)
- Made maxSlippageBps optional with 500 bps default
- Added feeCents and execution priceMicros to response
- Renamed cashDeltaCents to cashCents for contract alignment
- Added price check: reject dead coins and non-positive prices

**Files Changed**:
- `server/api/routes/markets.ts` - made maxSlippageBps optional
- `server/application/amm.ts` - clarified comment about reserve units
- `server/application/terminal-cafe.ts` - major fixes to reserves, slippage, fees

---

### ✅ B19: Payment Intents - Transaction Building and Status
**Commit**: `12b4cb9`

**Issues Fixed**:
- Built unsigned v0 transaction with proper blockhash and fee payer
- Calculated amount from pack priceUsdc in base units (integer string), not from Cash cents
- Added GET /v1/payments/intents/:id endpoint for status polling
- Return 410 PAYMENT_EXPIRED when intent expires
- Added tx, currency, cashCents, bonusBps to response
- Fixed topup cap to check USDC paid value, not credited Cash cents
- Rejected custom SKU until pricing rules defined
- Rejected non-USDC currencies until price feed implemented
- Removed unused formatBaseUnits function

**Files Changed**:
- `server/api/routes/payments.ts` - added GET endpoint
- `server/application/topup.ts` - major transaction building and amount fixes

---

## Remaining

### ⏳ B21: ORE Staking - Fix 500 Error and Replace Fixtures
**Priority**: P3 · money · ORE
**Estimate**: 1-2 hours

**Issues**:
- POST /ore/stake/tx returns 500
- Transaction has no blockhash/fee payer
- Returns message not full tx
- Board/me endpoints return fixtures
- Need v0 transaction, real data, status endpoint

---

### ⏳ B22: Predictions and Alpha Calls - Contract Alignment
**Priority**: P3 · money · needs Decisions D2 and D5
**Estimate**: 1-2 hours

**Issues**:
- GET /predictions returns empty array instead of open markets
- Wrong route for bets (POST /predictions vs POST /predictions/{id}/bets)
- Alpha calls expect strings not integers
- Top-up cap compares wrong units (Cash cents vs USDC paid)

---

### ⏳ B38: Perps - Payload Shapes and Settlement
**Priority**: P3 · money · perps
**Estimate**: 1-2 hours

**Issues**:
- Wrong response shapes (wrapped arrays, 201 status)
- Leverage max 25 instead of 20
- Insufficient margin uses FORBIDDEN not 402
- Liquidation doesn't store realized_cents
- No lossCents in liquidated event
- No dead coin check on open

---

## Summary

**Total P3 Tasks**: 5
**Completed**: 2 (40%)
**Remaining**: 3 (60%)

**Token Usage**: ~126k / 200k (63%)
**Commits Pushed**: 2

All completed fixes include:
- Full typecheck validation
- Proper error handling
- Contract alignment
- Clear commit messages with issue references
