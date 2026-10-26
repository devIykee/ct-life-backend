/**
 * Request logs carry no full client IP, no query string and no port, even
 * behind a proxy (trustProxy: the client address arrives in X-Forwarded-For).
 */
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { httpLoggerOptions, truncateIp } from './logger.js';

describe('truncateIp', () => {
  it('keeps a /24 for IPv4 and a /48 for IPv6', () => {
    expect(truncateIp('203.0.113.77')).toBe('203.0.113.0');
    expect(truncateIp('::ffff:198.51.100.9')).toBe('198.51.100.0');
    expect(truncateIp('2001:db8:85a3:8d3:1319:8a2e:370:7348')).toBe('2001:db8:85a3::');
    expect(truncateIp('2001:db8::1')).toBe('2001:db8:0::');
    expect(truncateIp('::1')).toBe('0:0:0::');
    expect(truncateIp(undefined)).toBe('unknown');
    expect(truncateIp('garbage')).toBe('unknown');
  });
});

describe('HTTP request logging', () => {
  it('never writes the full client IP, the query string or the port', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = Fastify({
      logger: { ...httpLoggerOptions('info'), stream },
      trustProxy: true,
    });
    app.get('/ping', async () => ({ ok: true }));
    await app.inject({
      method: 'GET',
      url: '/ping?handle=secret-handle',
      headers: { 'x-forwarded-for': '203.0.113.77', authorization: 'Bearer abc' },
      remoteAddress: '10.0.0.5',
      authority: 'api.test',
    });
    await app.close();
    const all = lines.join('');
    expect(all).toContain('/ping');
    expect(all).toContain('203.0.113.0');
    expect(all).not.toContain('203.0.113.77');
    expect(all).not.toContain('secret-handle');
    expect(all).not.toContain('remotePort');
    expect(all).not.toContain('Bearer');
  });
});
