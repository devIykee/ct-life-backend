/**
 * The Timeline over HTTP (migration 102): the tab parameter and the older
 * scope parameter, posting with a server-side card, and opt-in check-ins.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { _resetConfigForTests } from '../shared/config/config.js';

const FAKE_PKCS8 = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIH4+zq3wXKb5xY9jQ8j6P4mY8Z3b1z9S6n2Y1z9R6n2
-----END PRIVATE KEY-----`;
const FAKE_SPKI = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAR8mD8eJX4v9O0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l9T0l8=
-----END PUBLIC KEY-----`;

loadDotenv({ path: process.cwd() + '/.env' });

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;

beforeAll(async () => {
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
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  const handle = await buildServer();
  app = handle.app;
  // Prepare Fastify without binding a real port.
  await app.ready();
  stop = handle.stop;
}, 30_000);

afterAll(async () => {
  await stop();
}, 30_000);

async function devAuth(): Promise<{ sub: string; token: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `tl-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, token: b.accessToken };
}

describe('Timeline over HTTP', () => {
  it('reads every tab, and the older scope parameter still works', async () => {
    const u = await devAuth();
    const auth = { authorization: `Bearer ${u.token}` };
    for (const url of [
      '/v1/feed',
      '/v1/feed?scope=global',
      '/v1/feed?scope=following',
      '/v1/feed?tab=foryou',
      '/v1/feed?tab=following',
      '/v1/feed?tab=city&type=rug',
    ]) {
      const r = await app.inject({ method: 'GET', url, headers: auth });
      expect(r.statusCode, `${url} ${r.body}`).toBe(200);
      const b = r.json() as { posts: unknown[]; nextBefore: string | null; quiet: boolean };
      expect(Array.isArray(b.posts)).toBe(true);
      expect(typeof b.quiet).toBe('boolean');
    }
    const bad = await app.inject({ method: 'GET', url: '/v1/feed?tab=nope', headers: auth });
    expect(bad.statusCode).toBe(400);
  });

  it('posts (201, server-built card) and refuses a check-in away from the venue', async () => {
    const u = await devAuth();
    const headers = { authorization: `Bearer ${u.token}`, 'idempotency-key': uuidv7() };
    const r = await app.inject({
      method: 'POST',
      url: '/v1/feed/posts',
      headers,
      payload: { text: 'gm from the load test', withPlace: true },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ kind: 'player', card: null, userId: u.sub });
    const c = await app.inject({
      method: 'POST',
      url: '/v1/feed/checkins',
      headers: { ...headers, 'idempotency-key': uuidv7() },
      payload: { venueId: 'terminal_cafe' },
    });
    expect(c.statusCode).toBe(400);
    expect(c.json().error.details.reason).toBe('not_at_venue');
  });

  it('posting has its own per-player limit (a burst of 3)', async () => {
    const u = await devAuth();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/feed/posts',
        headers: { authorization: `Bearer ${u.token}`, 'idempotency-key': uuidv7() },
        payload: { text: `spam ${i}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([201, 201, 201, 429, 429]);
  });
});
