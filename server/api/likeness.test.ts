/** Exercise the registered HTTP/auth boundary with the real application context. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type ServerHandle } from './main.js';
import { buildContext } from '../application/context.js';
import { likenessFixture } from '../application/likeness-test-fixture.js';
import { createDb } from '../shared/db/pool.js';

let handle: ServerHandle;
let token: string;
let fixture: Awaited<ReturnType<typeof likenessFixture>>;
const input = {
  modelId: 'head_snow',
  uploadId: randomUUID(),
  entitlementId: randomUUID(),
  consent: { version: 'likeness-v1', ownPhoto: true, shareWithProvider: true },
};

beforeAll(async () => {
  fixture = await likenessFixture();
  createDb({
    connectionString: fixture.pool.options.connectionString,
    options: fixture.pool.options.options,
  });
  handle = await buildServer();
  await handle.app.ready();
  // A signed pre-character account is sufficient for availability. No fake
  // entitlement or generation is created, and the token is never logged.
  token = await buildContext().jwt.signAccess(
    randomUUID(),
    '11111111111111111111111111111111',
    false,
  );
});
afterAll(async () => {
  if (handle) await handle.stop();
  if (fixture) await fixture.close();
});

describe('likeness HTTP boundary', () => {
  it.each([
    { method: 'GET' as const, url: '/v1/likeness/jobs' },
    { method: 'POST' as const, url: '/v1/likeness/checkout', payload: { modelId: 'head_snow' } },
    { method: 'GET' as const, url: `/v1/likeness/checkout/${randomUUID()}` },
    {
      method: 'POST' as const,
      url: `/v1/likeness/checkout/${randomUUID()}/submitted`,
      payload: { signature: '2'.repeat(88) },
    },
    { method: 'GET' as const, url: `/v1/likeness/jobs/${randomUUID()}/manifest` },
    { method: 'GET' as const, url: `/v1/likeness/jobs/${randomUUID()}/preview` },
    { method: 'POST' as const, url: `/v1/likeness/jobs/${randomUUID()}/accept`, payload: {} },
    { method: 'GET' as const, url: '/v1/likeness' },
    { method: 'GET' as const, url: `/v1/likeness/jobs/${randomUUID()}` },
    { method: 'POST' as const, url: '/v1/likeness/jobs', payload: input },
    {
      method: 'POST' as const,
      url: '/v1/likeness/photos',
      payload: Buffer.from('not-a-photo'),
      headers: { 'content-type': 'image/png' },
    },
    { method: 'DELETE' as const, url: `/v1/likeness/jobs/${randomUUID()}` },
    { method: 'GET' as const, url: `/v1/likeness/jobs/${randomUUID()}/reference` },
    { method: 'GET' as const, url: `/v1/likeness/jobs/${randomUUID()}/result` },
    {
      method: 'POST' as const,
      url: `/v1/likeness/jobs/${randomUUID()}/reference/approve`,
      payload: { referenceSha256: 'a'.repeat(64) },
    },
    { method: 'DELETE' as const, url: `/v1/likeness/photos/${randomUUID()}` },
  ])('requires bearer authentication for $method $url', async (request) => {
    expect((await handle.app.inject(request)).statusCode).toBe(401);
  });
  it('exposes an honest unavailable offering to a signed-in pre-character player', async () => {
    const result = await handle.app.inject({
      method: 'GET',
      url: '/v1/likeness',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      enabled: false,
      reason: 'provider_not_configured',
      photoUploadEnabled: false,
      price: { amount: '3.00', currency: 'USDC', display: '3.00 USDC' },
    });
    expect(result.json().supportedModels).toHaveLength(10);
  });
  it('refuses a valid request without accepting payment or creating a job', async () => {
    const result = await handle.app.inject({
      method: 'POST',
      url: '/v1/likeness/jobs',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: input,
    });
    expect(result.statusCode).toBe(503);
    expect(result.json().error.code).toBe('LIKENESS_UNAVAILABLE');
  });
  it('rejects a missing request key and arbitrary photo URL', async () => {
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (
        await handle.app.inject({
          method: 'POST',
          url: '/v1/likeness/jobs',
          headers,
          payload: input,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await handle.app.inject({
          method: 'POST',
          url: '/v1/likeness/jobs',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { ...input, imageUrl: 'http://127.0.0.1/private' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('bounds the request body before any photo can be accepted', async () => {
    const result = await handle.app.inject({
      method: 'POST',
      url: '/v1/likeness/jobs',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: { ...input, image: 'x'.repeat(4096) },
    });
    expect(result.statusCode).toBe(413);
  });
  it('rejects authenticated private upload before parsing invalid image bytes while disabled', async () => {
    const response = await handle.app.inject({
      method: 'POST',
      url: '/v1/likeness/photos',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
      payload: Buffer.from('not-a-photo'),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('LIKENESS_UNAVAILABLE');
  });
});
