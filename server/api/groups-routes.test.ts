/**
 * Group chats over HTTP (migration 103): create, invite link, join, post,
 * read, and the per-player message limit.
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
    headers: { 'idempotency-key': `gc-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { sub: b.id, token: b.accessToken };
}

function h(token: string, write = false): Record<string, string> {
  return write
    ? { authorization: `Bearer ${token}`, 'idempotency-key': uuidv7() }
    : { authorization: `Bearer ${token}` };
}

describe('groups over HTTP', () => {
  it('create, invite link, join, post and read', async () => {
    const owner = await devAuth();
    const friend = await devAuth();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: h(owner.token, true),
      payload: { kind: 'friends', name: 'http crew' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const groupId = created.json().groupId as string;
    const link = await app.inject({
      method: 'POST',
      url: `/v1/groups/${groupId}/invites`,
      headers: h(owner.token, true),
      payload: {},
    });
    expect(link.statusCode, link.body).toBe(201);
    const code = link.json().code as string;
    const pre = await app.inject({
      method: 'GET',
      url: `/v1/invites/${code}`,
      headers: h(friend.token),
    });
    expect(pre.json()).toMatchObject({ groupName: 'http crew', valid: true });
    const acc = await app.inject({
      method: 'POST',
      url: `/v1/invites/${code}/accept`,
      headers: h(friend.token, true),
    });
    expect(acc.statusCode, acc.body).toBe(200);
    const post = await app.inject({
      method: 'POST',
      url: `/v1/groups/${groupId}/messages`,
      headers: h(friend.token, true),
      payload: { topic: 'chat', text: 'gm crew' },
    });
    expect(post.statusCode, post.body).toBe(201);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/groups/${groupId}/messages?topic=chat`,
      headers: h(owner.token),
    });
    expect(list.json().messages[0]).toMatchObject({ text: 'gm crew', authorUserId: friend.sub });
    const mine = await app.inject({ method: 'GET', url: '/v1/groups', headers: h(owner.token) });
    expect(
      mine.json().groups.find((g: { groupId: string }) => g.groupId === groupId),
    ).toMatchObject({
      unread: 1,
      memberCount: 2,
    });
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/groups/${groupId}/messages`,
      headers: h(friend.token, true),
      payload: { topic: 'calls', coinId: uuidv7(), targetX: 2, stopPct: 10 },
    });
    expect(bad.statusCode).toBe(400); // friends groups have no Calls topic
  });

  it('a burst of messages hits the per-player limit', async () => {
    const owner = await devAuth();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: h(owner.token, true),
      payload: { kind: 'friends', name: 'burst' },
    });
    const groupId = created.json().groupId as string;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/groups/${groupId}/messages`,
        headers: h(owner.token, true),
        payload: { topic: 'chat', text: `msg ${i}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(10);
    expect(codes).toContain(429);
  });
});
