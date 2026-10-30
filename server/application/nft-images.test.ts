/**
 * NFT image proxy rules (unlock D4): private and non-https sources are
 * refused, size and type limits hold, images are re-encoded to a small PNG,
 * and the proxy fetches a registered URL once and then serves the cache.
 *
 * The "remote" image host is a real local HTTP server; reaching it needs the
 * test-only `allowPrivateForTests` option, which is exactly the protection
 * the first tests prove is on by default.
 */
import { createServer, type Server } from 'node:http';
import { Pool } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import {
  fetchSource,
  imageHash,
  isPrivateAddress,
  normalizeImageUri,
  proxiedImage,
  reencode,
  registerImage,
} from './nft-images.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
let ctx: AppContext;
let server: Server;
let base = '';
let hits = 0;
let bigPng: Buffer;
const hashes: string[] = [];

beforeAll(async () => {
  ctx = buildContext();
  bigPng = await sharp({
    create: {
      width: 2000,
      height: 1500,
      channels: 4,
      background: { r: 200, g: 30, b: 90, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  server = createServer((req, res) => {
    hits++;
    req.url = (req.url ?? '').split('?')[0];
    if (req.url === '/art.png')
      return res.writeHead(200, { 'content-type': 'image/png' }).end(bigPng);
    if (req.url === '/huge.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.alloc(9 * 1024 * 1024));
    }
    if (req.url === '/evil.svg')
      return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg/>');
    if (req.url === '/hop') return res.writeHead(302, { location: '/art.png' }).end();
    return res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await pool.query(`DELETE FROM nft_images WHERE hash = ANY($1::text[])`, [hashes]);
  await pool.end();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('source rules', () => {
  it('knows private, loopback, link-local, CGNAT and ULA addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '151.101.1.1', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('maps ipfs and ar, keeps https, refuses everything else', () => {
    expect(normalizeImageUri('ipfs://bafyabc/1.png')).toBe('https://ipfs.io/ipfs/bafyabc/1.png');
    expect(normalizeImageUri('ar://xyz')).toBe('https://arweave.net/xyz');
    expect(normalizeImageUri('https://a.example/x.png')).toBe('https://a.example/x.png');
    for (const bad of [
      'http://a.example/x.png',
      'file:///etc/passwd',
      'data:image/png;base64,AA',
      'https://u:p@a.example/',
      '',
      null,
    ]) {
      expect(normalizeImageUri(bad)).toBeNull();
    }
  });

  it('refuses http, a private literal and a host that resolves to loopback by default', async () => {
    await expect(fetchSource(`${base}/art.png`, { maxBytes: 1e7 })).rejects.toThrow('not_https');
    await expect(fetchSource('https://127.0.0.1/x.png', { maxBytes: 1e7 })).rejects.toThrow(
      'blocked_address',
    );
    await expect(fetchSource('https://localhost:1/x.png', { maxBytes: 1e7 })).rejects.toThrow(
      /blocked address/,
    );
  });

  it('enforces type and size, follows a redirect', async () => {
    const t = { allowPrivateForTests: true, maxBytes: 8 * 1024 * 1024 };
    await expect(fetchSource(`${base}/evil.svg`, t)).rejects.toThrow('bad_type');
    await expect(fetchSource(`${base}/huge.png`, t)).rejects.toThrow('too_large');
    const ok = await fetchSource(`${base}/hop`, t);
    expect(ok.contentType).toBe('image/png');
    expect(ok.body.length).toBe(bigPng.length);
  });

  it('re-encodes to a PNG of at most 512 px and 512 KiB', async () => {
    const out = await reencode(bigPng);
    expect(Math.max(out.width, out.height)).toBe(512);
    expect(out.png.length).toBeLessThanOrEqual(524_288);
    expect((await sharp(out.png).metadata()).format).toBe('png');
    await expect(reencode(Buffer.from('not an image'))).rejects.toThrow();
  });
});

describe('proxiedImage', () => {
  it('serves only registered hashes, fetches once, then serves the cache', async () => {
    expect(await proxiedImage(ctx, 'f'.repeat(40))).toBeNull(); // never registered
    expect(await proxiedImage(ctx, '../etc')).toBeNull();
    const url = `${base}/art.png?run=${Date.now()}`;
    const hash = await registerImage(ctx, url);
    hashes.push(hash);
    expect(hash).toBe(imageHash(url));
    const before = hits;
    const first = await proxiedImage(ctx, hash, { allowPrivateForTests: true });
    expect(first?.png.length).toBeGreaterThan(0);
    const second = await proxiedImage(ctx, hash);
    expect(second?.png.equals(first!.png)).toBe(true);
    expect(hits - before).toBe(1);
  });

  it('records a failed source and does not retry it within the hour', async () => {
    const url = `${base}/evil.svg?run=${Date.now()}`;
    const hash = await registerImage(ctx, url);
    hashes.push(hash);
    expect(await proxiedImage(ctx, hash, { allowPrivateForTests: true })).toBeNull();
    const before = hits;
    expect(await proxiedImage(ctx, hash, { allowPrivateForTests: true })).toBeNull();
    expect(hits).toBe(before);
    const r = await pool.query(`SELECT status, fail_reason FROM nft_images WHERE hash = $1`, [
      hash,
    ]);
    expect(r.rows[0]).toEqual({ status: 'failed', fail_reason: 'bad_type' });
  });
});
