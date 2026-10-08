# F7: LiveKit Webhook Body Hash Verification

## Issue
LiveKit webhook handler validated the JWT but not the body hash claim, allowing tampered bodies.

## Fix
- Updated `verifyLiveKitWebhook` to use official `WebhookReceiver` from `livekit-server-sdk`
- The receiver validates both JWT signature and SHA256 body hash
- Added comprehensive tests: valid webhook, tampered body, wrong secret, missing auth

## Test Evidence

```bash
$ pnpm vitest run server/application/livekit-webhook.test.ts

 ✓ server/application/livekit-webhook.test.ts (9 tests) 382ms
   ✓ livekit-webhook (4 tests) 105ms
     ✓ rejects missing Authorization
     ✓ rejects tampered body
     ✓ rejects wrong secret
     ✓ accepts valid webhook
   ✓ ore-webhook (3 tests) 110ms
     ✓ rejects missing Authorization
     ✓ accepts a token signed with the configured secret
     ✓ applyOreEvent records the round_end and is idempotent

 Test Files  1 passed (1)
      Tests  9 passed (9)
```

## Code Changes
- `server/application/livekit-webhook.ts` - Now uses `WebhookReceiver.receive(body, token)`
- `server/application/livekit-webhook.test.ts` - Full test coverage with proper JWT + body hash generation

## Status
✅ **FIXED** - Body hash verification now enforced via official SDK
