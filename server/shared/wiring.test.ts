/**
 * Wiring tests for server/shared.
 *
 * These hit the real local Postgres and Redis that `pnpm dev:up`
 * brings up. They prove the composition wiring is end-to-end correct:
 * config → db pool → UoW → ledger insert, and config → redis →
 * idempotency reserve/complete/replay.
 *
 * Run: pnpm vitest run server/shared
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { _resetConfigForTests, loadConfig } from './config/config.js';
import { createDb, _resetDbForTests } from './db/pool.js';
import { runInTransaction } from './db/uow.js';
import { createRedis, _resetRedisForTests } from './redis/client.js';
import { RedisIdempotencyStore } from './infra/idempotency.js';
import { uuidv7 } from './domain/uuid.js';

const TEST_USER_ID = uuidv7();

loadDotenv({ path: process.cwd() + '/.env' });

beforeAll(() => {
  // Ensure required env vars are set. The dev .env already does this.
  process.env.APP_ENV = process.env.APP_ENV ?? 'local';
  process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'postgres://ctlife:ctlife@localhost:5434/ctlife';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6381';
  process.env.JWT_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY ?? FAKE_PKCS8;
  process.env.JWT_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY ?? FAKE_SPKI;
  process.env.HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? 'fake-helius-key';
  process.env.HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET ?? 'fake-helius-secret';
  process.env.HELIUS_RPC_URL_DEVNET =
    process.env.HELIUS_RPC_URL_DEVNET ?? 'https://api.devnet.solana.com';
  process.env.HELIUS_RPC_URL_MAINNET =
    process.env.HELIUS_RPC_URL_MAINNET ?? 'https://api.mainnet-beta.solana.com';
  process.env.TREASURY_PUBKEY_DEVNET =
    process.env.TREASURY_PUBKEY_DEVNET ?? '11111111111111111111111111111111';
  process.env.SETTLE_AUTHORITY_KEYPAIR_DEVNET =
    process.env.SETTLE_AUTHORITY_KEYPAIR_DEVNET ?? '11111111111111111111111111111111';
  process.env.ADMIN_KEYPAIR_DEVNET =
    process.env.ADMIN_KEYPAIR_DEVNET ?? '11111111111111111111111111111111';
  process.env.LIVEKIT_URL = process.env.LIVEKIT_URL ?? 'ws://localhost:7880';
  process.env.LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? 'devkey';
  process.env.LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? 'devsecret_please_change';
  process.env.LIVEKIT_WEBHOOK_SECRET = process.env.LIVEKIT_WEBHOOK_SECRET ?? 'fake-livekit-secret';
  process.env.S3_ACCESS_KEY = process.env.S3_ACCESS_KEY ?? 'minioadmin';
  process.env.S3_SECRET_KEY = process.env.S3_SECRET_KEY ?? 'minioadmin';
  _resetConfigForTests();
  _resetDbForTests();
  _resetRedisForTests();
});

afterAll(async () => {
  await createDb().close();
  await createRedis().close();
});

describe('config', () => {
  it('loads from process.env with sensible defaults', () => {
    const cfg = loadConfig();
    expect(cfg.appEnv).toBe('local');
    expect(cfg.rateLimits.restPerUserPerSec).toBe(20);
    expect(cfg.jwt.accessTtlSec).toBe(15 * 60);
    expect(cfg.jwt.refreshTtlSec).toBe(30 * 24 * 60 * 60);
  });
});

describe('db pool + UoW', () => {
  it('connects, runs SERIALIZABLE, commits, balances reflect ledger', async () => {
    const db = createDb();
    // Insert a test user (clean up after).
    const wallet = `Wiring${Date.now().toString().padStart(30, '0')}`;
    await runInTransaction(async (client) => {
      await client.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [TEST_USER_ID, wallet]);
    });
    // The append-only ledger write: pay 5000 cents cash with the same
    // UoW (so the test is one logical transaction, then a separate
    // commit for the cash insert).
    await runInTransaction(async (client) => {
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, idempotency_ref)
         VALUES ($1, 5000, 'cash', 'wiring_test', $2)`,
        [TEST_USER_ID, `wiring-${Date.now()}`],
      );
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 5000)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + 5000`,
        [TEST_USER_ID],
      );
    });
    const r = await db.withConnection((c) =>
      c.query<{ cash_cents: string }>('SELECT cash_cents FROM balances WHERE user_id = $1', [
        TEST_USER_ID,
      ]),
    );
    expect(Number(r.rows[0]?.cash_cents)).toBe(5000);
  });
});

describe('redis idempotency', () => {
  it('reserves, completes, replays the same body', async () => {
    const r = createRedis();
    const store = new RedisIdempotencyStore(r.main);
    const user = uuidv7();
    const key = `k-${Date.now()}`;
    const bodyHash = 'h1';
    const first = await store.reserve(user, key, bodyHash);
    expect(first.acquired).toBe(true);
    if (first.acquired) {
      await store.complete(user, key, first.lockToken, {
        status: 201,
        headers: { 'content-type': 'application/json' },
        body: '{"ok":true}',
        bodyHash,
      });
    }
    const second = await store.reserve(user, key, bodyHash);
    expect(second.acquired).toBe(false);
    if (!second.acquired && 'replay' in second) {
      expect(second.replay.status).toBe(201);
      expect(JSON.parse(second.replay.body)).toEqual({ ok: true });
    } else {
      throw new Error('expected replay');
    }
  });

  it('rejects a key reused with a different body hash', async () => {
    const r = createRedis();
    const store = new RedisIdempotencyStore(r.main);
    const user = uuidv7();
    const key = `k-${Date.now()}-mismatch`;
    const first = await store.reserve(user, key, 'hA');
    if (first.acquired) {
      await store.complete(user, key, first.lockToken, {
        status: 201,
        headers: {},
        body: '{}',
        bodyHash: 'hA',
      });
    }
    const second = await store.reserve(user, key, 'hB');
    expect(second.acquired).toBe(false);
    if (!second.acquired && 'bodyHashMismatch' in second) {
      expect(second.bodyHashMismatch).toBe(true);
    } else {
      throw new Error('expected bodyHashMismatch');
    }
  });
});

// The keys below are throwaway PKCS8 / SPKI values. They are NOT
// used for real signing (the JWT test is run separately with real
// keys). Their only purpose is to satisfy the env-var check in
// loadConfig so the test does not throw on a missing required var.
const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=
-----END PUBLIC KEY-----`;
