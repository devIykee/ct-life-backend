/**
 * Test-only kit for route tests: boot the API in-process with a chosen
 * `CAPABILITIES_ON`, sign players in through dev auth and call routes with a
 * fresh Idempotency-Key. Imported only by `*.test.ts` files.
 *
 * It reads the same `.env` as the rest of the suite (real Postgres and Redis);
 * nothing is mocked.
 */
import { expect } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests } from '../application/context.js';

loadDotenv({ path: process.cwd() + '/.env' });

export interface TestPlayer {
  readonly sub: string;
  readonly accessToken: string;
}

export interface TestResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
  readonly raw: Buffer;
}

export interface TestApi {
  readonly app: Awaited<ReturnType<typeof buildServer>>['app'];
  /** Sign a new player in with dev auth. */
  player(): Promise<TestPlayer>;
  /** Call a route as `who` (or anonymously with null). */
  call(
    who: TestPlayer | null,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ): Promise<TestResponse>;
  stop(): Promise<void>;
}

/**
 * Boot the API with these capabilities on (comma list, as CAPABILITIES_ON).
 * @param capabilities - The CAPABILITIES_ON value for this server.
 * @param env - Extra env for this boot (restored on stop).
 * @returns The handle.
 */
export async function bootApi(
  capabilities: string,
  env: Record<string, string | undefined> = {},
): Promise<TestApi> {
  const all: Record<string, string | undefined> = {
    CAPABILITIES_ON: capabilities,
    ENABLE_DEV_AUTH: 'true',
    LOG_LEVEL: 'warn',
    ...env,
  };
  const saved = Object.fromEntries(Object.keys(all).map((k) => [k, process.env[k]]));
  const apply = (vars: Record<string, string | undefined>): void => {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetConfigForTests();
    _resetContextForTests();
  };
  apply(all);
  const handle = await buildServer();
  await handle.app.ready();
  const app = handle.app;

  const call: TestApi['call'] = async (who, method, url, payload) => {
    const r = await app.inject({
      method,
      url,
      headers: {
        ...(who ? { authorization: `Bearer ${who.accessToken}` } : {}),
        ...(method === 'GET' ? {} : { 'idempotency-key': uuidv7() }),
      },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });
    let body: Record<string, unknown> = {};
    try {
      body = r.json();
    } catch {
      // Not JSON (an image, or an empty 204).
    }
    return { status: r.statusCode, body, headers: r.headers, raw: r.rawPayload };
  };

  return {
    app,
    call,
    async player() {
      const r = await app.inject({
        method: 'POST',
        url: '/v1/auth/dev',
        headers: { 'idempotency-key': uuidv7() },
        payload: { wallet: Keypair.generate().publicKey.toBase58() },
      });
      expect(r.statusCode, r.body).toBe(200);
      const b = r.json() as { id: string; accessToken: string };
      return { sub: b.id, accessToken: b.accessToken };
    },
    async stop() {
      await handle.stop();
      apply(saved);
    },
  };
}

/**
 * The contract error code of a response.
 * @param r - A response from `call`.
 * @returns `error.code`, or undefined.
 */
export function errCode(r: TestResponse): string | undefined {
  return (r.body.error as { code?: string } | undefined)?.code;
}

/**
 * The contract error details of a response.
 * @param r - A response from `call`.
 * @returns `error.details`, or an empty object.
 */
export function errDetails(r: TestResponse): Record<string, unknown> {
  return (r.body.error as { details?: Record<string, unknown> } | undefined)?.details ?? {};
}
