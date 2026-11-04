import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../shared/config/config.js';
import type { Db } from '../shared/db/pool.js';
import type { WalletContext } from './wallet-links.js';
import { EconomyOrders } from './economy-orders.js';
import { ECONOMY_WIF, type EconomyChain, type PaymentVerification } from './economy-chain.js';
import { economyAsset } from './economy-assets.js';

const schema = `economy_orders_${randomBytes(8).toString('hex')}`;
let admin: Pool;
let pool: Pool;
let ctx: WalletContext;
let created = false;
beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('A local test database is required');
  admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  created = true;
  pool = new Pool({
    connectionString,
    max: 12,
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
      const c = await pool.connect();
      try {
        return await fn(c);
      } finally {
        c.release();
      }
    },
  };
  ctx = { db, config: loadConfig() };
});
afterAll(async () => {
  if (pool) await pool.end();
  if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  if (admin) await admin.end();
});

async function fixture() {
  const userId = randomUUID(),
    linkId = randomUUID(),
    itemId = randomUUID(),
    offerId = randomUUID();
  const payer = `0x${randomBytes(20).toString('hex')}`,
    recipient = `0x${randomBytes(20).toString('hex')}`;
  await pool.query('INSERT INTO users(id,wallet) VALUES($1,$2)', [userId, randomUUID()]);
  await pool.query(
    `INSERT INTO economy_wallet_links(id,user_id,network,address,proof_scheme,proof_digest,verified_at)
    VALUES($1,$2,'eip155:4663',$3,'eip4361-eoa','test-fixture-only',now())`,
    [linkId, userId, payer],
  );
  await pool.query(
    `INSERT INTO cosmetic_items(item_id,slot,item_key,name,price_cents)
    VALUES($1,'top',$2,'Test wearable',100)`,
    [itemId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO economy_offers(offer_id,title,chain_id,asset_id,amount,recipient,terms_version,item_id,active)
    VALUES($1,'Test wearable','eip155:4663',$2,'1000000000000000000',$3,'v1',$4,true)`,
    [offerId, ECONOMY_WIF, recipient, itemId],
  );
  const state: { pending: boolean; down: boolean; timestamp?: number; badPayer?: boolean } = {
    pending: false,
    down: false,
  };
  const chain: EconomyChain = {
    async preparePayment(e) {
      return {
        kind: 'evm',
        chainId: 'eip155:4663',
        transaction: { from: e.payer, to: e.assetId, data: '0x', value: '0x0', chainId: '0x1237' },
      };
    },
    async verifyPayment(e, transactionId): Promise<PaymentVerification> {
      if (state.down) throw new Error('RPC unavailable');
      if (state.pending) return { state: 'pending', reason: 'not_finalized' };
      return {
        state: 'verified',
        evidence: {
          chainId: e.chainId,
          assetId: e.assetId,
          payer: state.badPayer ? recipient : e.payer,
          recipient: e.recipient,
          amountBaseUnits: e.amountBaseUnits,
          transactionId,
          eventId: `${transactionId}:0`,
          blockId: 'block-1',
          blockHeight: '9007199254740993',
          blockTimestampMs: state.timestamp ?? e.notAfterMs,
          reference: null,
        },
      };
    },
  };
  const service = new EconomyOrders(ctx, chain);
  const create = (key = randomUUID()) => service.create(userId, offerId, linkId, key);
  const owned = async () =>
    (await pool.query('SELECT * FROM cosmetic_inventory WHERE user_id=$1', [userId])).rows;
  return { userId, linkId, itemId, offerId, payer, recipient, state, service, create, owned };
}

describe('real-asset durable orders', () => {
  it('collapses concurrent same-key creates and retains immutable price terms', async () => {
    const f = await fixture();
    const key = randomUUID();
    const [a, b] = await Promise.all([f.create(key), f.create(key)]);
    expect(a.orderId).toBe(b.orderId);
    await pool.query(`UPDATE economy_offers SET amount='1',terms_version='v2' WHERE offer_id=$1`, [
      f.offerId,
    ]);
    expect(await f.create(key)).toMatchObject({
      amount: '1000000000000000000',
      termsVersion: 'v1',
    });
    await expect(f.service.create(f.userId, randomUUID(), f.linkId, key)).rejects.toMatchObject({
      details: { reason: 'idempotency_body_mismatch' },
    });
  });
  it('rejects distinct-key concurrent quotes for one entitlement', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([f.create(), f.create()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
  it('delivers exactly once for concurrent receipt retries, without mint eligibility', async () => {
    const f = await fixture();
    const order = await f.create();
    const tx = randomUUID();
    const results = await Promise.all([
      f.service.record(f.userId, order.orderId, tx),
      f.service.record(f.userId, order.orderId, tx),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await f.owned()).toMatchObject([{ source: 'shop' }]);
    const count = await pool.query(
      'SELECT count(*)::int n FROM economy_receipts WHERE order_id=$1',
      [order.orderId],
    );
    expect(count.rows[0].n).toBe(1);
    await expect(f.create()).rejects.toMatchObject({ details: { reason: 'item_already_owned' } });
  });
  it('reconciles a durable pending transaction after process/service restart', async () => {
    const f = await fixture();
    const order = await f.create();
    f.state.pending = true;
    expect((await f.service.record(f.userId, order.orderId, randomUUID())).status).toBe(
      'awaiting_payment',
    );
    expect(await f.owned()).toHaveLength(0);
    f.state.pending = false;
    expect((await f.service.get(f.userId, order.orderId)).status).toBe('fulfilled');
    expect(await f.owned()).toHaveLength(1);
  });
  it('keeps the attempt after an RPC outage and can reconcile it', async () => {
    const f = await fixture();
    const order = await f.create();
    f.state.down = true;
    await expect(f.service.record(f.userId, order.orderId, randomUUID())).rejects.toThrow(
      'RPC unavailable',
    );
    expect(await f.owned()).toHaveLength(0);
    f.state.down = false;
    expect((await f.service.get(f.userId, order.orderId)).status).toBe('fulfilled');
  });
  it('records a cancelled payment as owed and verifies a real refund exactly once', async () => {
    const f = await fixture();
    const order = await f.create();
    await f.service.cancel(f.userId, order.orderId);
    const paid = await f.service.record(f.userId, order.orderId, randomUUID());
    expect(paid.status).toBe('refund_due');
    expect(paid.refundDueReceiptIds).toHaveLength(1);
    expect(await f.owned()).toHaveLength(0);
    const refund = randomUUID();
    expect((await f.service.record(f.userId, order.orderId, refund, 'refund')).status).toBe(
      'refunded',
    );
    expect((await f.service.record(f.userId, order.orderId, refund, 'refund')).status).toBe(
      'refunded',
    );
    await expect(
      f.service.record(f.userId, order.orderId, randomUUID(), 'refund'),
    ).rejects.toMatchObject({ details: { reason: 'no_refund_due' } });
  });
  it('keeps an extra payment as a separate refund obligation without revoking delivery', async () => {
    const f = await fixture();
    const order = await f.create();
    await f.service.record(f.userId, order.orderId, randomUUID());
    const extra = await f.service.record(f.userId, order.orderId, randomUUID());
    expect(extra.status).toBe('fulfilled');
    expect(extra.refundDueReceiptIds).toHaveLength(1);
    const refunded = await f.service.record(f.userId, order.orderId, randomUUID(), 'refund');
    expect(refunded.status).toBe('fulfilled');
    expect(refunded.refundDueReceiptIds).toEqual([]);
    expect(await f.owned()).toHaveLength(1);
  });
  it('recognizes money received after expiry without delivering an expired quote', async () => {
    const f = await fixture();
    const order = await f.create();
    await pool.query(
      `UPDATE economy_orders SET created_at=now()-interval '1 hour',expires_at=now()-interval '1 minute' WHERE order_id=$1`,
      [order.orderId],
    );
    const result = await f.service.record(f.userId, order.orderId, randomUUID());
    expect(result.status).toBe('refund_due');
    expect(await f.owned()).toHaveLength(0);
  });
  it('rejects another user, wrong linked network, and a mismatched receipt', async () => {
    const f = await fixture();
    const order = await f.create();
    await expect(f.service.get(randomUUID(), order.orderId)).rejects.toMatchObject({
      httpStatus: 404,
    });
    f.state.badPayer = true;
    await expect(f.service.record(f.userId, order.orderId, randomUUID())).rejects.toMatchObject({
      details: { reason: 'receipt_expectation_mismatch' },
    });
    expect(await f.owned()).toHaveLength(0);
    await f.service.cancel(f.userId, order.orderId);
    await pool.query(`UPDATE economy_wallet_links SET network='near:mainnet' WHERE id=$1`, [
      f.linkId,
    ]);
    await expect(f.create()).rejects.toMatchObject({
      details: { reason: 'wallet_network_mismatch' },
    });
  });
  it('prevents receipt replay across orders, even for identical parties and amount', async () => {
    const f = await fixture();
    const order = await f.create();
    const tx = randomUUID();
    await f.service.cancel(f.userId, order.orderId);
    const second = await f.create();
    await f.service.record(f.userId, order.orderId, tx);
    await expect(f.service.record(f.userId, second.orderId, tx)).rejects.toMatchObject({
      details: { reason: 'receipt_already_used' },
    });
    expect(await f.owned()).toHaveLength(0);
  });
  it('rolls back receipt and inventory together, then retries a durable attempt', async () => {
    const f = await fixture();
    const order = await f.create();
    await pool.query(
      `CREATE FUNCTION reject_economy_test_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${f.userId}'::uuid THEN RAISE EXCEPTION 'injected delivery failure'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER reject_economy_test_grant BEFORE INSERT ON cosmetic_inventory FOR EACH ROW EXECUTE FUNCTION reject_economy_test_grant()',
    );
    try {
      await expect(f.service.record(f.userId, order.orderId, randomUUID())).rejects.toThrow(
        'injected delivery failure',
      );
      expect(
        (await pool.query('SELECT 1 FROM economy_receipts WHERE order_id=$1', [order.orderId]))
          .rowCount,
      ).toBe(0);
      expect(await f.owned()).toHaveLength(0);
    } finally {
      await pool.query('DROP TRIGGER reject_economy_test_grant ON cosmetic_inventory');
    }
    expect((await f.service.get(f.userId, order.orderId)).status).toBe('fulfilled');
  });
  it('validates canonical whole units and chain-specific integer bounds', () => {
    for (const invalid of [
      '0',
      '01',
      '-1',
      '1.0',
      '1e18',
      ' 1',
      '1 '.repeat(50),
      (1n << 256n).toString(),
    ]) {
      expect(() => economyAsset('eip155:4663', ECONOMY_WIF, invalid)).toThrow();
    }
    expect(economyAsset('near:mainnet', 'native', '1000000000000000000000000').decimals).toBe(24);
    expect(() => economyAsset('near:mainnet', 'native', (1n << 128n).toString())).toThrow();
    expect(() => economyAsset('solana:mainnet', 'native', (1n << 64n).toString())).toThrow();
    expect(() => economyAsset('eip155:4663', 'native', '1')).toThrow();
  });
});
