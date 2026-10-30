/**
 * NFT image proxy (unlock D4): `GET /v1/img/{hash}`.
 *
 * NFT metadata is written by whoever minted the NFT, so an image URL can
 * point anywhere: a huge file, an SVG, or an address inside our network.
 * The client only loads images from our own host (config `nft.imageHosts`),
 * and this proxy is the only thing that fetches the real URL:
 *
 *   - Only URLs the server itself read from a DAS result are fetchable: the
 *     hash is registered (`registerImage`) when holdings are listed, and the
 *     route serves nothing for an unknown hash.
 *   - https only (ipfs:// and ar:// are mapped to public gateways first).
 *     IP-literal hosts are refused. Every address a host resolves to must be
 *     public: loopback, private, link-local, CGNAT, ULA, site-local, NAT64,
 *     6to4, IPv4-compatible and IPv4-mapped IPv6 are refused; the connection
 *     is pinned to the checked address and the peer address is checked again
 *     on connect (no DNS rebinding). Up to 3 redirects, each checked the same
 *     way. One 10 s deadline covers the whole fetch (slow sources included),
 *     at most 4 fetches at once per process. Images of allow-listed or framed
 *     NFTs (`ok`) are exempt from the byte budget; every other image
 *     (`pending`: anyone can mint one) shares `maxPendingImageBytes`, with the
 *     least recently served unframed ones evicted to make room. Byte totals
 *     are running counters (`nft_image_usage`), updated in the same
 *     transaction as the bytes.
 *   - Source type must be PNG, JPEG, GIF, WebP or AVIF (no SVG); at most
 *     `maxSourceBytes`, 10 s; at most 40 MP decoded (no decompression bombs).
 *   - Re-encoded with sharp to a palette PNG no larger than `maxImagePx` on
 *     either side and `maxImageBytes`, stripped of metadata, first frame only.
 *
 * Results (and failures) are stored in `nft_images`; a failed source is
 * retried after an hour.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { BlockList, isIP } from 'node:net';
import sharp from 'sharp';
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import type { AppContext } from './context.js';
import { nftGalleryConfig } from './nft-gallery-config.js';

const SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const RETRY_FAILED_MS = 3_600_000;
const MAX_INPUT_PIXELS = 40_000_000;

// Two lists: Node's BlockList matches an IPv4 address against IPv4-mapped IPv6
// subnets, so `::ffff:0:0/96` in a shared list would block every IPv4 address.
const blocked = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback and IPv4-compatible ::a.b.c.d
  ['::ffff:0:0', 96], // IPv4-mapped, any form
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF special-purpose (Teredo, ORCHID, benchmarking...)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds an IPv4 address)
  ['fc00::', 7], // ULA (e.g. Railway's private network)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  blocked6.addSubnet(net, bits, 'ipv6');
}

/**
 * Whether an IP address is one the proxy must never connect to.
 * @param ip - An IPv4 or IPv6 literal.
 * @returns True for loopback, private, link-local, CGNAT, ULA, multicast...
 */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]!);
  const fam = isIP(ip);
  if (fam === 4) return blocked.check(ip, 'ipv4');
  if (fam === 6) return blocked6.check(ip, 'ipv6');
  return true;
}

/**
 * The fetchable https URL for a metadata image URI, or null.
 * @param uri - `https://`, `ipfs://` or `ar://` from NFT metadata.
 * @returns An https URL, or null when the scheme is not allowed.
 */
export function normalizeImageUri(uri: string | undefined | null): string | null {
  if (!uri) return null;
  const u = uri.trim();
  if (u.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${u.slice(7).replace(/^ipfs\//, '')}`;
  if (u.startsWith('ar://')) return `https://arweave.net/${u.slice(5)}`;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' && p.username === '' && p.password === '' ? p.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The proxy key of a source URL.
 * @param url - The normalized https URL.
 * @returns 40 hex chars of its SHA-256.
 */
export function imageHash(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 40);
}

/**
 * Register a source URL so the proxy may fetch it (idempotent).
 * @param ctx - The app context.
 * @param url - The normalized https URL.
 * @returns Its hash.
 */
export async function registerImage(ctx: AppContext, url: string): Promise<string> {
  const hash = imageHash(url);
  await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO nft_images (hash, source_url) VALUES ($1, $2) ON CONFLICT (hash) DO NOTHING`,
      [hash, url],
    ),
  );
  return hash;
}

export interface FetchOptions {
  /** Test-only: allow http and private addresses (a local server). Never set from config. */
  readonly allowPrivateForTests?: boolean;
  readonly maxBytes: number;
  /** Whole-request deadline, redirects included (default 10 s). */
  readonly timeoutMs?: number;
}

/** Fetches in flight in this process; more than this and the proxy says "not now". */
const MAX_CONCURRENT_FETCHES = 4;
let inFlight = 0;

type Lookup = (
  hostname: string,
  options: object,
  cb: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

/** A DNS lookup that fails unless every resolved address is public, and pins one. */
const publicOnlyLookup: Lookup = (hostname, _options, cb) => {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err, '', 4);
    const list = addrs as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }), '', 4);
    }
    const first = list[0]!;
    cb(null, first.address, first.family);
  });
};

/** The host of a URL without IPv6 brackets. */
function bareHost(u: URL): string {
  return u.hostname.replace(/^\[|\]$/g, '');
}

/**
 * GET a URL under the proxy's rules.
 *
 * IP-literal hosts are refused outright (`https://[::1]/`, `https://10.0.0.1/`):
 * Node skips the custom DNS lookup for them, and NFT images never need one.
 * Named hosts resolve through `publicOnlyLookup`, and the socket's actual
 * remote address is checked again on connect (DNS-rebinding safe). One
 * deadline covers the whole request, redirects and slow bodies included.
 * @param url - The https URL.
 * @param opts - Size cap, deadline (and the test-only escape hatch).
 * @returns The body and its content type.
 */
export async function fetchSource(
  url: string,
  opts: FetchOptions,
): Promise<{ body: Buffer; contentType: string }> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS);
  return fetchOnce(url, opts, signal, 0);
}

async function fetchOnce(
  url: string,
  opts: FetchOptions,
  signal: AbortSignal,
  redirects: number,
): Promise<{ body: Buffer; contentType: string }> {
  const u = new URL(url);
  const local = opts.allowPrivateForTests === true;
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('not_https');
  if (!local && isIP(bareHost(u)) !== 0) throw new Error('ip_literal');
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(
      u,
      {
        method: 'GET',
        signal,
        timeout: TIMEOUT_MS,
        headers: { accept: SOURCE_TYPES.join(', '), 'user-agent': 'ct-life-img-proxy' },
        ...(local ? {} : { lookup: publicOnlyLookup }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirects >= MAX_REDIRECTS) return reject(new Error('too_many_redirects'));
          const next = new URL(res.headers.location, u).toString();
          return resolve(fetchOnce(next, opts, signal, redirects + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`http_${status}`));
        }
        const type = String(res.headers['content-type'] ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        if (!SOURCE_TYPES.includes(type)) {
          res.resume();
          return reject(new Error('bad_type'));
        }
        const declared = Number(res.headers['content-length'] ?? '0');
        if (declared > opts.maxBytes) {
          res.destroy();
          return reject(new Error('too_large'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            reject(new Error('too_large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks), contentType: type }));
        res.on('error', reject);
      },
    );
    // Belt and braces: whatever the lookup said, refuse a private peer.
    r.on('socket', (sock) => {
      const check = (): void => {
        const ip = sock.remoteAddress;
        if (!local && ip && isPrivateAddress(ip)) r.destroy(new Error('blocked_address'));
      };
      sock.once('connect', check);
      sock.once('secureConnect', check);
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => reject(signal.aborted ? new Error('timeout') : e));
    r.end();
  });
}

/**
 * Re-encode an image to a palette PNG within the size limits.
 * @param input - The source bytes.
 * @returns The PNG and its dimensions.
 */
export async function reencode(
  input: Buffer,
): Promise<{ png: Buffer; width: number; height: number }> {
  const cfg = nftGalleryConfig();
  for (const px of [cfg.maxImagePx, Math.round(cfg.maxImagePx * 0.75), cfg.maxImagePx / 2]) {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .rotate()
      .resize(px, px, { fit: 'inside', withoutEnlargement: true })
      .png({ palette: true, compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    if (data.length <= cfg.maxImageBytes)
      return { png: data, width: info.width, height: info.height };
  }
  throw new Error('too_large_after_reencode');
}

export interface ServedImage {
  readonly png: Buffer;
}

const EVICT_BATCH = 50;

/**
 * Make room in the pending budget: drop the bytes of the least recently served
 * pending images that no wall frames (they go back to `pending` and are
 * fetched again if someone asks). Runs in the caller's transaction, with the
 * usage row locked, so the counter always equals the stored bytes.
 * @returns The pending bytes in use after eviction.
 */
async function makePendingRoom(
  c: Pick<PoolClient, 'query'>,
  need: number,
  budget: number,
): Promise<bigint> {
  const u = await c.query<{ bytes: string }>(
    `SELECT bytes FROM nft_image_usage WHERE class = 'pending' FOR UPDATE`,
  );
  let used = BigInt(u.rows[0]?.bytes ?? '0');
  if (used + BigInt(need) <= BigInt(budget)) return used;
  const victims = await c.query<{ hash: string; n: number }>(
    `SELECT hash, octet_length(bytes) AS n FROM nft_images i
      WHERE class = 'pending' AND status = 'ok'
        AND NOT EXISTS (SELECT 1 FROM home_gallery_frames f WHERE f.image_hash = i.hash)
      ORDER BY COALESCE(last_served_at, fetched_at) NULLS FIRST
      LIMIT $1
        FOR UPDATE SKIP LOCKED`,
    [EVICT_BATCH],
  );
  const drop: string[] = [];
  let freed = 0n;
  for (const v of victims.rows) {
    if (used - freed + BigInt(need) <= BigInt(budget)) break;
    drop.push(v.hash);
    freed += BigInt(v.n);
  }
  if (drop.length > 0) {
    await c.query(
      `UPDATE nft_images SET status = 'pending', bytes = NULL, mime = NULL, width = NULL, height = NULL
        WHERE hash = ANY($1::text[])`,
      [drop],
    );
    await c.query(`UPDATE nft_image_usage SET bytes = bytes - $1 WHERE class = 'pending'`, [
      freed.toString(),
    ]);
    used -= freed;
  }
  return used;
}

/**
 * Store a re-encoded image and count its bytes, in one transaction. A pending
 * image that still does not fit after eviction is not stored.
 * @returns False when the pending budget is full.
 */
async function storeImage(
  hash: string,
  out: { png: Buffer; width: number; height: number },
  budget: number,
): Promise<boolean> {
  return runInTransaction(async (c) => {
    const row = await c.query<{ class: 'ok' | 'pending'; status: string }>(
      `SELECT class, status FROM nft_images WHERE hash = $1 FOR UPDATE`,
      [hash],
    );
    const r = row.rows[0];
    if (!r) return false;
    if (r.status === 'ok') return true; // another replica stored it
    if (r.class === 'pending') {
      const used = await makePendingRoom(c, out.png.length, budget);
      if (used + BigInt(out.png.length) > BigInt(budget)) return false;
    }
    await c.query(
      `UPDATE nft_images SET status = 'ok', mime = 'image/png', width = $2, height = $3,
              bytes = $4, fail_reason = NULL, fetched_at = now(), last_served_at = now()
        WHERE hash = $1`,
      [hash, out.width, out.height, out.png],
    );
    await c.query(`UPDATE nft_image_usage SET bytes = bytes + $1 WHERE class = $2`, [
      out.png.length,
      r.class,
    ]);
    return true;
  });
}

export interface ServedImage {
  readonly png: Buffer;
}

/**
 * The PNG for a registered hash: from the cache, or fetched and re-encoded
 * now. Null for an unknown hash, a source that failed (retried hourly), a full
 * pending budget, or too many fetches in flight.
 *
 * Budget: `ok` images (allow-listed, or framed by their owner) are exempt;
 * `pending` images share `maxPendingImageBytes`, and the least recently served
 * unframed ones are evicted to make room, so nobody can fill the cache and
 * block everyone's gallery for good.
 * @param ctx - The app context.
 * @param hash - The proxy key.
 * @param opts - Test-only fetch options and budget override.
 * @returns The image, or null.
 */
export async function proxiedImage(
  ctx: AppContext,
  hash: string,
  opts: Partial<FetchOptions> & { maxPendingBytes?: number } = {},
): Promise<ServedImage | null> {
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      source_url: string;
      status: string;
      bytes: Buffer | null;
      fetched_at: Date | null;
      last_served_at: Date | null;
    }>(
      `SELECT source_url, status, bytes, fetched_at, last_served_at FROM nft_images WHERE hash = $1`,
      [hash],
    ),
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.status === 'ok' && row.bytes) {
    // LRU clock for eviction, written at most once an hour per image.
    if (!row.last_served_at || Date.now() - row.last_served_at.getTime() > 3_600_000) {
      await ctx.db.withConnection((c) =>
        c.query(`UPDATE nft_images SET last_served_at = now() WHERE hash = $1`, [hash]),
      );
    }
    return { png: row.bytes };
  }
  if (
    row.status === 'failed' &&
    row.fetched_at &&
    Date.now() - row.fetched_at.getTime() < RETRY_FAILED_MS
  ) {
    return null;
  }
  if (inFlight >= MAX_CONCURRENT_FETCHES) return null;
  // One fetch per image at a time across replicas.
  const lock = await ctx.redis.main.set(`img:fetch:${hash}`, '1', 'EX', 30, 'NX');
  if (lock !== 'OK') return null;
  inFlight++;
  try {
    const src = await fetchSource(row.source_url, {
      maxBytes: nftGalleryConfig().maxSourceBytes,
      ...opts,
    });
    const out = await reencode(src.body);
    const budget = opts.maxPendingBytes ?? nftGalleryConfig().maxPendingImageBytes;
    return (await storeImage(hash, out, budget)) ? { png: out.png } : null;
  } catch (e) {
    await ctx.db.withConnection((c) =>
      c.query(
        `UPDATE nft_images SET status = 'failed', fail_reason = $2, fetched_at = now()
          WHERE hash = $1 AND status <> 'ok'`,
        [hash, String((e as Error).message).slice(0, 100)],
      ),
    );
    return null;
  } finally {
    inFlight--;
    await ctx.redis.main.del(`img:fetch:${hash}`);
  }
}

/**
 * Mark images owner-approved (framed on a wall): class `ok`, exempt from the
 * pending budget. Moves their counted bytes in the same transaction.
 * @param c - A client inside the caller's transaction.
 * @param hashes - The framed images.
 */
export async function approveImages(c: Pick<PoolClient, 'query'>, hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  await c.query(`SELECT 1 FROM nft_image_usage ORDER BY class FOR UPDATE`);
  const moved = await c.query<{ n: string }>(
    `WITH up AS (
       UPDATE nft_images SET class = 'ok'
        WHERE hash = ANY($1::text[]) AND class = 'pending'
        RETURNING COALESCE(octet_length(bytes), 0) AS n
     ) SELECT COALESCE(sum(n), 0) AS n FROM up`,
    [hashes],
  );
  const n = moved.rows[0]?.n ?? '0';
  if (n !== '0') {
    await c.query(
      `UPDATE nft_image_usage SET bytes = bytes + CASE class WHEN 'ok' THEN $1::bigint ELSE -$1::bigint END`,
      [n],
    );
  }
}
