/**
 * Unit tests for the Helius program-event webhook.
 *
 * Run: `pnpm exec vitest run server/application/program-webhook.test.ts`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { runInTransaction } from '../shared/db/uow.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { createDb } from '../shared/db/pool.js';
import {
  handleProgramWebhook,
  verifyProgramWebhookSignature,
  type ProgramWebhookPayload,
} from './program-webhook.js';

const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=`;

loadDotenv({ path: process.cwd() + '/.env' });

beforeAll(() => {
  process.env.APP_ENV ??= 'local';
  process.env.NODE_ENV ??= 'development';
  process.env.LOG_LEVEL ??= 'warn';
  process.env.DATABASE_URL ??= 'postgres://ctlife:ctlife@localhost:5434/ctlife';
  process.env.REDIS_URL ??= 'redis://localhost:6381';
  process.env.JWT_PRIVATE_KEY ??= FAKE_PKCS8;
  process.env.JWT_PUBLIC_KEY ??= FAKE_SPKI;
  process.env.HELIUS_API_KEY ??= 'fake-helius-key';
  process.env.HELIUS_WEBHOOK_SECRET ??= 'fake-helius-secret';
  process.env.HELIUS_RPC_URL_DEVNET ??= 'https://api.devnet.solana.com';
  process.env.HELIUS_RPC_URL_MAINNET ??= 'https://api.mainnet-beta.solana.com';
  process.env.TREASURY_PUBKEY_DEVNET ??= '11111111111111111111111111111111';
  process.env.SETTLE_AUTHORITY_KEYPAIR_DEVNET ??= '11111111111111111111111111111111';
  process.env.ADMIN_KEYPAIR_DEVNET ??= '11111111111111111111111111111111';
  process.env.LIVEKIT_URL ??= 'ws://localhost:7880';
  process.env.LIVEKIT_API_KEY ??= 'devkey';
  process.env.LIVEKIT_API_SECRET ??= 'devsecret_please_change';
  process.env.LIVEKIT_WEBHOOK_SECRET ??= 'fake-livekit-secret';
  process.env.S3_ACCESS_KEY ??= 'minioadmin';
  process.env.S3_SECRET_KEY ??= 'minioadmin';
  _resetConfigForTests();
});

afterAll(async () => {
  await createDb().close();
});

function buildCtx() {
  // The handleProgramWebhook helper accesses ctx.db + ctx.config.
  // We pass a thin stub so the test is hermetic.
  return {
    db: createDb(),
    config: {
      helius: { webhookSecret: 'fake-helius-secret' },
      appEnv: 'local' as const,
    },
    livekit: {
      endRoom: async () => {
        /* noop */
      },
    },
  } as unknown as Parameters<typeof handleProgramWebhook>[0];
}

describe('program-webhook: signature verification', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const ctx = buildCtx();
    const body = '{"signature":"abc"}';
    const expected = require('node:crypto')
      .createHmac('sha256', 'fake-helius-secret')
      .update(body, 'utf8')
      .digest('base64');
    expect(() => verifyProgramWebhookSignature(ctx, expected, body)).not.toThrow();
  });

  it('rejects a missing signature header', () => {
    const ctx = buildCtx();
    expect(() => verifyProgramWebhookSignature(ctx, undefined, '{}')).toThrow();
  });

  it('rejects a wrong signature', () => {
    const ctx = buildCtx();
    expect(() => verifyProgramWebhookSignature(ctx, 'wrong', expected)).toThrow();
  });
});

describe('program-webhook: idempotent ingest', () => {
  it('returns duplicate on the second delivery with the same signature', async () => {
    const ctx = buildCtx();
    const sig = `dup-test-${Date.now()}`;
    const payload: ProgramWebhookPayload = {
      signature: sig,
      accountKeys: [],
      logMessages: ['Program log: ignore'],
    };
    // First delivery with no signature header is rejected (signature required).
    await expect(
      handleProgramWebhook(ctx, undefined, JSON.stringify(payload), payload),
    ).rejects.toThrow();

    // Now replay with a valid signature.
    const body = JSON.stringify(payload);
    const crypto = await import('node:crypto');
    const sigHeader = crypto.createHmac('sha256', 'fake-helius-secret').update(body).digest('base64');
    const ok = await handleProgramWebhook(ctx, sigHeader, body, payload);
    expect(ok.status).toBe('ignored');
    const dup = await handleProgramWebhook(ctx, sigHeader, body, payload);
    expect(dup.status).toBe('duplicate');
  });
});