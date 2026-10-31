/**
 * Real Markets reconciliation over HTTP (real Postgres and Redis; venue and mainnet RPC are
 * fakes): the app dies after the wallet broadcast the order but before POST
 * /order/submitted. GET /orders (and GET /orders/{id}) find the transaction among the
 * wallet's recent signatures by the built instructions, attach it and verify it. A
 * transaction that is not the order is never attached, an order whose transaction never
 * landed stays built, and the RPC is called a bounded number of times.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { bootApi, type TestApi } from './http-test-kit.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { buildContext } from '../application/context.js';
import { _setRealMarketProviderForTests } from '../application/real-markets-providers.js';
import { _setRealMarketsRpcForTests } from '../application/real-markets-chain.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import {
  MAINNET_GENESIS_HASH,
  type BuildInput,
  type BuiltOrder,
  type MarketProvider,
  type ProviderOrderState,
  type RealMarket,
  type RealMarketPage,
  type RealPosition,
  type RealQuote,
  type SubmittedInput,
} from '../shared/domain/real-markets.js';
import {
  COMPUTE_BUDGET_PROGRAM,
  compileUnsignedV0,
  type WireInstruction,
} from '../shared/real-markets/tx.js';
import { MAX_TX_FETCH } from '../application/real-markets-reconcile.js';

const PROGRAM = Keypair.generate().publicKey.toBase58();
const MARKET = Keypair.generate().publicKey.toBase58();
const EDGE_SECRET = 'edge-secret-recon';
const NG = { 'cf-ipcountry': 'NG', 'x-edge-auth': EDGE_SECRET };

interface Build {
  readonly wallet: string;
  readonly instructions: WireInstruction[];
  readonly blockhash: string;
}

/** A venue whose builds carry a unique instruction (like Panta's quote-bound order data). */
class FakeVenue implements MarketProvider {
  readonly id = 'panta' as const;
  readonly categories = ['crypto'];
  readonly minOrderBase = null;
  builds: Build[] = [];
  submitted: SubmittedInput[] = [];
  confirmed: SubmittedInput[] = [];
  /** When set, every build reuses this instruction data and blockhash (identical builds). */
  fixed: { data: string; blockhash: string } | null = null;
  isConfigured(): boolean {
    return true;
  }
  async listMarkets(): Promise<RealMarketPage> {
    return { items: [], nextCursor: null };
  }
  async getMarket(): Promise<RealMarket | null> {
    return null;
  }
  async quote(): Promise<RealQuote> {
    throw new Error('unused');
  }
  async buildOrder(i: BuildInput): Promise<BuiltOrder> {
    const data =
      this.fixed?.data ?? Buffer.from(Keypair.generate().publicKey.toBytes()).toString('base64');
    const blockhash = this.fixed?.blockhash ?? Keypair.generate().publicKey.toBase58();
    const instructions: WireInstruction[] = [
      {
        programId: PROGRAM,
        data,
        accounts: [
          { pubkey: i.wallet, isSigner: true, isWritable: true },
          { pubkey: MARKET, isSigner: false, isWritable: true },
        ],
      },
    ];
    this.builds.push({ wallet: i.wallet, instructions, blockhash });
    const tx = compileUnsignedV0('panta', i.wallet, instructions, blockhash);
    return {
      txBase64: tx.txBase64,
      providerOrderId: `ord_${this.builds.length}`,
      providerQuoteId: 'qt_1',
      lastValidBlockHeight: 500,
      expiresAt: new Date(Date.now() + 60_000),
      programIds: tx.programIds,
      recentBlockhash: tx.recentBlockhash,
      fingerprints: tx.fingerprints,
      estShares: '25.00',
      feeUsdc: '0.20',
    };
  }
  async notifySubmitted(i: SubmittedInput): Promise<void> {
    this.submitted.push(i);
  }
  async notifyConfirmed(i: SubmittedInput): Promise<void> {
    this.confirmed.push(i);
  }
  async orderState(): Promise<ProviderOrderState> {
    return 'filled';
  }
  async positions(): Promise<RealPosition[]> {
    return [];
  }
}

interface Landed {
  readonly tx: VersionedTransaction;
  readonly err: unknown;
  readonly blockTime: number;
}

/** Fake mainnet: per-wallet signature lists, transactions by signature, call counts. */
class FakeMainnet implements HeliusClient {
  genesis = MAINNET_GENESIS_HASH;
  landed = new Map<string, Landed>();
  byWallet = new Map<string, string[]>();
  calls: Record<string, number> = {};
  async health(): Promise<string> {
    return 'ok';
  }
  land(wallet: string, sig: string, tx: VersionedTransaction, err: unknown = null): void {
    this.landed.set(sig, { tx, err, blockTime: Math.floor(Date.now() / 1000) });
    this.byWallet.set(wallet, [sig, ...(this.byWallet.get(wallet) ?? [])]);
  }
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    if (method === 'getGenesisHash') return this.genesis as T;
    if (method === 'getBlockHeight') return 100 as T;
    if (method === 'getSignaturesForAddress') {
      const sigs = this.byWallet.get(params[0] as string) ?? [];
      return sigs.map((signature) => {
        const l = this.landed.get(signature)!;
        return { signature, blockTime: l.blockTime, err: l.err, confirmationStatus: 'confirmed' };
      }) as T;
    }
    if (method === 'getSignatureStatuses') {
      const l = this.landed.get((params[0] as string[])[0]!);
      return { value: [l ? { confirmationStatus: 'confirmed', err: l.err } : null] } as T;
    }
    if (method === 'getTransaction') {
      const l = this.landed.get(params[0] as string);
      if (!l) return null as T;
      const enc = (params[1] as { encoding: string }).encoding;
      if (enc === 'base64') {
        return {
          blockTime: l.blockTime,
          meta: { err: l.err },
          transaction: [Buffer.from(l.tx.serialize()).toString('base64'), 'base64'],
        } as T;
      }
      const keys = l.tx.message.staticAccountKeys.map((k) => k.toBase58());
      return {
        blockTime: l.blockTime,
        meta: { err: l.err },
        transaction: {
          message: {
            accountKeys: keys,
            instructions: l.tx.message.compiledInstructions.map((ix) => ({
              programIdIndex: ix.programIdIndex,
            })),
          },
        },
      } as T;
    }
    throw new Error(`unexpected ${method}`);
  }
  async sgtMintsFor(): Promise<string[]> {
    return [];
  }
  async collectionAssetsOwnedBy(): Promise<string[]> {
    return [];
  }
}

/** What the wallet broadcasts: the built instructions plus a priority-fee instruction it added. */
function walletTx(
  b: Build,
  opts: { blockhash?: string; data?: string } = {},
): VersionedTransaction {
  const priority: WireInstruction = {
    programId: COMPUTE_BUDGET_PROGRAM,
    data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]).toString('base64'),
    accounts: [],
  };
  const ixs = b.instructions.map((ix) => (opts.data ? { ...ix, data: opts.data } : ix));
  const t = compileUnsignedV0('panta', b.wallet, [priority, ...ixs], opts.blockhash ?? b.blockhash);
  return VersionedTransaction.deserialize(Buffer.from(t.txBase64, 'base64'));
}

function fakeSignature(): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 88; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

interface Player {
  readonly sub: string;
  readonly token: string;
  readonly wallet: string;
}

let api: TestApi;
let venue: FakeVenue;
let mainnet: FakeMainnet;

async function player(): Promise<Player> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const r = await api.app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': uuidv7() },
    payload: { wallet },
  });
  const b = r.json() as { id: string; accessToken: string };
  await buildContext().db.withConnection((c) =>
    c.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
       VALUES ($1, $2, $3, '{}'::jsonb, 'degen', ARRAY[]::text[], 'be_rich', 'studio', now())`,
      [uuidv7(), b.id, `rc-${b.id.slice(-12)}`],
    ),
  );
  return { sub: b.id, token: b.accessToken, wallet };
}

async function call(
  who: Player,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await api.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${who.token}`,
      ...(method === 'POST' ? { 'idempotency-key': uuidv7() } : {}),
      ...NG,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}

async function build(p: Player): Promise<string> {
  const r = await call(p, 'POST', '/v1/real-markets/order/build', {
    provider: 'panta',
    marketId: MARKET,
    side: 'yes',
    amountUsdc: '10',
    riskAccepted: true,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.orderId as string;
}

async function orders(p: Player): Promise<Array<Record<string, unknown>>> {
  const r = await call(p, 'GET', '/v1/real-markets/orders');
  expect(r.status).toBe(200);
  return r.body.orders as Array<Record<string, unknown>>;
}

/** Let the next GET reconcile again (the per-player throttle is a Redis key). */
async function unthrottle(): Promise<void> {
  const keys = await buildContext().redis.main.keys('rm:reconcile:*');
  if (keys.length > 0) await buildContext().redis.main.del(...keys);
}

beforeAll(async () => {
  api = await bootApi('realMarkets', {
    REAL_MARKETS_EDGE_AUTH_HEADER: 'X-Edge-Auth',
    REAL_MARKETS_EDGE_AUTH_SECRET: EDGE_SECRET,
  });
}, 30_000);
beforeEach(async () => {
  venue = new FakeVenue();
  mainnet = new FakeMainnet();
  _setRealMarketProviderForTests('panta', venue);
  _setRealMarketsRpcForTests(mainnet);
  const redis = buildContext().redis.main;
  const keys = [...(await redis.keys('rm:*')), ...(await redis.keys('rl:rm:*'))];
  if (keys.length > 0) await redis.del(...keys);
});
afterEach(() => {
  _setRealMarketProviderForTests('panta', null);
});
afterAll(async () => {
  _setRealMarketsRpcForTests(null);
  await api.stop();
}, 30_000);

describe('reconciliation', () => {
  it('finds a broadcast the app never reported, attaches it and confirms it', async () => {
    const p = await player();
    const orderId = await build(p);
    // The wallet broadcast (adding a priority fee); the app died before /order/submitted.
    const sig = fakeSignature();
    mainnet.land(p.wallet, sig, walletTx(venue.builds[0]!));
    // Unrelated wallet activity is skipped.
    mainnet.land(p.wallet, fakeSignature(), walletTx(venue.builds[0]!, { data: 'AAAA' }));

    const [o] = await orders(p);
    expect(o).toMatchObject({
      orderId,
      status: 'confirmed',
      signature: sig,
      reconciled: true,
      providerState: 'filled',
    });
    expect(venue.submitted.map((s) => s.signature)).toEqual([sig]);
    expect(venue.confirmed.map((s) => s.signature)).toEqual([sig]);
  });

  it('marks a broadcast that landed with an on-chain error as failed, never confirmed', async () => {
    const p = await player();
    await build(p);
    const sig = fakeSignature();
    mainnet.land(p.wallet, sig, walletTx(venue.builds[0]!), { InstructionError: [1, 'Custom'] });
    const [o] = await orders(p);
    expect(o).toMatchObject({ status: 'failed', signature: sig, reconciled: true });
    expect(venue.confirmed).toHaveLength(0);
  });

  it('never attaches a transaction that is not the order', async () => {
    const p = await player();
    await build(p);
    const b = venue.builds[0]!;
    // Same program, different data (another trade).
    mainnet.land(p.wallet, fakeSignature(), walletTx(b, { data: 'AQID' }));
    // The right instructions, but paid by another wallet (listed under ours).
    const other = Keypair.generate().publicKey.toBase58();
    const foreign = walletTx({
      ...b,
      wallet: other,
      instructions: b.instructions.map((ix) => ({
        ...ix,
        accounts: ix.accounts.map((a) => (a.isSigner ? { ...a, pubkey: other } : a)),
      })),
    });
    mainnet.land(p.wallet, fakeSignature(), foreign);
    const [o] = await orders(p);
    expect(o).toMatchObject({ status: 'built', signature: null, reconciled: false });
    expect(mainnet.calls.getTransaction).toBe(2); // both were read, neither matched
    expect(venue.submitted).toHaveLength(0);
  });

  it('leaves an order whose transaction never landed as built', async () => {
    const p = await player();
    const orderId = await build(p);
    const [o] = await orders(p);
    expect(o).toMatchObject({ orderId, status: 'built', signature: null, reconciled: false });
    expect(mainnet.calls.getTransaction ?? 0).toBe(0);
  });

  it('picks the order with the same blockhash when two builds are identical', async () => {
    venue.fixed = { data: 'BQUFBQ==', blockhash: Keypair.generate().publicKey.toBase58() };
    const p = await player();
    const first = await build(p);
    venue.fixed = { data: 'BQUFBQ==', blockhash: Keypair.generate().publicKey.toBase58() };
    const second = await build(p);
    const sig = fakeSignature();
    mainnet.land(p.wallet, sig, walletTx(venue.builds[0]!));
    const list = await orders(p);
    const byId = new Map(list.map((o) => [o.orderId, o]));
    expect(byId.get(first)).toMatchObject({ status: 'confirmed', signature: sig });
    expect(byId.get(second)).toMatchObject({ status: 'built', signature: null });
  });

  it('reconciles from GET /orders/{id} on a built order', async () => {
    const p = await player();
    const orderId = await build(p);
    const sig = fakeSignature();
    mainnet.land(p.wallet, sig, walletTx(venue.builds[0]!));
    const r = await call(p, 'GET', `/v1/real-markets/orders/${orderId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'confirmed', signature: sig, reconciled: true });
  });

  it('does not override a signature the client reported, and a client-reported order is not "reconciled"', async () => {
    const p = await player();
    const orderId = await build(p);
    const sig = fakeSignature();
    mainnet.land(p.wallet, sig, walletTx(venue.builds[0]!));
    const s = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId,
      signature: sig,
    });
    expect(s.status).toBe(200);
    const [o] = await orders(p);
    expect(o).toMatchObject({ status: 'confirmed', signature: sig, reconciled: false });
    expect(mainnet.calls.getSignaturesForAddress ?? 0).toBe(0); // nothing unsigned to look for
  });

  it('is throttled per player and bounded per call', async () => {
    const p = await player();
    await build(p);
    for (let i = 0; i < 30; i++) {
      mainnet.land(p.wallet, fakeSignature(), walletTx(venue.builds[0]!, { data: 'CQk=' }));
    }
    await orders(p);
    expect(mainnet.calls.getSignaturesForAddress).toBe(1);
    expect(mainnet.calls.getTransaction).toBe(MAX_TX_FETCH);
    await orders(p);
    await orders(p);
    expect(mainnet.calls.getSignaturesForAddress).toBe(1); // throttled
    await unthrottle();
    await orders(p);
    expect(mainnet.calls.getSignaturesForAddress).toBe(2);
  });

  it('attaches nothing, and still answers, when the RPC is not mainnet', async () => {
    _setRealMarketsRpcForTests(mainnet); // reset the per-process genesis check
    mainnet.genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; // devnet
    const p = await player();
    await build(p).catch(() => undefined); // build does not touch the RPC
    const sig = fakeSignature();
    if (venue.builds[0]) mainnet.land(p.wallet, sig, walletTx(venue.builds[0]));
    const r = await call(p, 'GET', '/v1/real-markets/orders');
    expect(r.status).toBe(200);
    for (const o of r.body.orders as Array<Record<string, unknown>>) {
      expect(o.signature).toBeNull();
    }
    expect(mainnet.calls.getSignaturesForAddress ?? 0).toBe(0);
  });
});
