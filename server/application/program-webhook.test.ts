/**
 * Unit tests for the Helius program-event webhook.
 *
 * Run: `pnpm exec vitest run server/application/program-webhook.test.ts`
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
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
  it('accepts a valid Authorization header', () => {
    const ctx = buildCtx();
    const body = '{"signature":"abc"}';
    expect(() => verifyProgramWebhookSignature(ctx, 'fake-helius-secret', body)).not.toThrow();
  });

  it('rejects a missing Authorization header', () => {
    const ctx = buildCtx();
    expect(() => verifyProgramWebhookSignature(ctx, undefined, '{}')).toThrow(/Request body or params failed validation/);
  });

  it('rejects a wrong Authorization header', () => {
    const ctx = buildCtx();
    expect(() => verifyProgramWebhookSignature(ctx, 'wrong-secret', 'body')).toThrow(/Caller is not allowed to perform this action/);
  });

  it('rejects empty Authorization header', () => {
    const ctx = buildCtx();
    expect(() => verifyProgramWebhookSignature(ctx, '', 'body')).toThrow(/Request body or params failed validation/);
  });

  it('fails closed when secret is unset in staging', () => {
    const ctx = {
      ...buildCtx(),
      config: { helius: { webhookSecret: '' }, appEnv: 'staging' as const },
    } as unknown as Parameters<typeof verifyProgramWebhookSignature>[0];
    expect(() => verifyProgramWebhookSignature(ctx, 'any', 'body')).toThrow(/Caller is not allowed to perform this action/);
  });

  it('allows missing secret in local for development', () => {
    const ctx = {
      ...buildCtx(),
      config: { helius: { webhookSecret: '' }, appEnv: 'local' as const },
    } as unknown as Parameters<typeof verifyProgramWebhookSignature>[0];
    expect(() => verifyProgramWebhookSignature(ctx, undefined, 'body')).not.toThrow();
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
    // First delivery with no Authorization header is rejected.
    await expect(
      handleProgramWebhook(ctx, undefined, JSON.stringify(payload), payload),
    ).rejects.toThrow(/Request body or params failed validation/);

    // Now replay with valid Authorization header.
    const body = JSON.stringify(payload);
    const authHeader = 'fake-helius-secret';
    const ok = await handleProgramWebhook(ctx, authHeader, body, payload);
    expect(ok.status).toBe('ignored');
    const dup = await handleProgramWebhook(ctx, authHeader, body, payload);
    expect(dup.status).toBe('duplicate');
  });
});