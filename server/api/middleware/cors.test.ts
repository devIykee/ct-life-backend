import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerCors } from './cors.js';

const WEB = 'https://play.ctlife.fun';
const PHOTO_HEADERS = [
  'authorization',
  'content-type',
  'idempotency-key',
  'x-client-version',
  'x-client-platform',
  'x-client-build',
  'x-contract-version',
  'x-likeness-consent-version',
  'x-likeness-own-photo',
  'x-likeness-share-with-provider',
];

describe('likeness browser CORS', () => {
  it('exposes the likeness checksum to the allowed browser without widening origin access', async () => {
    const app = Fastify();
    try {
      await registerCors(app, [WEB]);
      app.get('/v1/likeness/test/reference', (_request, reply) =>
        reply.header('X-Content-Sha256', 'a'.repeat(64)).send('synthetic-image'),
      );
      const response = await app.inject({
        method: 'GET',
        url: '/v1/likeness/test/reference',
        headers: { origin: WEB },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe(WEB);
      expect(
        String(response.headers['access-control-expose-headers']).toLowerCase().split(/,\s*/),
      ).toContain('x-content-sha256');
      expect(response.headers['x-content-sha256']).toBe('a'.repeat(64));
      const denied = await app.inject({
        method: 'GET',
        url: '/v1/likeness/test/reference',
        headers: { origin: 'https://attacker.example' },
      });
      expect(denied.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('permits the complete upload header set without invoking an upload', async () => {
    const app = Fastify();
    try {
      await registerCors(app, [WEB]);
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/v1/likeness/photos',
        headers: {
          origin: WEB,
          'access-control-request-method': 'POST',
          'access-control-request-headers': PHOTO_HEADERS.join(','),
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(WEB);
      expect(String(response.headers['access-control-allow-methods']).split(/,\s*/)).toContain(
        'POST',
      );
      const allowed = String(response.headers['access-control-allow-headers'])
        .toLowerCase()
        .split(/,\s*/);
      for (const header of PHOTO_HEADERS) expect(allowed).toContain(header);
    } finally {
      await app.close();
    }
  });

  it('does not grant the consent headers to an unlisted origin', async () => {
    const app = Fastify();
    try {
      await registerCors(app, [WEB]);
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/v1/likeness/photos',
        headers: {
          origin: 'https://play.ctlife.fun.attacker.example',
          'access-control-request-method': 'POST',
          'access-control-request-headers': PHOTO_HEADERS.join(','),
        },
      });
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-headers']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
