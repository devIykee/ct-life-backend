/**
 * GET /v1/events/active over HTTP: 503 CAPABILITY_OFF while `worldEvents` is
 * off, 401 without a token, and with the capability on the events
 * publishWorldEvent broadcast come back newest first as {events:[{eventId, at, params}]}.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { buildServer } from './main.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _resetContextForTests } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { publishWorldEvent } from '../application/realtime-bus.js';
import { WORLD_EVENTS_KEY } from '../application/world-events.js';

const savedCaps = process.env.CAPABILITIES_ON;
let app: Awaited<ReturnType<typeof buildServer>>['app'] | null = null;
let stop: (() => Promise<void>) | null = null;

async function boot(caps: string | undefined): Promise<void> {
  if (stop) await stop();
  if (caps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = caps;
  process.env.ENABLE_DEV_AUTH = 'true';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

async function devToken(): Promise<string> {
  const r = await app!.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `wpa-${uuidv7()}` },
    payload: { wallet: Keypair.generate().publicKey.toBase58() },
  });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { accessToken: string }).accessToken;
}

afterAll(async () => {
  if (stop) await stop();
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
}, 30_000);

describe('GET /v1/events/active', () => {
  it('answers 503 CAPABILITY_OFF while worldEvents is off', async () => {
    await boot('');
    const token = await devToken();
    const r = await app!.inject({
      method: 'GET',
      url: '/v1/events/active',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatchObject({
      code: 'CAPABILITY_OFF',
      details: { capability: 'worldEvents' },
    });
  }, 30_000);

  it('needs a token, then lists published events newest first', async () => {
    await boot('worldEvents');
    expect((await app!.inject({ method: 'GET', url: '/v1/events/active' })).statusCode).toBe(401);
    const token = await devToken();
    const { buildContext } = await import('../application/context.js');
    const ctx = buildContext();
    await ctx.redis.main.del(WORLD_EVENTS_KEY);
    await publishWorldEvent(ctx, 'evt_rug', { coinId: 'c1', ticker: 'FROG' });
    await new Promise((r) => setTimeout(r, 5));
    await publishWorldEvent(ctx, 'evt_coin_launch', { ticker: 'MOON' });
    const r = await app!.inject({
      method: 'GET',
      url: '/v1/events/active',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as {
      events: Array<{ eventId: string; at: number; params: Record<string, string> }>;
    };
    expect(body.events.map((e) => e.eventId)).toEqual(['evt_coin_launch', 'evt_rug']);
    expect(body.events[1]!.params).toEqual({ coinId: 'c1', ticker: 'FROG' });
    expect(Number.isInteger(body.events[0]!.at)).toBe(true);
    expect(body.events[0]!.at).toBeGreaterThan(body.events[1]!.at);
    // The slug route is untouched.
    const slug = await app!.inject({
      method: 'GET',
      url: '/v1/events/no-such-event-slug',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(slug.statusCode).toBe(404);
    await ctx.redis.main.del(WORLD_EVENTS_KEY);
  }, 30_000);
});
