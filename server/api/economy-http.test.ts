/** Real HTTP handlers, JWT middleware and PostgreSQL; only chain RPC/Redis I/O are fixtures. */
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../application/context.js';
import { ECONOMY_WIF, type EconomyChain } from '../application/economy-chain.js';
import { CapabilityOffError } from '../shared/domain/errors.js';
import { createJwtIssuer } from '../shared/auth/jwt.js';
import { loadConfig } from '../shared/config/config.js';
import type { Db } from '../shared/db/pool.js';
import { toErrorEnvelope } from '../shared/infra/error-envelope.js';
import { idempotencyOnSend } from './middleware/idempotency.js';
import { registerEconomyRoutes } from './routes/economy.js';
import { registerWalletLinkRoutes } from './routes/wallet-links.js';

const schema = `economy_http_${randomBytes(8).toString('hex')}`;
const states = new Map<string, 'pending' | 'rejected' | 'unavailable'>();
const cache = { reserve: vi.fn(), complete: vi.fn(), abort: vi.fn() };
let admin: Pool;
let pool: Pool;
let app: FastifyInstance;
let ctx: AppContext;
let created = false;

const chain: EconomyChain = {
  async preparePayment(e) {
    return {
      kind: 'evm',
      chainId: 'eip155:4663',
      transaction: { from: e.payer, to: e.assetId, data: '0x', value: '0x0', chainId: '0x1237' },
    };
  },
  async verifyPayment(e, transactionId) {
    const state = states.get(transactionId);
    if (state === 'unavailable')
      throw new CapabilityOffError({ reason: 'economy_rpc_unavailable' });
    if (state === 'pending') return { state: 'pending', reason: 'not_finalized' };
    if (state === 'rejected') return { state: 'rejected', reason: 'transfer_mismatch' };
    return {
      state: 'verified',
      evidence: {
        chainId: e.chainId,
        assetId: e.assetId,
        payer: e.payer,
        recipient: e.recipient,
        amountBaseUnits: e.amountBaseUnits,
        transactionId,
        eventId: `${transactionId}:0`,
        blockId: 'fixture-finalized-block',
        blockHeight: '12345',
        blockTimestampMs: Math.min(Date.now(), e.notAfterMs),
        reference: null,
      },
    };
  },
};

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('A local test database is required');
  admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  pool = new Pool({
    connectionString,
    max: 8,
    options: `-c search_path=${schema}`,
    statement_timeout: 5000,
    lock_timeout: 3000,
  });
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,wallet text NOT NULL UNIQUE)');
  for (const file of [
    '1700000034000_cosmetic_items.sql',
    '1700000035000_cosmetic_inventory.sql',
    '1700000150000_economy_wallet_links.sql',
    '1700000151000_economy_orders.sql',
    '1700000152000_near_wallet_callback.sql',
  ]) {
    const sql = await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8');
    await pool.query(sql.split('-- Down Migration')[0]!);
  }
  await pool.query(
    'ALTER TABLE cosmetic_items ADD COLUMN grant_only boolean NOT NULL DEFAULT false',
  );
  const db: Db = {
    pool,
    connect: () => pool.connect(),
    close: () => pool.end(),
    async withConnection(fn) {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
  };
  const config = loadConfig();
  // Actual JWT verification and auth middleware; account/ban checks and token-bucket transport are isolated.
  ctx = {
    db,
    config,
    jwt: createJwtIssuer(),
    redis: { main: { get: async () => null, eval: async () => [1, '99'] } },
    idempotency: cache,
  } as unknown as AppContext;
  app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => {
    req.ctx = ctx;
    req.requestId = randomUUID();
  });
  // Include the production global response-cache hook: these routes must not activate it.
  app.addHook('onSend', idempotencyOnSend());
  app.setErrorHandler((error, _req, reply) => {
    const mapped = toErrorEnvelope(error, { error() {} });
    for (const [key, value] of Object.entries(mapped.headers)) reply.header(key, value);
    return reply.code(mapped.status).send(mapped.envelope);
  });
  registerWalletLinkRoutes(app);
  registerEconomyRoutes(app, chain);
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  if (admin) await admin.end();
});

interface Player {
  userId: string;
  token: string;
}
type HttpMethod = 'GET' | 'POST' | 'DELETE';
async function player(): Promise<Player> {
  const userId = randomUUID();
  const wallet = randomUUID();
  await pool.query('INSERT INTO users(id,wallet) VALUES($1,$2)', [userId, wallet]);
  return { userId, token: await ctx.jwt.signAccess(userId, wallet, false) };
}
function call(who: Player | null, method: HttpMethod, url: string, payload?: object, key?: string) {
  return app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: {
      ...(who ? { authorization: `Bearer ${who.token}` } : {}),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
  });
}
async function fixture() {
  const who = await player();
  const account = privateKeyToAccount(generatePrivateKey());
  const issued = await call(who, 'POST', '/v1/me/wallet-links/challenges', {
    network: 'eip155:4663',
    address: account.address,
  });
  expect(issued.statusCode).toBe(201);
  const challenge = issued.json<{ id: string; message: string }>();
  const proof = {
    challengeId: challenge.id,
    signature: await account.signMessage({ message: challenge.message }),
  };
  const verified = await call(who, 'POST', '/v1/me/wallet-links/verify', proof);
  expect(verified.statusCode).toBe(200);
  const linkId = verified.json<{ link: { id: string } }>().link.id;
  const offerId = randomUUID(),
    itemId = randomUUID();
  await pool.query(
    `INSERT INTO cosmetic_items(item_id,slot,item_key,name,price_cents)
    VALUES($1,'top',$2,'HTTP test wearable',100)`,
    [itemId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO economy_offers(offer_id,title,chain_id,asset_id,amount,recipient,terms_version,item_id,active)
    VALUES($1,'HTTP test wearable','eip155:4663',$2,'1000000000000000000',$3,'v1',$4,true)`,
    [offerId, ECONOMY_WIF, `0x${randomBytes(20).toString('hex')}`, itemId],
  );
  const payload = { offerId, walletLinkId: linkId };
  const create = () => call(who, 'POST', '/v1/economy/orders', payload, randomUUID());
  return { who, linkId, offerId, itemId, proof, payload, create };
}

describe('economy and wallet-link HTTP integration', () => {
  it('lists only owned history and rejects malformed pagination without polling the chain', async () => {
    const f = await fixture();
    const other = await player();
    const created = await f.create();
    const orderId = created.json<{ orderId: string }>().orderId;
    const history = await call(f.who, 'GET', '/v1/economy/orders?limit=1');
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({
      orders: [{ orderId, userId: f.who.userId }],
      nextCursor: null,
    });
    expect((await call(other, 'GET', '/v1/economy/orders')).json()).toEqual({
      orders: [],
      nextCursor: null,
    });
    for (const query of ['limit=51', 'limit=0', 'cursor=..', 'userId=' + other.userId]) {
      expect((await call(f.who, 'GET', '/v1/economy/orders?' + query)).statusCode).toBe(400);
    }
  });
  it('requires bearer authentication for every new endpoint', async () => {
    const id = randomUUID();
    const routes: Array<[HttpMethod, string]> = [
      ['GET', '/v1/economy/catalog'],
      ['GET', '/v1/economy/orders'],
      ['POST', '/v1/economy/orders'],
      ['GET', `/v1/economy/orders/${id}`],
      ['GET', `/v1/economy/orders/${id}/payment-request`],
      ['POST', `/v1/economy/orders/${id}/payment`],
      ['POST', `/v1/economy/orders/${id}/refund`],
      ['POST', `/v1/economy/orders/${id}/cancel`],
      ['GET', '/v1/me/wallet-links'],
      ['POST', '/v1/me/wallet-links/challenges'],
      ['POST', '/v1/me/wallet-links/verify'],
      ['DELETE', `/v1/me/wallet-links/${id}`],
    ];
    for (const [method, url] of routes) {
      const response = await call(null, method, url);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'SIGNATURE_INVALID' } });
    }
    expect(
      (await call({ userId: id, token: 'forged' }, 'GET', '/v1/economy/catalog')).statusCode,
    ).toBe(401);
  });

  it('requires UUID idempotency keys on all economy writes', async () => {
    const f = await fixture();
    for (const key of [undefined, 'not-a-uuid']) {
      for (const [url, payload] of [
        ['/v1/economy/orders', f.payload],
        [`/v1/economy/orders/${randomUUID()}/payment`, { transactionId: 'receipt' }],
        [`/v1/economy/orders/${randomUUID()}/refund`, { transactionId: 'receipt' }],
        [`/v1/economy/orders/${randomUUID()}/cancel`, {}],
      ] as Array<[string, object]>) {
        const response = await call(f.who, 'POST', url, payload, key);
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      }
    }
    expect(
      (
        await pool.query('SELECT count(*)::int n FROM economy_orders WHERE user_id=$1', [
          f.who.userId,
        ])
      ).rows[0].n,
    ).toBe(0);
  });

  it('rejects caller-controlled money/player fields and malformed path IDs', async () => {
    const f = await fixture();
    const order = (await f.create()).json<{ orderId: string }>();
    for (const [url, payload] of [
      ['/v1/economy/orders', { ...f.payload, amount: '1', userId: randomUUID() }],
      [`/v1/economy/orders/${order.orderId}/payment`, { transactionId: 'receipt', amount: '1' }],
      [
        `/v1/economy/orders/${order.orderId}/refund`,
        { transactionId: 'receipt', recipient: 'attacker' },
      ],
      [`/v1/economy/orders/${order.orderId}/cancel`, { ignored: true }],
      [
        '/v1/me/wallet-links/challenges',
        { network: 'near:mainnet', address: 'alice.near', userId: randomUUID() },
      ],
      ['/v1/me/wallet-links/verify', { ...f.proof, message: 'replacement' }],
    ] as Array<[string, object]>)
      expect((await call(f.who, 'POST', url, payload, randomUUID())).statusCode).toBe(400);
    expect((await call(f.who, 'GET', '/v1/economy/orders/not-a-uuid')).statusCode).toBe(400);
    expect((await call(f.who, 'DELETE', '/v1/me/wallet-links/not-a-uuid')).statusCode).toBe(400);
  });

  it('returns 404 for another player’s orders, payment requests and links', async () => {
    const f = await fixture();
    const stranger = await player();
    const order = (await f.create()).json<{ orderId: string }>();
    for (const [method, suffix, payload] of [
      ['GET', '', undefined],
      ['GET', '/payment-request', undefined],
      ['POST', '/payment', { transactionId: 'tx' }],
      ['POST', '/refund', { transactionId: 'tx' }],
      ['POST', '/cancel', {}],
    ] as Array<[HttpMethod, string, object | undefined]>) {
      const response = await call(
        stranger,
        method,
        `/v1/economy/orders/${order.orderId}${suffix}`,
        payload,
        randomUUID(),
      );
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect((await call(stranger, 'DELETE', `/v1/me/wallet-links/${f.linkId}`)).statusCode).toBe(
      404,
    );
    expect((await call(stranger, 'GET', '/v1/me/wallet-links')).json()).toEqual({ links: [] });
    expect(
      (await call(stranger, 'POST', '/v1/economy/orders', f.payload, randomUUID())).statusCode,
    ).toBe(404);
  });

  it('retries pending payment with the identical POST key and later fulfils exactly once', async () => {
    const f = await fixture();
    const createdOrder = await f.create();
    expect(createdOrder.statusCode).toBe(201);
    const orderId = createdOrder.json<{ orderId: string }>().orderId;
    const transactionId = randomUUID(),
      key = randomUUID();
    states.set(transactionId, 'pending');
    const first = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${orderId}/payment`,
      { transactionId },
      key,
    );
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'awaiting_payment' });
    expect(
      (await pool.query('SELECT * FROM cosmetic_inventory WHERE user_id=$1', [f.who.userId]))
        .rowCount,
    ).toBe(0);
    states.delete(transactionId);
    const second = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${orderId}/payment`,
      { transactionId },
      key,
    );
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'fulfilled' });
    expect(
      (
        await call(f.who, 'POST', `/v1/economy/orders/${orderId}/payment`, { transactionId }, key)
      ).json(),
    ).toMatchObject({ status: 'fulfilled' });
    expect(
      (await pool.query('SELECT * FROM cosmetic_inventory WHERE user_id=$1', [f.who.userId]))
        .rowCount,
    ).toBe(1);
    expect(
      (await pool.query('SELECT * FROM economy_receipts WHERE order_id=$1', [orderId])).rowCount,
    ).toBe(1);
    expect(cache.reserve).not.toHaveBeenCalled();
    expect(cache.complete).not.toHaveBeenCalled();
    expect(cache.abort).not.toHaveBeenCalled();
  });

  it('maps rejected receipts, RPC outage and invalid proof to contract error responses', async () => {
    const f = await fixture();
    const order = (await f.create()).json<{ orderId: string }>();
    const rejected = randomUUID(),
      unavailable = randomUUID();
    states.set(rejected, 'rejected');
    states.set(unavailable, 'unavailable');
    const invalid = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/payment`,
      { transactionId: rejected },
      randomUUID(),
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', details: { reason: 'transfer_mismatch' } },
    });
    const down = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/payment`,
      { transactionId: unavailable },
      randomUUID(),
    );
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({
      error: { code: 'CAPABILITY_OFF', details: { reason: 'economy_rpc_unavailable' } },
    });
    const replay = await call(f.who, 'POST', '/v1/me/wallet-links/verify', f.proof);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: 'WALLET_LINK_CHALLENGE_INVALID' } });
    expect(
      (await pool.query('SELECT * FROM cosmetic_inventory WHERE user_id=$1', [f.who.userId]))
        .rowCount,
    ).toBe(0);
    states.delete(unavailable);
    const recovered = await call(f.who, 'GET', `/v1/economy/orders/${order.orderId}`);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({ status: 'fulfilled' });
  });

  it('distinguishes a pending extra payment from a verified refund obligation on a fulfilled order', async () => {
    const f = await fixture();
    const order = (await f.create()).json<{ orderId: string }>();
    const primaryTransaction = randomUUID();
    const primary = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/payment`,
      { transactionId: primaryTransaction },
      randomUUID(),
    );
    expect(primary.statusCode).toBe(200);
    expect(primary.json()).toMatchObject({
      status: 'fulfilled',
      paymentReceipts: [{ transactionId: primaryTransaction, disposition: 'applied' }],
    });

    const extraTransaction = randomUUID(),
      key = randomUUID();
    states.set(extraTransaction, 'pending');
    const pending = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/payment`,
      { transactionId: extraTransaction },
      key,
    );
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ status: 'fulfilled', refundDueReceiptIds: [] });
    // A successful HTTP status and existing fulfilment are not acknowledgment of this second transfer.
    expect(
      pending
        .json<{ paymentReceipts: Array<{ transactionId: string }> }>()
        .paymentReceipts.map((r) => r.transactionId),
    ).toEqual([primaryTransaction]);

    states.delete(extraTransaction);
    const settled = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/payment`,
      { transactionId: extraTransaction },
      key,
    );
    expect(settled.statusCode).toBe(200);
    const body = settled.json<{
      status: string;
      refundDueReceiptIds: string[];
      paymentReceipts: Array<{ receiptId: string; transactionId: string; disposition: string }>;
    }>();
    expect(body.status).toBe('fulfilled');
    const extraReceipt = body.paymentReceipts.find((r) => r.transactionId === extraTransaction);
    expect(extraReceipt).toMatchObject({ disposition: 'refund_due' });
    expect(body.refundDueReceiptIds).toEqual([extraReceipt!.receiptId]);
    expect(
      (await pool.query('SELECT * FROM cosmetic_inventory WHERE user_id=$1', [f.who.userId]))
        .rowCount,
    ).toBe(1);
    expect(
      (await pool.query('SELECT * FROM economy_receipts WHERE order_id=$1', [order.orderId]))
        .rowCount,
    ).toBe(2);
  });

  it('exposes cancellation/refund state and refuses payment preparation after cancellation', async () => {
    const f = await fixture();
    const order = (await f.create()).json<{ orderId: string }>();
    const cancelled = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/cancel`,
      {},
      randomUUID(),
    );
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled' });
    const prepare = await call(f.who, 'GET', `/v1/economy/orders/${order.orderId}/payment-request`);
    expect(prepare.statusCode).toBe(409);
    expect(prepare.json()).toMatchObject({
      error: { code: 'ECONOMY_CONFLICT', details: { reason: 'order_not_payable' } },
    });
    const paid = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/payment`,
      { transactionId: randomUUID() },
      randomUUID(),
    );
    expect(paid.statusCode).toBe(200);
    expect(paid.json()).toMatchObject({ status: 'refund_due' });
    const refunded = await call(
      f.who,
      'POST',
      `/v1/economy/orders/${order.orderId}/refund`,
      { transactionId: randomUUID() },
      randomUUID(),
    );
    expect(refunded.statusCode).toBe(200);
    expect(refunded.json()).toMatchObject({ status: 'refunded', refundDueReceiptIds: [] });
    expect(
      (await pool.query('SELECT * FROM cosmetic_inventory WHERE user_id=$1', [f.who.userId]))
        .rowCount,
    ).toBe(0);
  });
});
