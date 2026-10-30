/**
 * Devnet SOL drip + "Get test tokens" (unlock WP-C, capability devnetDrip) over HTTP:
 * dark until on, one drip per wallet per UTC day, no drip for a funded wallet, the
 * treasury reserve, the global daily budget, the genesis-hash devnet check, and a failed
 * send that frees the slot. Real DB; the chain is a fake RPC that records what was sent.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, SystemInstruction, SystemProgram, Transaction } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetContextForTests } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import {
  _resetDevnetRpcCheckForTests,
  _setClusterRpcForTests,
  DEVNET_GENESIS_HASH,
} from '../application/chain-rpc.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { HeliusClient } from '../shared/solana/helius.js';

loadDotenv({ path: process.cwd() + '/.env' });

const KEYS = [
  'CAPABILITIES_ON',
  'DEVNET_DRIP_KEYPAIR',
  'DEVNET_DRIP_LAMPORTS',
  'DEVNET_DRIP_DAILY_CAP_LAMPORTS',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});

const treasury = Keypair.generate();
const keyDir = mkdtempSync(join(tmpdir(), 'ctlife-drip-'));
const treasuryPath = join(keyDir, 'drip-treasury.json');
writeFileSync(treasuryPath, JSON.stringify(Array.from(treasury.secretKey)));

let balances: Map<string, number>;
let sent: Transaction[];
let genesis: string;
let sendFails: boolean;

const fakeRpc = {
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    switch (method) {
      case 'getGenesisHash':
        return genesis as T;
      case 'getBalance':
        return { value: balances.get(params[0] as string) ?? 0 } as T;
      case 'getLatestBlockhash':
        return {
          value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 9 },
        } as T;
      case 'sendTransaction': {
        if (sendFails) throw new Error('Transaction simulation failed');
        const tx = Transaction.from(Buffer.from(params[0] as string, 'base64'));
        sent.push(tx);
        return `sig${sent.length}${uuidv7().replace(/-/g, '')}` as T;
      }
      default:
        throw new Error(`unexpected rpc ${method}`);
    }
  },
} as unknown as HeliusClient;

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: (() => Promise<void>) | null = null;

async function boot(env: Partial<Record<(typeof KEYS)[number], string | undefined>>) {
  for (const k of KEYS) {
    const v = k in env ? env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.LOG_LEVEL = 'warn';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

interface Authed {
  wallet: string;
  token: string;
}

async function devAuth(): Promise<Authed> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `drip-${uuidv7()}` },
    payload: { wallet },
  });
  expect(r.statusCode, r.body).toBe(200);
  return { wallet, token: (r.json() as { accessToken: string }).accessToken };
}

async function call(u: Authed, method: 'GET' | 'POST', url: string) {
  const r = await app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${u.token}`,
      ...(method === 'POST' ? { 'idempotency-key': uuidv7() } : {}),
    },
  });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}

const ON = { CAPABILITIES_ON: 'devnetDrip', DEVNET_DRIP_KEYPAIR: treasuryPath };

beforeEach(() => {
  balances = new Map([[treasury.publicKey.toBase58(), 5_000_000_000]]);
  sent = [];
  genesis = DEVNET_GENESIS_HASH;
  sendFails = false;
  _setClusterRpcForTests(fakeRpc);
  _resetDevnetRpcCheckForTests();
});

afterEach(async () => {
  if (stop) await stop();
  stop = null;
});

afterAll(async () => {
  _setClusterRpcForTests(null);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
});

describe('devnet drip', () => {
  it('is dark until devnetDrip is on', async () => {
    await boot({ DEVNET_DRIP_KEYPAIR: treasuryPath });
    const u = await devAuth();
    for (const [m, url] of [
      ['GET', '/v1/devnet/test-tokens'],
      ['POST', '/v1/devnet/drip'],
    ] as const) {
      const r = await call(u, m, url);
      expect(r.status, url).toBe(503);
      expect(r.body.error).toMatchObject({
        code: 'CAPABILITY_OFF',
        details: { capability: 'devnetDrip' },
      });
    }
    const cfg = (await app.inject({ method: 'GET', url: '/v1/config' })).json();
    expect(cfg.capabilities.features.devnetDrip).toBe(false);
    expect(sent).toHaveLength(0);
  }, 30_000);

  it('without a treasury key: the card says unconfigured and the drip is refused', async () => {
    await boot({ CAPABILITIES_ON: 'devnetDrip' });
    const u = await devAuth();
    const info = await call(u, 'GET', '/v1/devnet/test-tokens');
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      cluster: 'devnet',
      wallet: u.wallet,
      usdc: {
        faucetUrl: 'https://faucet.circle.com/',
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
        perRequestBaseUnits: '20000000',
        everyHours: 2,
      },
      sol: { dripLamports: '20000000', available: false, reason: 'unconfigured', nextAt: null },
    });
    const r = await call(u, 'POST', '/v1/devnet/drip');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ details: { reason: 'drip_unconfigured' } });
  }, 30_000);

  it('sends 0.02 SOL once a day, signed by the treasury, to the caller only', async () => {
    await boot(ON);
    const u = await devAuth();
    const before = await call(u, 'GET', '/v1/devnet/test-tokens');
    expect(before.body.sol).toMatchObject({ available: true, reason: null });

    const r = await call(u, 'POST', '/v1/devnet/drip');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ lamports: '20000000', wallet: u.wallet });
    expect(sent).toHaveLength(1);
    const tx = sent[0]!;
    expect(tx.feePayer?.toBase58()).toBe(treasury.publicKey.toBase58());
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    const t = SystemInstruction.decodeTransfer(ix);
    expect(t.toPubkey.toBase58()).toBe(u.wallet);
    expect(t.lamports).toBe(20_000_000n);

    const again = await call(u, 'POST', '/v1/devnet/drip');
    expect(again.status).toBe(429);
    expect(again.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { reason: 'daily_drip' },
    });
    const after = await call(u, 'GET', '/v1/devnet/test-tokens');
    expect(after.body.sol).toMatchObject({ available: false, reason: 'claimed_today' });
    expect(typeof (after.body.sol as { nextAt: string }).nextAt).toBe('string');
    expect(sent).toHaveLength(1);
  }, 30_000);

  it('skips a funded wallet and keeps the treasury reserve', async () => {
    await boot(ON);
    const rich = await devAuth();
    balances.set(rich.wallet, 50_000_000);
    const r = await call(rich, 'POST', '/v1/devnet/drip');
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ details: { reason: 'balance_sufficient' } });

    const u = await devAuth();
    balances.set(treasury.publicKey.toBase58(), 25_000_000);
    const low = await call(u, 'POST', '/v1/devnet/drip');
    expect(low.status).toBe(503);
    expect(low.body.error).toMatchObject({ details: { reason: 'treasury_low' } });
    expect(sent).toHaveLength(0);
  }, 30_000);

  it('refuses when the RPC is not devnet (genesis hash), and never sends', async () => {
    await boot(ON);
    genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; // mainnet-beta
    const u = await devAuth();
    const r = await call(u, 'POST', '/v1/devnet/drip');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ details: { reason: 'rpc_not_devnet' } });
    expect(sent).toHaveLength(0);
  }, 30_000);

  it('stops at the daily budget', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const spent = await pool.query<{ s: string }>(
      `SELECT COALESCE(SUM(lamports), 0)::text AS s FROM devnet_drips WHERE day = $1`,
      [day],
    );
    await boot({
      ...ON,
      DEVNET_DRIP_DAILY_CAP_LAMPORTS: String(BigInt(spent.rows[0]!.s) + 19_999_999n),
    });
    const u = await devAuth();
    const r = await call(u, 'POST', '/v1/devnet/drip');
    expect(r.status).toBe(429);
    expect(r.body.error).toMatchObject({ details: { reason: 'drip_budget' } });
    expect(sent).toHaveLength(0);
  }, 30_000);

  it('a send the RPC refuses frees the day slot', async () => {
    await boot(ON);
    const u = await devAuth();
    sendFails = true;
    const r = await call(u, 'POST', '/v1/devnet/drip');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({
      code: 'SERVER_BUSY',
      details: { reason: 'drip_send_failed' },
    });
    sendFails = false;
    const ok = await call(u, 'POST', '/v1/devnet/drip');
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(sent).toHaveLength(1);
  }, 30_000);
});
