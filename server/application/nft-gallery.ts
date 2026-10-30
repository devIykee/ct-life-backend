/**
 * Home NFT gallery (unlock D4, capability `nftGallery`). Read-only.
 *
 *   GET /v1/nfts/me?limit=&cursor=      the caller's NFTs (Helius DAS)
 *   GET /v1/homes/{ownerId}/gallery     the framed wall (visitor policy applies)
 *   PUT /v1/homes/me/gallery {frames}   frame NFTs the caller holds
 *
 * Holdings come from Helius DAS `getAssetsByOwner` (page 1, up to 1000):
 *   - devnet: every NFT the wallet holds; `moderation: 'ok'` only for the
 *     collections in nft_gallery.json `devnetCollections` (the CT Life
 *     collection once it exists), `pending` for the rest (owner-only);
 *   - mainnet: read-only, and only NFTs in `mainnetCollections` (all `ok`).
 *     DAS has no NSFW flag, which is why nothing outside a list is shown to
 *     visitors. With `showUnverifiedCollections` off (the default), DAS
 *     returns a collection grouping only when it is verified.
 * One call per network per wallet, cached `holdingsCacheSec` (10 min) in
 * Redis, and every DAS call goes through a shared per-second limiter
 * (`dasRequestsPerSecond`, the free plan's 2/s).
 *
 * Images go through the proxy (nft-images.ts): `imageUrl` is our own
 * `/v1/img/{hash}`, always a PNG.
 *
 * Nothing here mints, transfers or signs. The daily worker
 * (`recheckFrames`) removes a frame whose asset left the wallet.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  ServerBusyError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { createHeliusClient, HeliusError, type HeliusClient } from '../shared/solana/helius.js';
import type { AppContext } from './context.js';
import { homeEntryRefusal } from './homes.js';
import { policyRefusalError, visitorPolicyRefusal } from './home-settings.js';
import { nftGalleryConfig } from './nft-gallery-config.js';
import { imageHash, normalizeImageUri, upgradeToOk } from './nft-images.js';

export type Network = 'devnet' | 'mainnet';
export type Moderation = 'ok' | 'pending' | 'nsfw' | 'blocked';

export interface NftItem {
  readonly assetId: string;
  readonly name: string;
  readonly collection: string | null;
  readonly imageUrl: string;
  readonly mime: 'image/png';
  readonly moderation: Moderation;
  readonly network: Network;
}

interface Holding extends NftItem {
  readonly imageHash: string;
  readonly sourceUrl: string;
}

interface DasAsset {
  id: string;
  interface?: string;
  burnt?: boolean;
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string; mime?: string }>;
  };
  grouping?: Array<{ group_key?: string; group_value?: string }>;
  ownership?: { owner?: string };
}

const NFT_INTERFACES = new Set([
  'V1_NFT',
  'V2_NFT',
  'LEGACY_NFT',
  'ProgrammableNFT',
  'MplCoreAsset',
  'MplCore',
]);

/** The DAS endpoint for a network: the configured RPC URL with the API key. */
function dasUrl(ctx: AppContext, network: Network): string {
  const h = ctx.config.helius;
  const u = new URL(network === 'devnet' ? h.rpcUrlDevnet : h.rpcUrlMainnet);
  if (!u.searchParams.has('api-key') && h.apiKey) u.searchParams.set('api-key', h.apiKey);
  return u.toString();
}

const clients = new Map<string, HeliusClient>();

function dasClient(ctx: AppContext, network: Network): HeliusClient {
  const url = dasUrl(ctx, network);
  let c = clients.get(url);
  if (!c) {
    c = createHeliusClient({ url, apiKey: ctx.config.helius.apiKey });
    clients.set(url, c);
  }
  return c;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for a slot in the shared per-second DAS budget (all processes). */
async function dasSlot(ctx: AppContext): Promise<void> {
  const limit = nftGalleryConfig().dasRequestsPerSecond;
  for (let i = 0; i < 12; i++) {
    const sec = Math.floor(Date.now() / 1000);
    const key = `das:rl:${sec}`;
    const n = await ctx.redis.main.incr(key);
    if (n === 1) await ctx.redis.main.expire(key, 2);
    if (n <= limit) return;
    await sleep(1000 - (Date.now() % 1000) + Math.floor(Math.random() * 50));
  }
  throw new RateLimitedError(1000, { reason: 'das_busy' });
}

/**
 * One DAS call, rate-limited, with Helius failures mapped to domain errors.
 * DAS takes object params; the client's `rpc` is typed for array params, and
 * Helius accepts either shape in the JSON-RPC body.
 */
async function das<T>(
  ctx: AppContext,
  network: Network,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  await dasSlot(ctx);
  try {
    return await dasClient(ctx, network).rpc<T>(method, params as unknown as unknown[]);
  } catch (e) {
    if (e instanceof HeliusError) {
      if (e.code === 'RATE_LIMITED') throw new RateLimitedError(2000, { reason: 'das_busy' });
      throw new ServerBusyError(5000, { reason: 'das_unavailable' });
    }
    throw e;
  }
}

function collectionOf(a: DasAsset): string | null {
  return a.grouping?.find((g) => g.group_key === 'collection')?.group_value ?? null;
}

/** The API host serving `/v1/img`, from PUBLIC_API_BASE_URL (empty = relative URLs). */
export function imageBase(ctx: AppContext): string {
  return ctx.config.factory.publicBaseUrl.replace(/\/$/, '');
}

function toHolding(ctx: AppContext, a: DasAsset, network: Network): Holding | null {
  if (a.burnt || !a.interface || !NFT_INTERFACES.has(a.interface)) return null;
  const cfg = nftGalleryConfig();
  const collection = collectionOf(a);
  const allow = network === 'devnet' ? cfg.devnetCollections : cfg.mainnetCollections;
  const listed = collection !== null && allow.some((c) => c.address === collection);
  if (network === 'mainnet' && !listed) return null; // mainnet: allow-listed only
  const file = a.content?.files?.[0];
  const src =
    normalizeImageUri(file?.cdn_uri) ??
    normalizeImageUri(a.content?.links?.image) ??
    normalizeImageUri(file?.uri);
  if (!src) return null;
  const hash = imageHash(src);
  return {
    assetId: a.id,
    name: (a.content?.metadata?.name ?? '').slice(0, 80) || 'Untitled',
    collection,
    imageUrl: `${imageBase(ctx)}/v1/img/${hash}`,
    mime: 'image/png',
    moderation: listed ? 'ok' : 'pending',
    network,
    imageHash: hash,
    sourceUrl: src,
  };
}

async function walletOf(ctx: AppContext, userId: string): Promise<string> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ wallet: string }>(`SELECT wallet FROM users WHERE id = $1`, [userId]),
  );
  const w = r.rows[0]?.wallet;
  if (!w) throw new NotFoundError({ resource: 'user', id: userId });
  return w;
}

/**
 * Register holdings' image URLs with the proxy (only URLs read from DAS are
 * ever fetched). Allow-listed (`ok`) images always register; images of
 * anything else anyone can mint count against a per-wallet daily quota of new
 * URLs (`maxNewImagesPerWalletPerDay`, reserved atomically in Redis), so one
 * wallet cannot grow the registry without bound. Past the quota an item still
 * lists, its image 404s.
 * @param ctx - The app context.
 * @param wallet - The owner's wallet.
 * @param items - The holdings.
 * @param limit - Quota override (tests).
 * @returns How many new pending URLs were registered.
 */
export async function registerImages(
  ctx: AppContext,
  wallet: string,
  items: ReadonlyArray<{ imageHash: string; sourceUrl: string; moderation: Moderation }>,
  limit: number = nftGalleryConfig().maxNewImagesPerWalletPerDay,
): Promise<number> {
  if (items.length === 0) return 0;
  const known = await ctx.db.withConnection((c) =>
    c.query<{ hash: string }>(`SELECT hash FROM nft_images WHERE hash = ANY($1::text[])`, [
      items.map((h) => h.imageHash),
    ]),
  );
  const have = new Set(known.rows.map((r) => r.hash));
  // Allow-listed images always register, and upgrade a row first seen as pending.
  const ok = items.filter((h) => h.moderation === 'ok');
  // Only new pending URLs count against the quota.
  const pending = items.filter((h) => h.moderation !== 'ok' && !have.has(h.imageHash));
  const key = `img:quota:${wallet}:${new Date().toISOString().slice(0, 10)}`;
  let granted = 0;
  if (pending.length > 0) {
    // Reserve atomically: INCRBY first, keep what fits under the limit, give
    // the rest back. Two parallel requests can never both pass the limit.
    const after = await ctx.redis.main.incrby(key, pending.length);
    if (after === pending.length) await ctx.redis.main.expire(key, 86_400);
    granted = Math.max(0, Math.min(pending.length, limit - (after - pending.length)));
    if (granted < pending.length) await ctx.redis.main.decrby(key, pending.length - granted);
  }
  const take = pending.slice(0, granted);
  const insert = async (rows: typeof items, cls: 'ok' | 'pending'): Promise<void> => {
    if (rows.length === 0) return;
    await ctx.db.withConnection((c) =>
      c.query(
        `INSERT INTO nft_images (hash, source_url, class)
         SELECT h, u, $3 FROM unnest($1::text[], $2::text[]) AS t(h, u)
         ON CONFLICT (hash) DO NOTHING`,
        [rows.map((h) => h.imageHash), rows.map((h) => h.sourceUrl), cls],
      ),
    );
  };
  await insert(ok, 'ok');
  if (ok.length > 0) {
    await runInTransaction((c) =>
      upgradeToOk(
        c,
        ok.map((h) => h.imageHash),
      ),
    );
  }
  await insert(take, 'pending');
  return granted;
}

async function readHoldings(ctx: AppContext, wallet: string): Promise<Holding[]> {
  const cfg = nftGalleryConfig();
  const networks: Network[] =
    cfg.mainnetCollections.length > 0 ? ['devnet', 'mainnet'] : ['devnet'];
  const out: Holding[] = [];
  for (const network of networks) {
    const res = await das<{ items?: DasAsset[] }>(ctx, network, 'getAssetsByOwner', {
      ownerAddress: wallet,
      page: 1,
      limit: 1000,
    });
    for (const a of res.items ?? []) {
      const h = toHolding(ctx, a, network);
      if (h) out.push(h);
    }
  }
  await registerImages(ctx, wallet, out);
  return out.sort((x, y) => x.network.localeCompare(y.network) || x.name.localeCompare(y.name));
}

/**
 * The wallet's NFTs, cached per wallet for `holdingsCacheSec`.
 * @param ctx - The app context.
 * @param userId - The player.
 * @returns The wallet and its gallery-eligible NFTs.
 */
export async function holdingsOf(
  ctx: AppContext,
  userId: string,
): Promise<{ wallet: string; items: Holding[] }> {
  const wallet = await walletOf(ctx, userId);
  const key = `nft:holdings:${wallet}`;
  const hit = await ctx.redis.main.get(key);
  if (hit) return { wallet, items: JSON.parse(hit) as Holding[] };
  const items = await readHoldings(ctx, wallet);
  await ctx.redis.main.set(key, JSON.stringify(items), 'EX', nftGalleryConfig().holdingsCacheSec);
  return { wallet, items };
}

function publicItem(h: Holding): NftItem {
  return {
    assetId: h.assetId,
    name: h.name,
    collection: h.collection,
    imageUrl: h.imageUrl,
    mime: h.mime,
    moderation: h.moderation,
    network: h.network,
  };
}

/**
 * GET /nfts/me: one page of the caller's NFTs.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param q - `limit` (1..100, default 100) and `cursor` (opaque).
 * @param q.limit - Page size.
 * @param q.cursor - Cursor from the previous page.
 * @returns The page.
 */
export async function listMyNfts(
  ctx: AppContext,
  userId: string,
  q: { limit?: number; cursor?: string },
): Promise<{ wallet: string; items: NftItem[]; cursor: string | null }> {
  const limit = q.limit ?? 100;
  const offset = q.cursor ? Number.parseInt(q.cursor, 10) : 0;
  if (!Number.isInteger(offset) || offset < 0 || String(offset) !== (q.cursor ?? '0')) {
    throw new ValidationFailedError({ reason: 'bad_cursor' });
  }
  const { wallet, items } = await holdingsOf(ctx, userId);
  const page = items.slice(offset, offset + limit).map(publicItem);
  const next = offset + limit < items.length ? String(offset + limit) : null;
  return { wallet, items: page, cursor: next };
}

export interface Gallery {
  readonly frames: Array<{ slot: number; assetId: string }>;
  readonly items: NftItem[];
}

async function readFrames(ctx: AppContext, ownerId: string, ownerView: boolean): Promise<Gallery> {
  const base = imageBase(ctx);
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      slot: number;
      asset_id: string;
      network: Network;
      name: string;
      collection: string | null;
      image_hash: string;
      moderation: Moderation;
    }>(
      `SELECT slot, asset_id, network, name, collection, image_hash, moderation
         FROM home_gallery_frames
        WHERE owner_user_id = $1 ${ownerView ? '' : `AND moderation = 'ok'`}
        ORDER BY slot`,
      [ownerId],
    ),
  );
  return {
    frames: r.rows.map((f) => ({ slot: f.slot, assetId: f.asset_id })),
    items: r.rows.map((f) => ({
      assetId: f.asset_id,
      name: f.name,
      collection: f.collection,
      imageUrl: `${base}/v1/img/${f.image_hash}`,
      mime: 'image/png',
      moderation: f.moderation,
      network: f.network,
    })),
  };
}

/**
 * GET /homes/{ownerId}/gallery. The owner sees every frame; a visitor needs
 * the same access as a visit (visitor policy, then the door) and sees only
 * `moderation: 'ok'` frames.
 * @param ctx - The app context.
 * @param viewerId - The caller.
 * @param ownerId - The home owner (`me` = the caller).
 * @returns The wall.
 */
export async function getGallery(
  ctx: AppContext,
  viewerId: string,
  ownerId: string,
): Promise<Gallery> {
  const owner = ownerId === 'me' ? viewerId : ownerId;
  if (owner === viewerId) return readFrames(ctx, owner, true);
  const home = await ctx.db.withConnection((c) =>
    c.query<{ home_id: string }>(
      `SELECT home_id FROM homes
        WHERE owner_user_id::text = $1 AND status IN ('active', 'overdue')
        ORDER BY created_at DESC LIMIT 1`,
      [owner],
    ),
  );
  const homeId = home.rows[0]?.home_id;
  if (!homeId) throw new NotFoundError({ resource: 'home', id: owner });
  const policy = await ctx.db.withConnection((c) =>
    visitorPolicyRefusal(c, { homeId, ownerUserId: owner }, viewerId),
  );
  if (policy !== null) throw policyRefusalError(policy);
  if ((await homeEntryRefusal(ctx, homeId, viewerId)) !== null) {
    throw new ForbiddenError({ reason: 'locked' });
  }
  return readFrames(ctx, owner, false);
}

/**
 * PUT /homes/me/gallery: replace the caller's frames. Every asset must be in
 * the caller's current holdings.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param frames - The new frames.
 * @returns The wall, as the owner sees it.
 */
export async function putGallery(
  ctx: AppContext,
  userId: string,
  frames: Array<{ slot: number; assetId: string }>,
): Promise<Gallery> {
  const max = nftGalleryConfig().maxSlots;
  for (const f of frames) {
    if (f.slot < 1 || f.slot > max) {
      throw new ValidationFailedError({ reason: 'slot_out_of_range', min: 1, max });
    }
  }
  if (new Set(frames.map((f) => f.slot)).size !== frames.length) {
    throw new ValidationFailedError({ reason: 'duplicate_slot' });
  }
  if (new Set(frames.map((f) => f.assetId)).size !== frames.length) {
    throw new ValidationFailedError({ reason: 'duplicate_asset' });
  }
  const held =
    frames.length > 0
      ? new Map((await holdingsOf(ctx, userId)).items.map((h) => [h.assetId, h]))
      : new Map<string, Holding>();
  for (const f of frames) {
    if (!held.has(f.assetId)) throw new ForbiddenError({ reason: 'not_owner', assetId: f.assetId });
  }
  // Register the framed images like any other: allow-listed ones as `ok`, the
  // rest as `pending` under the same per-wallet quota. Framing never exempts an
  // image from the budget (a frame/unframe loop must not grow storage); it
  // only protects it from eviction while the frame stays.
  const chosen = frames.map((f) => held.get(f.assetId)!);
  await registerImages(ctx, await walletOf(ctx, userId), chosen);
  const known = await ctx.db.withConnection((c) =>
    c.query<{ hash: string }>(`SELECT hash FROM nft_images WHERE hash = ANY($1::text[])`, [
      chosen.map((h) => h.imageHash),
    ]),
  );
  const have = new Set(known.rows.map((r) => r.hash));
  const missing = chosen.find((h) => !have.has(h.imageHash));
  if (missing) {
    throw new RateLimitedError(3_600_000, { reason: 'image_quota', assetId: missing.assetId });
  }
  await runInTransaction(async (client) => {
    await client.query(`DELETE FROM home_gallery_frames WHERE owner_user_id = $1`, [userId]);
    for (const f of frames) {
      const h = held.get(f.assetId)!;
      await client.query(
        `INSERT INTO home_gallery_frames
           (owner_user_id, slot, asset_id, network, name, collection, image_hash, moderation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, f.slot, f.assetId, h.network, h.name, h.collection, h.imageHash, h.moderation],
      );
    }
  });
  return readFrames(ctx, userId, true);
}

/**
 * Daily ownership re-check: drop frames whose asset is burnt or no longer in
 * the owner's wallet (DAS getAssetBatch, up to 1000 ids per call).
 * @param ctx - The app context.
 * @param now - The current time.
 * @param maxOwners - How many owners to check this run.
 * @returns How many frames were removed.
 */
export async function recheckFrames(
  ctx: AppContext,
  now: Date = new Date(),
  maxOwners = 200,
): Promise<number> {
  const owners = await ctx.db.withConnection((c) =>
    c.query<{ owner_user_id: string; wallet: string }>(
      `SELECT DISTINCT f.owner_user_id, u.wallet
         FROM home_gallery_frames f JOIN users u ON u.id = f.owner_user_id
        WHERE f.checked_at < $1::timestamptz - interval '20 hours'
        LIMIT $2`,
      [now, maxOwners],
    ),
  );
  let removed = 0;
  for (const o of owners.rows) {
    const frames = await ctx.db.withConnection((c) =>
      c.query<{ asset_id: string; network: Network }>(
        `SELECT asset_id, network FROM home_gallery_frames WHERE owner_user_id = $1`,
        [o.owner_user_id],
      ),
    );
    const gone: string[] = [];
    for (const network of ['devnet', 'mainnet'] as const) {
      const ids = frames.rows.filter((f) => f.network === network).map((f) => f.asset_id);
      if (ids.length === 0) continue;
      const assets = await das<Array<DasAsset | null>>(ctx, network, 'getAssetBatch', { ids });
      const byId = new Map(assets.filter((a): a is DasAsset => a !== null).map((a) => [a.id, a]));
      for (const id of ids) {
        const a = byId.get(id);
        if (!a || a.burnt || a.ownership?.owner !== o.wallet) gone.push(id);
      }
    }
    await ctx.db.withConnection(async (c) => {
      if (gone.length > 0) {
        const r = await c.query(
          `DELETE FROM home_gallery_frames WHERE owner_user_id = $1 AND asset_id = ANY($2::text[])`,
          [o.owner_user_id, gone],
        );
        removed += r.rowCount ?? 0;
      }
      await c.query(`UPDATE home_gallery_frames SET checked_at = $2 WHERE owner_user_id = $1`, [
        o.owner_user_id,
        now,
      ]);
    });
    // The holdings cache would still list a sold asset for a few minutes.
    if (gone.length > 0) await ctx.redis.main.del(`nft:holdings:${o.wallet}`);
  }
  return removed;
}
