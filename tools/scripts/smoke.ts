/**
 * Smoke test for every external dependency required by the M0 gate.
 *
 * Run: pnpm smoke
 *
 * It prints green/red for every dependency and exits non-zero on any failure.
 * The devnet airdrop check is informational because the public faucet is
 * per-IP rate-limited; the result is logged but does not block the gate.
 */
import { createConnection, withTimeout, env } from './_lib';
import { createServer as createHttpServer } from 'node:http';
import { address } from '@solana/kit';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  // eslint-disable-next-line no-console
  console.log(`[${tag}] ${name}: ${detail}`);
}

async function checkPostgres(): Promise<void> {
  if (!env.DATABASE_URL) {
    record('postgres', false, 'DATABASE_URL not set');
    return;
  }
  try {
    // Lazy import so missing peer deps don't fail at parse time.
    const pg = await import('pg');
    const client = new pg.Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    const res = await withTimeout(client.query('SELECT 1 AS ok'), 5000, 'postgres SELECT 1');
    await client.end();
    record('postgres', res.rows[0]?.ok === 1, 'SELECT 1 returned 1');
  } catch (e) {
    record('postgres', false, `error: ${(e as Error).message}`);
  }
}

async function checkRedis(): Promise<void> {
  if (!env.REDIS_URL) {
    record('redis', false, 'REDIS_URL not set');
    return;
  }
  try {
    const redisModule = await import('ioredis');
    const Redis =
      redisModule.default ??
      (redisModule as unknown as { Redis: new (url: string, opts?: unknown) => unknown }).Redis;
    const r = new (
      Redis as new (
        url: string,
        opts?: unknown,
      ) => {
        connect: () => Promise<unknown>;
        ping: () => Promise<string>;
        quit: () => Promise<unknown>;
      }
    )(env.REDIS_URL, { lazyConnect: true });
    await r.connect();
    const pong = await withTimeout(r.ping(), 3000, 'redis PING');
    await r.quit();
    record('redis', pong === 'PONG', `PING returned ${pong}`);
  } catch (e) {
    record('redis', false, `error: ${(e as Error).message}`);
  }
}

async function checkSolanaDevnet(): Promise<void> {
  if (!env.SOLANA_RPC_URL_DEVNET) {
    record('solana-devnet', false, 'SOLANA_RPC_URL_DEVNET not set');
    return;
  }
  try {
    const conn = createConnection(env.SOLANA_RPC_URL_DEVNET);
    // @solana/kit 8.4: the RPC methods are on the returned object directly,
    // not on `.rpc`. Each method returns a builder; call .send() to await.
    const health = await withTimeout(conn.getHealth().send(), 15000, 'devnet getHealth');
    record('solana-devnet', health === 'ok', `getHealth -> ${health}`);
  } catch (e) {
    record('solana-devnet', false, `error: ${(e as Error).message}`);
  }
}

async function checkSolanaMainnet(): Promise<void> {
  if (!env.SOLANA_RPC_URL_MAINNET) {
    record('solana-mainnet', false, 'SOLANA_RPC_URL_MAINNET not set');
    return;
  }
  try {
    const conn = createConnection(env.SOLANA_RPC_URL_MAINNET);
    const health = await withTimeout(conn.getHealth().send(), 15000, 'mainnet getHealth');
    record('solana-mainnet', health === 'ok', `getHealth -> ${health}`);
  } catch (e) {
    record('solana-mainnet', false, `error: ${(e as Error).message}`);
  }
}

async function checkHelius(): Promise<void> {
  if (!env.HELIUS_API_KEY) {
    record('helius', false, 'HELIUS_API_KEY not set');
    return;
  }
  const heliusUrl = env.HELIUS_RPC_URL_DEVNET ?? 'https://devnet.helius-rpc.com';
  try {
    const conn = createConnection(heliusUrl);
    const health = await withTimeout(conn.getHealth().send(), 10000, 'helius getHealth');
    record('helius', health === 'ok', `getHealth -> ${health}`);
  } catch (e) {
    record('helius', false, `error: ${(e as Error).message}`);
  }
}

async function checkLiveKit(): Promise<void> {
  const url = env.LIVEKIT_URL;
  const key = env.LIVEKIT_API_KEY;
  const secret = env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    record('livekit', false, 'LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set');
    return;
  }
  try {
    const { AccessToken } = await import('livekit-server-sdk');
    const at = new AccessToken(key, secret, { identity: 'smoke-user', ttl: 60 });
    at.addGrant({ roomAdmin: true, room: 'smoke-room', roomCreate: true });
    const apiToken = await at.toJwt();
    if (!apiToken) throw new Error('token is empty');

    // The LiveKit HTTP API uses Twirp and authenticates with a Bearer JWT
    // (Basic auth is only for the access token endpoint).
    const httpBase = url.replace(/^ws/, 'http');
    const room = 'ctlife-smoke-' + Date.now();
    const create = await fetch(`${httpBase}/twirp/livekit.RoomService/CreateRoom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ name: room, empty_timeout: 60 }),
    });
    if (!create.ok && create.status !== 409) {
      // 409 means it already exists; that's still a successful reach.
      const body = await create.text();
      throw new Error(`create room ${create.status}: ${body}`);
    }
    const del = await fetch(`${httpBase}/twirp/livekit.RoomService/DeleteRoom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiToken}` },
      body: JSON.stringify({ room }),
    });
    if (!del.ok && del.status !== 404) {
      const body = await del.text();
      throw new Error(`delete room ${del.status}: ${body}`);
    }
    record('livekit', true, `token + room create/delete OK at ${httpBase}`);
  } catch (e) {
    record('livekit', false, `error: ${(e as Error).message}`);
  }
}

async function checkS3(): Promise<void> {
  if (!env.S3_ENDPOINT) {
    record('s3', false, 'S3_ENDPOINT not set');
    return;
  }
  try {
    const probe = await fetch(`${env.S3_ENDPOINT}/minio/health/live`, {
      signal: AbortSignal.timeout(3000),
    });
    record('s3', probe.ok, `${env.S3_ENDPOINT} health -> ${probe.status}`);
  } catch (e) {
    record('s3', false, `error: ${(e as Error).message}`);
  }
}

async function checkDevnetAirdrop(): Promise<void> {
  // Informational: the public devnet faucet is per-IP rate-limited and often
  // returns 429. We log the result but do not fail the smoke. The airdrop is
  // needed for the bot e2e (M2) and the paid-call e2e (M4), not for M0.
  const url = 'https://api.devnet.solana.com';
  // The settle authority pubkey is read from TREASURY_PUBKEY_DEVNET as a
  // proxy at the smoke stage; we read it from process.env directly because
  // the smoke test is the first consumer.
  const target = process.env.TREASURY_PUBKEY_DEVNET ?? '';
  if (!target) {
    record('devnet-airdrop', false, 'TREASURY_PUBKEY_DEVNET not set; skipping (informational)');
    return;
  }
  try {
    const conn = createConnection(url);
    const sig = await withTimeout(
      (
        conn as unknown as {
          requestAirdrop: (
            a: ReturnType<typeof address>,
            b: bigint,
          ) => { send: () => Promise<string> };
        }
      )
        .requestAirdrop(address(target), 1_000_000_000n)
        .send(),
      10000,
      'devnet requestAirdrop',
    );
    record(
      'devnet-airdrop',
      Boolean(sig),
      `airdropped 1 SOL to ${target}: ${String(sig).slice(0, 20)}…`,
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (
      msg.includes('429') ||
      msg.toLowerCase().includes('rate limit') ||
      msg.toLowerCase().includes('limit')
    ) {
      record(
        'devnet-airdrop',
        false,
        `faucet rate-limited; documented in UNVERIFIED.md (${msg.slice(0, 80)}…)`,
      );
    } else {
      record('devnet-airdrop', false, `error: ${msg}`);
    }
  }
}

async function main(): Promise<void> {
  // Avoid an unused-import lint complaint in environments where `http` isn't used.
  void createHttpServer;
  // eslint-disable-next-line no-console
  console.log('CT Life smoke test');
  // eslint-disable-next-line no-console
  console.log('-------------------');
  await checkPostgres();
  await checkRedis();
  await checkSolanaDevnet();
  await checkSolanaMainnet();
  await checkHelius();
  await checkLiveKit();
  await checkS3();
  await checkDevnetAirdrop();
  // eslint-disable-next-line no-console
  console.log('-------------------');
  // The devnet airdrop is informational because the public faucet is
  // per-IP rate-limited. Other failures are still fatal.
  const required = results.filter((r) => r.name !== 'devnet-airdrop');
  const requiredFailed = required.filter((r) => !r.ok);
  const airdrop = results.find((r) => r.name === 'devnet-airdrop');
  if (requiredFailed.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `\x1b[32mAll ${required.length} required checks passed.\x1b[0m` +
        (airdrop ? ` (airdrop: ${airdrop.ok ? 'OK' : 'rate-limited (see UNVERIFIED.md)'})` : ''),
    );
    process.exit(0);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `\x1b[31m${requiredFailed.length} of ${required.length} required checks failed.\x1b[0m`,
    );
    process.exit(1);
  }
}

void main();
