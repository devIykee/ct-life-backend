/**
 * Home NFT gallery over HTTP (unlock D4). Helius DAS is a real local
 * JSON-RPC server (HELIUS_RPC_URL_DEVNET / _MAINNET point at it), so nothing
 * external is called.
 *
 *   - GET /nfts/me: devnet NFTs (`pending` unless allow-listed), mainnet only
 *     allow-listed collections, fungibles and burnt assets dropped, paging,
 *     proxied PNG image URLs, one DAS call per network per wallet (cached);
 *   - PUT /homes/me/gallery: only held assets (403 not_owner), slot range,
 *     duplicates;
 *   - GET /homes/{ownerId}/gallery: the owner sees everything, a visitor
 *     only `ok` frames, the visitor policy applies, 404 without a home;
 *   - GET /img/{hash}: a cached PNG, 404 for an unknown hash;
 *   - the daily re-check drops a frame whose asset left the wallet;
 *   - config `nft` block and 503 while off.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootApi, errCode, errDetails, type TestApi, type TestPlayer } from './http-test-kit.js';
import { createDb } from '../shared/db/pool.js';
import { buildContext } from '../application/context.js';
import { recheckFrames } from '../application/nft-gallery.js';

const RUN = Date.now();
const MAD_LADS = 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w';
const OTHER = 'Other1111111111111111111111111111111111111';
let api: TestApi;
let das: Server;
let dasUrl = '';
const calls: Array<{ path: string; method: string }> = [];
/** wallet -> network -> assets */
const holdings = new Map<string, { devnet: unknown[]; mainnet: unknown[] }>();
const owners: string[] = [];
const db = (): ReturnType<typeof createDb> => createDb();

function asset(
  id: string,
  opts: { collection?: string; iface?: string; burnt?: boolean; owner?: string } = {},
): unknown {
  return {
    id,
    interface: opts.iface ?? 'MplCoreAsset',
    burnt: opts.burnt ?? false,
    content: {
      metadata: { name: `Asset ${id.slice(0, 6)}` },
      links: { image: `https://img.example/${RUN}/${id}.png` },
      files: [{ uri: `https://img.example/${RUN}/${id}.png`, mime: 'image/png' }],
    },
    grouping: opts.collection ? [{ group_key: 'collection', group_value: opts.collection }] : [],
    ownership: { owner: opts.owner },
  };
}

const id = (n: number): string => `Asset${String(n).padStart(4, '0')}${'x'.repeat(32)}`;

async function walletOf(p: TestPlayer): Promise<string> {
  const r = await db().withConnection((c) =>
    c.query<{ wallet: string }>(`SELECT wallet FROM users WHERE id = $1`, [p.sub]),
  );
  return r.rows[0]!.wallet;
}

async function leaseBasement(p: TestPlayer): Promise<void> {
  owners.push(p.sub);
  await db().withConnection((c) =>
    c.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000)
       ON CONFLICT (user_id) DO UPDATE SET cash_cents = 100000`,
      [p.sub],
    ),
  );
  expect((await api.call(p, 'POST', '/v1/homes', { kind: 'parents_basement' })).status).toBe(200);
}

beforeAll(async () => {
  das = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body) as { method: string; params: Record<string, unknown> };
      const network = (req.url ?? '').startsWith('/mainnet') ? 'mainnet' : 'devnet';
      calls.push({ path: network, method: rpc.method });
      let result: unknown = null;
      if (rpc.method === 'getAssetsByOwner') {
        const h = holdings.get(String(rpc.params.ownerAddress));
        result = { total: 0, limit: 1000, page: 1, items: h ? h[network] : [] };
      } else if (rpc.method === 'getAssetBatch') {
        const all = [...holdings.values()].flatMap((h) => h[network]) as Array<{ id: string }>;
        result = (rpc.params.ids as string[]).map((i) => all.find((a) => a.id === i) ?? null);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'ct-life', result }));
    });
  });
  await new Promise<void>((r) => das.listen(0, '127.0.0.1', () => r()));
  dasUrl = `http://127.0.0.1:${(das.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => das.close(() => r()));
});

describe('nft gallery', () => {
  beforeAll(async () => {
    api = await bootApi('nftGallery', {
      LIVE_PHASE: '6',
      HELIUS_RPC_URL_DEVNET: `${dasUrl}/devnet`,
      HELIUS_RPC_URL_MAINNET: `${dasUrl}/mainnet`,
      PUBLIC_API_BASE_URL: 'https://api.ctlife.test',
    });
  }, 30_000);
  afterAll(async () => {
    await db().withConnection((c) =>
      c.query(`DELETE FROM homes WHERE owner_user_id = ANY($1::uuid[])`, [owners]),
    );
    await api.stop();
  }, 30_000);

  it('lists devnet NFTs and only allow-listed mainnet ones, cached, paged', async () => {
    const p = await api.player();
    const w = await walletOf(p);
    holdings.set(w, {
      devnet: [
        asset(id(1), { owner: w }),
        asset(id(2), { owner: w, iface: 'FungibleToken' }),
        asset(id(3), { owner: w, burnt: true }),
      ],
      mainnet: [
        asset(id(4), { owner: w, collection: MAD_LADS }),
        asset(id(5), { owner: w, collection: OTHER }),
      ],
    });
    const before = calls.length;
    const r = await api.call(p, 'GET', '/v1/nfts/me');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.wallet).toBe(w);
    const items = r.body.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.assetId)).toEqual([id(1), id(4)]);
    expect(items[0]).toMatchObject({ network: 'devnet', moderation: 'pending', mime: 'image/png' });
    expect(items[1]).toMatchObject({ network: 'mainnet', moderation: 'ok', collection: MAD_LADS });
    expect(String(items[0]!.imageUrl)).toMatch(
      /^https:\/\/api\.ctlife\.test\/v1\/img\/[0-9a-f]{40}$/,
    );
    expect(calls.length - before).toBe(2); // one per network
    const page = await api.call(p, 'GET', '/v1/nfts/me?limit=1');
    expect(page.body.cursor).toBe('1');
    expect((page.body.items as unknown[]).length).toBe(1);
    const next = await api.call(p, 'GET', '/v1/nfts/me?limit=1&cursor=1');
    expect((next.body.items as Array<{ assetId: string }>)[0]!.assetId).toBe(id(4));
    expect(next.body.cursor).toBeNull();
    expect(calls.length - before).toBe(2); // cached
    expect((await api.call(p, 'GET', '/v1/nfts/me?cursor=abc')).status).toBe(400);
  });

  it('frames held assets; visitors see only ok frames; the policy and the door apply', async () => {
    const owner = await api.player();
    const w = await walletOf(owner);
    holdings.set(w, {
      devnet: [asset(id(11), { owner: w })],
      mainnet: [asset(id(12), { owner: w, collection: MAD_LADS })],
    });
    await leaseBasement(owner);
    const bad = await api.call(owner, 'PUT', '/v1/homes/me/gallery', {
      frames: [{ slot: 1, assetId: id(99) }],
    });
    expect(bad.status).toBe(403);
    expect(errDetails(bad)).toMatchObject({ reason: 'not_owner' });
    const slot = await api.call(owner, 'PUT', '/v1/homes/me/gallery', {
      frames: [{ slot: 13, assetId: id(11) }],
    });
    expect(errDetails(slot)).toMatchObject({ reason: 'slot_out_of_range', max: 12 });
    const dup = await api.call(owner, 'PUT', '/v1/homes/me/gallery', {
      frames: [
        { slot: 1, assetId: id(11) },
        { slot: 1, assetId: id(12) },
      ],
    });
    expect(errDetails(dup).reason).toBe('duplicate_slot');

    const put = await api.call(owner, 'PUT', '/v1/homes/me/gallery', {
      frames: [
        { slot: 1, assetId: id(11) },
        { slot: 2, assetId: id(12) },
      ],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.frames).toEqual([
      { slot: 1, assetId: id(11) },
      { slot: 2, assetId: id(12) },
    ]);
    expect((await api.call(owner, 'GET', '/v1/homes/me/gallery')).body.frames).toHaveLength(2);
    // Framing never exempts an image from the budget: the devnet (pending) one stays pending.
    const classes = await db().withConnection((c) =>
      c.query<{ asset_id: string; class: string }>(
        `SELECT f.asset_id, i.class FROM home_gallery_frames f JOIN nft_images i ON i.hash = f.image_hash
          WHERE f.owner_user_id = $1 ORDER BY f.slot`,
        [owner.sub],
      ),
    );
    expect(classes.rows).toEqual([
      { asset_id: id(11), class: 'pending' },
      { asset_id: id(12), class: 'ok' },
    ]);

    const visitor = await api.player();
    const seen = await api.call(visitor, 'GET', `/v1/homes/${owner.sub}/gallery`);
    expect(seen.status).toBe(200);
    expect(seen.body.frames).toEqual([{ slot: 2, assetId: id(12) }]);
    expect((seen.body.items as Array<{ moderation: string }>)[0]!.moderation).toBe('ok');

    await db().withConnection((c) =>
      c.query(`INSERT INTO home_settings (user_id, visitors) VALUES ($1, 'closed')`, [owner.sub]),
    );
    const closed = await api.call(visitor, 'GET', `/v1/homes/${owner.sub}/gallery`);
    expect(closed.status).toBe(403);
    expect(errCode(closed)).toBe('HOME_CLOSED');

    const homeless = await api.player();
    expect((await api.call(visitor, 'GET', `/v1/homes/${homeless.sub}/gallery`)).status).toBe(404);
    expect((await api.call(visitor, 'GET', '/v1/homes/not-a-uuid/gallery')).status).toBe(400);

    // The daily re-check: asset 11 was sold.
    holdings.set(w, {
      devnet: [asset(id(11), { owner: 'SomeoneElse' })],
      mainnet: [asset(id(12), { owner: w, collection: MAD_LADS })],
    });
    await db().withConnection((c) =>
      c.query(
        `UPDATE home_gallery_frames SET checked_at = now() - interval '2 days' WHERE owner_user_id = $1`,
        [owner.sub],
      ),
    );
    expect(await recheckFrames(buildContext())).toBeGreaterThanOrEqual(1);
    expect((await api.call(owner, 'GET', '/v1/homes/me/gallery')).body.frames).toEqual([
      { slot: 2, assetId: id(12) },
    ]);
  });

  it('serves a cached proxied PNG and 404s an unknown hash; config carries the nft block', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#09f' } })
      .png()
      .toBuffer();
    const hash = createHash('sha256').update(`route-${Date.now()}`).digest('hex').slice(0, 40);
    await db().withConnection(async (c) => {
      await c.query(
        `INSERT INTO nft_images (hash, source_url, status, mime, width, height, bytes, fetched_at, class, pool)
         VALUES ($1, 'https://img.example/t.png', 'ok', 'image/png', 4, 4, $2, now(), 'ok', 'ok')`,
        [hash, png],
      );
      await c.query(`UPDATE nft_image_usage SET bytes = bytes + $1 WHERE pool = 'ok'`, [
        png.length,
      ]);
    });
    const r = await api.app.inject({ method: 'GET', url: `/v1/img/${hash}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect(r.rawPayload.equals(png)).toBe(true);
    expect(
      (await api.app.inject({ method: 'GET', url: `/v1/img/${'c'.repeat(40)}` })).statusCode,
    ).toBe(404);
    const cfg = (await api.app.inject({ method: 'GET', url: '/v1/config' })).json() as {
      nft: unknown;
    };
    expect(cfg.nft).toEqual({
      imageHosts: ['api.ctlife.test'],
      maxImageBytes: 524288,
      maxImagePx: 512,
      maxSlots: 12,
    });
  });
});

describe('nft gallery gate', () => {
  it('answers 503 CAPABILITY_OFF on every route and leaves nft out of the config while off', async () => {
    const off = await bootApi('', { LIVE_PHASE: '6' });
    try {
      const p = await off.player();
      for (const [m, url, body] of [
        ['GET', '/v1/nfts/me', undefined],
        ['GET', `/v1/homes/${p.sub}/gallery`, undefined],
        ['PUT', '/v1/homes/me/gallery', { frames: [] }],
        ['GET', `/v1/img/${'a'.repeat(40)}`, undefined],
      ] as const) {
        const r = await off.call(p, m, url, body);
        expect(r.status, url).toBe(503);
        expect(errDetails(r)).toEqual({ capability: 'nftGallery' });
      }
      const cfg = (await off.app.inject({ method: 'GET', url: '/v1/config' })).json() as Record<
        string,
        unknown
      >;
      expect(cfg).not.toHaveProperty('nft');
    } finally {
      await off.stop();
    }
  });
});
