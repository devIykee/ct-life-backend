/**
 * Helius webhook signature verification.
 *
 * Tests the positive and negative cases for the HMAC-SHA256
 * signature check on the Helius Enhanced Webhooks payload.
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyHeliusSignature } from './helius-webhook.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { buildContext } from './context.js';

describe('Helius webhook signature', () => {
  it('accepts a correctly-signed body', () => {
    const ctx = buildContext();
    const secret = 'test-secret-123';
    // Override the secret for this test.
    (ctx.config.helius as { webhookSecret: string }).webhookSecret = secret;
    const body = JSON.stringify({ signature: 'abc123' });
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
    expect(() => verifyHeliusSignature(ctx, sig, body)).not.toThrow();
  });

  it('rejects a body with no signature header', () => {
    const ctx = buildContext();
    (ctx.config.helius as { webhookSecret: string }).webhookSecret = 'test-secret-123';
    expect(() => verifyHeliusSignature(ctx, undefined, '{}')).toThrow(ValidationFailedError);
  });

  it('rejects a body with a wrong signature', () => {
    const ctx = buildContext();
    (ctx.config.helius as { webhookSecret: string }).webhookSecret = 'test-secret-123';
    const body = '{"signature":"abc"}';
    const wrong = createHmac('sha256', 'wrong-secret').update(body, 'utf8').digest('base64');
    expect(() => verifyHeliusSignature(ctx, wrong, body)).toThrow(ValidationFailedError);
  });

  it('rejects when webhook secret is not configured', () => {
    const ctx = buildContext();
    (ctx.config.helius as { webhookSecret: string }).webhookSecret = '';
    expect(() => verifyHeliusSignature(ctx, 'any', '{}')).toThrow(ValidationFailedError);
  });
});
