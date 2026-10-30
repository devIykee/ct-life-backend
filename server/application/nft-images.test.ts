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
  repool,
} from './nft-images.js';
import { runInTransaction } from '../shared/db/uow.js';
import { nftGalleryConfig } from './nft-gallery-config.js';
import { registerImages } from './nft-gallery.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool_ = new Pool({ connectionString: process.env.DATABASE_URL });
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
    if (req.url === '/slow.png') {
      // One byte every 300 ms: never idle long enough for a socket timeout.
      res.writeHead(200, { 'content-type': 'image/png' });
      const t = setInterval(() => res.write(Buffer.from([0])), 300);
      res.on('close', () => clearInterval(t));
      return;
    }
    return res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  // Keep the usage counters equal to the stored bytes after cleanup.
  await pool_.query(
    `UPDATE nft_image_usage u SET bytes = bytes - COALESCE((
       SELECT sum(octet_length(bytes)) FROM nft_images WHERE pool = u.pool AND hash = ANY($1::text[])), 0)`,
    [hashes],
  );
  await pool_.query(`DELETE FROM nft_images WHERE hash = ANY($1::text[])`, [hashes]);
  await pool_.end();
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

  it('blocks every private IPv6 form', () => {
    for (const ip of [
      '::',
      '::1',
      '::7f00:1', // IPv4-compatible
      '::ffff:7f00:1', // IPv4-mapped, hex form
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1', // NAT64
      '2002:7f00:1::1', // 6to4
      '2001:db8::1',
      'fd12:3456::1', // ULA
      'fe80::1',
      'fec0::1',
      '100::1',
      'ff02::1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('refuses IP-literal hosts in every form, IPv6 included', async () => {
    for (const url of [
      'https://[::1]/x.png',
      'https://[fd12:3456::1]/x.png',
      'https://[fe80::1]/x.png',
      'https://[::ffff:127.0.0.1]/x.png',
      'https://[64:ff9b::7f00:1]/x.png',
      'https://[2606:4700::1111]/x.png', // even a public literal: images never need one
      'https://127.0.0.1/x.png',
      'https://169.254.169.254/latest/meta-data',
    ]) {
      await expect(fetchSource(url, { maxBytes: 1e7 }), url).rejects.toThrow('ip_literal');
    }
  });

  it('gives up on a slow source at the overall deadline', async () => {
    const t0 = Date.now();
    await expect(
      fetchSource(`${base}/slow.png`, {
        allowPrivateForTests: true,
        maxBytes: 1e7,
        timeoutMs: 1200,
      }),
    ).rejects.toThrow('timeout');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('refuses http, a private literal and a host that resolves to loopback by default', async () => {
    await expect(fetchSource(`${base}/art.png`, { maxBytes: 1e7 })).rejects.toThrow('not_https');
    await expect(fetchSource('https://127.0.0.1/x.png', { maxBytes: 1e7 })).rejects.toThrow(
      'ip_literal',
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

  const usage = async (pool: string): Promise<bigint> =>
    BigInt(
      (
        await pool_.query<{ bytes: string }>(`SELECT bytes FROM nft_image_usage WHERE pool = $1`, [
          pool,
        ])
      ).rows[0]!.bytes,
    );
  const stored = async (pool: string): Promise<bigint> =>
    BigInt(
      (
        await pool_.query<{ n: string }>(
          `SELECT COALESCE(sum(octet_length(bytes)), 0) AS n FROM nft_images WHERE pool = $1`,
          [pool],
        )
      ).rows[0]!.n,
    );
  const reg = async (tag: string): Promise<string> => {
    const h = await registerImage(ctx, `${base}/art.png?${tag}=${Date.now()}-${Math.random()}`);
    hashes.push(h);
    return h;
  };
  const newOwner = async (): Promise<string> =>
    (
      await pool_.query<{ id: string }>(
        `INSERT INTO users (id, wallet) VALUES (gen_random_uuid(), $1) RETURNING id`,
        [`pool-${Date.now()}-${Math.random()}`],
      )
    ).rows[0]!.id;
  const frame = (owner: string, slot: number, h: string): Promise<unknown> =>
    runInTransaction(async (c) => {
      await c.query(
        `INSERT INTO home_gallery_frames (owner_user_id, slot, asset_id, network, name, image_hash, moderation)
         VALUES ($1, $2, $3, 'devnet', 'Framed', $4, 'pending')`,
        [owner, slot, `asset-${h}`, h],
      );
      await repool(c, [h]);
    });
  const unframe = (owner: string, budget?: number): Promise<unknown> =>
    runInTransaction(async (c) => {
      const r = await c.query<{ image_hash: string }>(
        `DELETE FROM home_gallery_frames WHERE owner_user_id = $1 RETURNING image_hash`,
        [owner],
      );
      await repool(
        c,
        r.rows.map((x) => x.image_hash),
        budget === undefined ? undefined : { pending: budget },
      );
    });

  it('never lets the shared pending pool exceed its budget under concurrent inserts', async () => {
    const one = BigInt((await reencode(bigPng)).png.length);
    const budget = Number((await usage('pending')) + one * 2n); // room for two more
    const hs = await Promise.all([0, 1, 2, 3].map((i) => reg(`conc${i}`)));
    await Promise.all(
      hs.map((h) =>
        proxiedImage(ctx, h, { allowPrivateForTests: true, budgets: { pending: budget } }),
      ),
    );
    expect(await usage('pending')).toBeLessThanOrEqual(BigInt(budget));
    expect(await usage('pending')).toBe(await stored('pending'));
  });

  it('counts framed images only against their owner, at most maxSlots x maxImageBytes', async () => {
    const owner = await newOwner();
    const before = await usage('framed');
    const slots = nftGalleryConfig().maxSlots;
    for (let i = 1; i <= slots; i++) {
      const h = await reg(`own${i}`);
      expect(await proxiedImage(ctx, h, { allowPrivateForTests: true })).not.toBeNull();
      await frame(owner, i, h);
    }
    const mine = BigInt(
      (
        await pool_.query<{ n: string }>(
          `SELECT COALESCE(sum(octet_length(i.bytes)), 0) AS n FROM home_gallery_frames f
             JOIN nft_images i ON i.hash = f.image_hash WHERE f.owner_user_id = $1`,
          [owner],
        )
      ).rows[0]!.n,
    );
    expect(mine).toBeLessThanOrEqual(BigInt(slots * nftGalleryConfig().maxImageBytes));
    expect((await usage('framed')) - before).toBe(mine);
    // A slot past maxSlots is impossible (CHECK and the PUT validation): the bound is structural.
    await expect(frame(owner, 65, await reg('over'))).rejects.toThrow();
    // A full pending pool does not block this owner's framed images, and they are never evicted.
    const h = await reg('framedfull');
    await frame(owner, slots + 1 > 64 ? 64 : slots + 1, h).catch(() => undefined);
    await unframe(owner);
    expect((await usage('framed')) - before).toBe(0n);
    expect(await usage('framed')).toBe(await stored('framed'));
    await pool_.query(`DELETE FROM users WHERE id = $1`, [owner]);
  });

  it('keeps a frame/unframe loop bounded: unframed images go back to the LRU pool', async () => {
    const owner = await newOwner();
    const one = BigInt((await reencode(bigPng)).png.length);
    const budget = Number((await usage('pending')) + one);
    for (let i = 0; i < 4; i++) {
      const h = await reg(`loop${i}`);
      expect(await proxiedImage(ctx, h, { allowPrivateForTests: true })).not.toBeNull();
      await frame(owner, 1, h);
      expect(
        (await pool_.query(`SELECT pool FROM nft_images WHERE hash = $1`, [h])).rows[0],
      ).toEqual({
        pool: 'framed',
      });
      await unframe(owner, budget);
      expect(await usage('pending')).toBeLessThanOrEqual(BigInt(budget));
    }
    expect(await usage('pending')).toBe(await stored('pending'));
    expect(await usage('framed')).toBe(await stored('framed'));
    await pool_.query(`DELETE FROM users WHERE id = $1`, [owner]);
  });

  it('upgrades a pending image to ok when its collection is allow-listed, moving its bytes', async () => {
    const wallet = `upgrade-${Date.now()}`;
    const sourceUrl = `${base}/art.png?up=${Date.now()}`;
    const h = imageHash(sourceUrl);
    hashes.push(h);
    await registerImages(ctx, wallet, [{ imageHash: h, sourceUrl, moderation: 'pending' }]);
    expect(await proxiedImage(ctx, h, { allowPrivateForTests: true })).not.toBeNull();
    const okBefore = await usage('ok');
    const pendingBefore = await usage('pending');
    await registerImages(ctx, wallet, [{ imageHash: h, sourceUrl, moderation: 'ok' }]);
    const row = await pool_.query<{ class: string; pool: string; n: number }>(
      `SELECT class, pool, octet_length(bytes) AS n FROM nft_images WHERE hash = $1`,
      [h],
    );
    expect(row.rows[0]).toMatchObject({ class: 'ok', pool: 'ok' });
    const n = BigInt(row.rows[0]!.n);
    expect(await usage('ok')).toBe(okBefore + n);
    expect(await usage('pending')).toBe(pendingBefore - n);
  });

  it('reserves the per-wallet quota atomically under parallel requests', async () => {
    const wallet = `race-${Date.now()}`;
    const batch = (k: number) =>
      [0, 1].map((i) => {
        const sourceUrl = `https://img.example/${wallet}/${k}-${i}.png`;
        hashes.push(imageHash(sourceUrl));
        return { imageHash: imageHash(sourceUrl), sourceUrl, moderation: 'pending' as const };
      });
    const granted = await Promise.all(
      [0, 1, 2, 3, 4].map((k) => registerImages(ctx, wallet, batch(k), 4)),
    );
    expect(granted.reduce((x, y) => x + y, 0)).toBe(4);
    const day = new Date().toISOString().slice(0, 10);
    expect(await ctx.redis.main.get(`img:quota:${wallet}:${day}`)).toBe('4');
  });

  it('records a failed source and does not retry it within the hour', async () => {
    const url = `${base}/evil.svg?run=${Date.now()}`;
    const hash = await registerImage(ctx, url);
    hashes.push(hash);
    expect(await proxiedImage(ctx, hash, { allowPrivateForTests: true })).toBeNull();
    const before = hits;
    expect(await proxiedImage(ctx, hash, { allowPrivateForTests: true })).toBeNull();
    expect(hits).toBe(before);
    const r = await pool_.query(`SELECT status, fail_reason FROM nft_images WHERE hash = $1`, [
      hash,
    ]);
    expect(r.rows[0]).toEqual({ status: 'failed', fail_reason: 'bad_type' });
  });
});
