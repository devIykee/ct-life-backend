# Audit Remediation Plan

**Branch**: `fix/audit-remediation`
**Current state**: 19 files modified, 5 commits staged, typecheck passes, 4 test failures (database isolation)

## Status Summary

| Item | Description | Status | Evidence Required |
|------|-------------|--------|-------------------|
| F1 | Realtime schema contract drift | NOT STARTED | Server imports from contract/, CI check |
| F2 | REST routes vs contract | NOT STARTED | Route reconciliation test, OpenAPI sync |
| F3 | GET /v1/config completeness | NOT STARTED | Serves all spec files, test validates keys |
| F4 | ORE staking real transactions | **PARTIAL** (ported builders exist) | Mainnet simulation, constants verified |
| F5 | Cosmetic NFTs real minting | NOT STARTED | Real Core mint or disabled |
| F6 | Helius webhook auth | **PARTIAL** (HMAC code exists) | Fix to Authorization header, constant-time compare |
| F7 | LiveKit webhook verification | NOT STARTED | Use WebhookReceiver with body hash |
| F8 | ct_escrow spec compliance | **PARTIAL** (deployed, needs verification) | PDA seeds, open_session fee calc, tests |
| F9 | Dev auth guard | NOT STARTED | APP_ENV gating, startup check |
| F10 | Remove stubs from production | NOT STARTED | llm-npcs, x-link, predictions |
| F11 | Error registry and gates | **PARTIAL** (typecheck passes, test failures) | Error codes in contract, test isolation |
| F12 | Worker double-run prevention | NOT STARTED | Redis locks or BullMQ job IDs, test |

## Pre-work (CRITICAL)

### Database Isolation (F11 blocker)
**Status**: Test utility created (`server/shared/db/test-db.ts`), not integrated

**Problem**: 
- Tests use dev DB directly with 5 leagues, 7,974 users
- `DELETE FROM leagues` causes foreign key violations and deadlocks
- 4 test failures in boards.test.ts and leagues.test.ts

**Solution**:
1. Integrate `test-db.ts` into test setup
2. Each test run creates a temporary schema
3. Tests only touch their own schema
4. Never delete from shared dev tables

## Work Order

Execute in this exact order to avoid dependency issues:

1. **F11 (database isolation)** — unblocks testing
2. **F1 (realtime schemas)** — contract foundation
3. **F8 (ct_escrow)** — verify audit work already done
4. **F4 (ORE)** — verify audit work already done
5. **F6 (Helius webhook)** — fix existing implementation
6. **F2, F3** — REST contract compliance
7. **F5, F7, F9, F10, F12** — remaining items
8. **Final gates** — all tests pass, docs updated

## Work Already Done (preserve)

- ORE stake builders: `server/shared/solana/ore-stake.ts` + tests (real discriminators, PDA, account layout)
- ct_escrow fixes: PDA seeds corrected, settlement wired
- Helius webhook: `program-webhook.ts` with HMAC verification
- All typecheck clean

## Evidence Template

For each fix:
```
## FX: <title>

**Lead verified**: <yes/no + why>

**Changes**:
- File:line — description

**Test output**:
```
<paste command + result>
```

**Commit**: <hash>
```
