/**
 * Conditional GET on /v1/config: If-None-Match uses the weak comparison (RFC 9110 13.1.2).
 *
 * Railway's edge rewrites our strong `"x"` to `W/"x"` when it gzips, and clients echo
 * that weak tag back, so it must still get a 304. Unit tests for the matcher, then the
 * route over HTTP (real API, real Postgres/Redis).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ifNoneMatchHits } from './conditional-get.js';
import { bootApi, type TestApi } from './http-test-kit.js';

const TAG = '"812ccaa8"';

describe('ifNoneMatchHits', () => {
  it.each([
    ['the same strong tag', TAG],
    ['the weak form of the tag', `W/${TAG}`],
    ['a list holding the tag', `"other", ${TAG}`],
    ['a list holding the weak tag, no spaces', `W/"other",W/${TAG}`],
    ['the wildcard', '*'],
    ['the wildcard with spaces', '  * '],
    ['a duplicated header (array)', ['"other"', `W/${TAG}`]],
  ])('matches %s', (_label, header) => {
    expect(ifNoneMatchHits(header, TAG)).toBe(true);
  });

  it('matches a strong header against a weak current ETag', () => {
    expect(ifNoneMatchHits(TAG, `W/${TAG}`)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['another tag', '"other"'],
    ['another weak tag', 'W/"other"'],
    ['the tag without quotes', '812ccaa8'],
    ['a prefix of the tag', '"812cca"'],
    ['the wildcard inside a list', `"other", *`],
  ])('does not match %s', (_label, header) => {
    expect(ifNoneMatchHits(header, TAG)).toBe(false);
  });
});

describe('GET /v1/config conditional requests', () => {
  let api: TestApi;
  let etag: string;

  beforeAll(async () => {
    api = await bootApi('');
    const first = await get();
    expect(first.statusCode).toBe(200);
    etag = String(first.headers.etag);
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  afterAll(async () => {
    await api.stop();
  });

  const get = (headers: Record<string, string> = {}) =>
    api.app.inject({ method: 'GET', url: '/v1/config', headers });

  it('answers 304 to the strong tag, the weak tag, a list and the wildcard', async () => {
    for (const inm of [etag, `W/${etag}`, `"x", ${etag}`, `W/"x", W/${etag}`, '*']) {
      const r = await get({ 'if-none-match': inm });
      expect(r.statusCode, inm).toBe(304);
      expect(r.body).toBe('');
    }
  });

  it('repeats ETag, Cache-Control and Vary on the 304', async () => {
    const r = await get({ 'if-none-match': `W/${etag}` });
    expect(r.statusCode).toBe(304);
    expect(r.headers.etag).toBe(etag);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    expect(String(r.headers.vary)).toContain('X-Client-Platform');
  });

  it('answers 200 with the body to a tag that does not match', async () => {
    for (const inm of ['"x"', 'W/"x"', etag.slice(1, -1)]) {
      const r = await get({ 'if-none-match': inm });
      expect(r.statusCode, inm).toBe(200);
      expect(r.headers.etag).toBe(etag);
      expect(r.json().version).toBe('1.0.0-rc1');
    }
  });
});
