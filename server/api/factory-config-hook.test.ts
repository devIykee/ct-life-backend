/**
 * Factory config hook (unlock C3): `GET /config` sends `factory {livePhase: 2, cluster:
 * 'devnet'}` only while the `factory` capability is on AND real launches are configured
 * (DBC partner config + metadata store); launching is `503 CAPABILITY_OFF` while off and
 * `503 FACTORY_UNAVAILABLE` when on without a DBC config.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetContextForTests } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

const KEYS = [
  'CAPABILITIES_ON',
  'FACTORY_DBC_CONFIG',
  'FACTORY_METADATA_STORE',
  'PUBLIC_API_BASE_URL',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: (() => Promise<void>) | null = null;

async function boot(env: Partial<Record<(typeof KEYS)[number], string>>): Promise<void> {
  for (const k of KEYS) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  process.env.LOG_LEVEL = 'warn';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

async function config(): Promise<Record<string, unknown>> {
  return (await app.inject({ method: 'GET', url: '/v1/config' })).json();
}

async function prepare(): Promise<{ status: number; code: string }> {
  const auth = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `c3-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  const token = (auth.json() as { accessToken: string }).accessToken;
  const r = await app.inject({
    method: 'POST',
    url: '/v1/factory/launch/prepare',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': uuidv7() },
    payload: { name: 'Hook Frog', ticker: 'HOOK', imageBase64: 'AA==', riskAccepted: true },
  });
  return { status: r.statusCode, code: (r.json() as { error: { code: string } }).error.code };
}

const LAUNCHES = {
  FACTORY_DBC_CONFIG: Keypair.generate().publicKey.toBase58(),
  FACTORY_METADATA_STORE: 'self',
  PUBLIC_API_BASE_URL: 'https://api.example.test',
};

afterEach(async () => {
  if (stop) await stop();
  stop = null;
});

afterAll(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetConfigForTests();
  _resetContextForTests();
});

describe('factory config hook', () => {
  it('capability off: no config key and launching is dark, even when configured', async () => {
    await boot(LAUNCHES);
    const cfg = await config();
    expect(cfg.factory).toBeUndefined();
    expect((cfg.capabilities as { features: { factory: boolean } }).features.factory).toBe(false);
    expect(await prepare()).toEqual({ status: 503, code: 'CAPABILITY_OFF' });
  }, 30_000);

  it('capability on but no DBC config: no config key, FACTORY_UNAVAILABLE', async () => {
    await boot({ CAPABILITIES_ON: 'factory' });
    expect((await config()).factory).toBeUndefined();
    expect(await prepare()).toEqual({ status: 503, code: 'FACTORY_UNAVAILABLE' });
  }, 30_000);

  it('capability on and launches configured: factory {livePhase: 2, cluster: devnet}', async () => {
    await boot({ CAPABILITIES_ON: 'factory', ...LAUNCHES });
    expect((await config()).factory).toEqual({ livePhase: 2, cluster: 'devnet' });
  }, 30_000);
});
