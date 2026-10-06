# Helius Webhook Setup

The Helius Enhanced Webhooks feature sends program events from the on-chain `ct_escrow` program to the backend.

## Creating the Webhook

1. Go to https://dashboard.helius.dev/webhooks
2. Create a new **Enhanced Webhook**
3. Configure:
   - **Program Address**: `FKvuRNUxGgijeD8P4varsnzBiLduCWKMhSLQp5fQsMfz` (devnet ct_escrow)
   - **Webhook URL**: `https://your-backend.com/v1/webhooks/helius-program`
   - **Auth Header**: Set to the value of `HELIUS_WEBHOOK_SECRET` from your environment
   - **Events**: All (or at minimum: transaction confirmed)

4. Set the environment variable:
   ```bash
   export HELIUS_WEBHOOK_SECRET="your-secret-here"
   ```

## Authentication

Helius sends the `authHeader` you configured back in the `Authorization` header of every request. The backend verifies it using constant-time comparison.

**Security notes**:
- If `HELIUS_WEBHOOK_SECRET` is unset in staging or prod, all webhook requests are rejected (fail closed)
- In local/mock environments, the check is relaxed for development
- The comparison is constant-time to prevent timing attacks

## Testing

Run the webhook handler tests:
```bash
pnpm exec vitest run server/application/program-webhook.test.ts
```

To test with a real webhook delivery on devnet, use a tunnel service like ngrok:
```bash
ngrok http 3000
# Update webhook URL to: https://your-tunnel.ngrok.io/v1/webhooks/helius-program
# Trigger an on-chain transaction
# Check backend logs for the webhook delivery
```

## Idempotency

Webhook deliveries are idempotent on `(source='helius_program', signature)`. If Helius sends the same transaction twice, the second delivery returns `{status: 'duplicate'}` and does not process again.

## Processing

When a `Settled` or `Refunded` event is found in the transaction logs:
1. Look up the escrow row by on-chain session pubkey
2. Mark the escrow settled/refunded
3. Write in-game ledger rows (tip for creator, fee for treasury)
4. End the LiveKit room
5. Return `{status: 'settled' | 'refunded'}`

If no event is found, return `{status: 'ignored'}`.
