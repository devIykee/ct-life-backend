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
 *     Every address the host resolves to must be public: loopback, private,
 *     link-local, CGNAT and ULA ranges are refused, and the connection is
 *     pinned to the checked address (no DNS rebinding). Up to 3 redirects,
 *     each checked the same way.
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
import type { AppContext } from './context.js';
import { nftGalleryConfig } from './nft-gallery-config.js';

const SOURCE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'];
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const RETRY_FAILED_MS = 3_600_000;
const MAX_INPUT_PIXELS = 40_000_000;

const blocked = new BlockList();
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
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(net, bits, 'ipv6');
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
  if (fam === 6) return blocked.check(ip, 'ipv6');
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
}

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

/**
 * GET a URL under the proxy's rules.
 * @param url - The https URL.
 * @param opts - Size cap (and the test-only escape hatch).
 * @returns The body and its content type.
 */
export async function fetchSource(
  url: string,
  opts: FetchOptions,
  redirects = 0,
): Promise<{ body: Buffer; contentType: string }> {
  const u = new URL(url);
  const local = opts.allowPrivateForTests === true;
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('not_https');
  if (!local && isIP(u.hostname) && isPrivateAddress(u.hostname))
    throw new Error('blocked_address');
  const req = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = req(
      u,
      {
        method: 'GET',
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
          return resolve(fetchSource(next, opts, redirects + 1));
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
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
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

/**
 * The PNG for a registered hash: from the cache, or fetched and re-encoded
 * now. Null for an unknown hash, or a source that failed (retried hourly).
 * @param ctx - The app context.
 * @param hash - The proxy key.
 * @param opts - Test-only fetch options.
 * @returns The image, or null.
 */
export async function proxiedImage(
  ctx: AppContext,
  hash: string,
  opts: Partial<FetchOptions> = {},
): Promise<ServedImage | null> {
  if (!/^[0-9a-f]{40}$/.test(hash)) return null;
  const r = await ctx.db.withConnection((c) =>
    c.query<{ source_url: string; status: string; bytes: Buffer | null; fetched_at: Date | null }>(
      `SELECT source_url, status, bytes, fetched_at FROM nft_images WHERE hash = $1`,
      [hash],
    ),
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.status === 'ok' && row.bytes) return { png: row.bytes };
  if (
    row.status === 'failed' &&
    row.fetched_at &&
    Date.now() - row.fetched_at.getTime() < RETRY_FAILED_MS
  ) {
    return null;
  }
  // One fetch per image at a time across replicas.
  const lock = await ctx.redis.main.set(`img:fetch:${hash}`, '1', 'EX', 30, 'NX');
  if (lock !== 'OK') return null;
  try {
    const src = await fetchSource(row.source_url, {
      maxBytes: nftGalleryConfig().maxSourceBytes,
      ...opts,
    });
    const out = await reencode(src.body);
    await ctx.db.withConnection((c) =>
      c.query(
        `UPDATE nft_images SET status = 'ok', mime = 'image/png', width = $2, height = $3,
                bytes = $4, fail_reason = NULL, fetched_at = now()
          WHERE hash = $1`,
        [hash, out.width, out.height, out.png],
      ),
    );
    return { png: out.png };
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
    await ctx.redis.main.del(`img:fetch:${hash}`);
  }
}
