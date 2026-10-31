/**
 * Real Markets over HTTP (real Postgres and Redis; the venue and the mainnet RPC are
 * fakes): capabilities, the geo / 18+ / wallet gate, attribution, quote and build for the
 * linked wallet only, idempotency, signature recording and on-chain verification, order
 * history, positions and the daily cap. Nothing here signs or sends a transaction.
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
  type QuoteInput,
  type RealMarket,
  type RealMarketPage,
  type RealPosition,
  type RealQuote,
  type SubmittedInput,
} from '../shared/domain/real-markets.js';
import { compileUnsignedV0 } from '../shared/real-markets/tx.js';

const PROGRAM = Keypair.generate().publicKey.toBase58();
const MARKET = Keypair.generate().publicKey.toBase58();

function market(id = MARKET): RealMarket {
  return {
    provider: 'panta',
    marketId: id,
    eventId: null,
    eventTitle: null,
    title: 'SOL above 300 by Dec?',
    description: null,
    category: 'crypto',
    imageUrl: null,
    status: 'open',
    providerPhase: 'primary',
    tradable: true,
    yesPrice: '0.40',
    noPrice: '0.60',
    sellYesPrice: null,
    sellNoPrice: null,
    volumeUsdc: '1000.00',
    closeTime: 1798761599,
    resolveTime: 1798765199,
    result: null,
    rules: null,
  };
}

/** An in-memory venue that records what the service asked it. */
class FakeVenue implements MarketProvider {
  readonly categories = ['crypto', 'sports'];
  minOrderBase: bigint | null = null;
  constructor(readonly id: 'panta' | 'jupiter') {}
  configured = true;
  listCalls = 0;
  quotes: QuoteInput[] = [];
  builds: BuildInput[] = [];
  submitted: SubmittedInput[] = [];
  confirmed: SubmittedInput[] = [];
  positionWallets: string[] = [];
  state: ProviderOrderState = 'filled';
  isConfigured(): boolean {
    return this.configured;
  }
  async listMarkets(): Promise<RealMarketPage> {
    this.listCalls++;
    return { items: [market()], nextCursor: null };
  }
  async getMarket(id: string): Promise<RealMarket | null> {
    return id === MARKET ? market() : null;
  }
  async quote(i: QuoteInput): Promise<RealQuote> {
    this.quotes.push(i);
    return {
      provider: this.id,
      marketId: i.marketId,
      side: i.side,
      amountUsdc: '10.00',
      quoteId: 'qt_1',
      estShares: '25.00',
      avgPrice: '0.40',
      feeUsdc: '0.20',
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    };
  }
  async buildOrder(i: BuildInput): Promise<BuiltOrder> {
    this.builds.push(i);
    const tx = compileUnsignedV0(
      this.id,
      i.wallet,
      [
        {
          programId: PROGRAM,
          data: '',
          accounts: [{ pubkey: i.wallet, isSigner: true, isWritable: true }],
        },
      ],
      Keypair.generate().publicKey.toBase58(),
    );
    return {
      txBase64: tx.txBase64,
      providerOrderId: `ord_${this.builds.length}`,
      providerQuoteId: i.quoteId,
      lastValidBlockHeight: 500,
      expiresAt: new Date(Date.now() + 60_000),
      programIds: tx.programIds,
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
    return this.state;
  }
  async positions(wallet: string): Promise<RealPosition[]> {
    this.positionWallets.push(wallet);
    return [
      {
        provider: this.id,
        marketId: MARKET,
        title: null,
        side: 'yes',
        shares: '25.00',
        status: 'primary',
        claimable: false,
        claimed: false,
        outcome: null,
        avgPrice: null,
        costUsdc: null,
        estValueUsdc: null,
      },
    ];
  }
}

/** Fake mainnet RPC: each signature lands with the fee payer / programs the test sets. */
class FakeMainnet implements HeliusClient {
  landed = new Map<string, { feePayer: string; programs: string[]; err: unknown }>();
  async health(): Promise<string> {
    return 'ok';
  }
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (method === 'getGenesisHash') return MAINNET_GENESIS_HASH as T;
    if (method === 'getBlockHeight') return 100 as T;
    const sig =
      method === 'getSignatureStatuses' ? (params[0] as string[])[0]! : (params[0] as string);
    const tx = this.landed.get(sig);
    if (method === 'getSignatureStatuses') {
      return { value: [tx ? { confirmationStatus: 'confirmed', err: tx.err } : null] } as T;
    }
    if (!tx) return null as T;
    return {
      meta: { err: tx.err },
      transaction: {
        message: {
          accountKeys: [tx.feePayer, ...tx.programs],
          instructions: tx.programs.map((_, i) => ({ programIdIndex: i + 1 })),
        },
      },
    } as T;
  }
  async sgtMintsFor(): Promise<string[]> {
    return [];
  }
  async collectionAssetsOwnedBy(): Promise<string[]> {
    return [];
  }
}

interface Player {
  readonly sub: string;
  readonly token: string;
  readonly wallet: string;
}

/** The edge (Cloudflare) adds the country AND the shared secret; only then is the country trusted. */
const EDGE_SECRET = 'edge-secret-123';
const EDGE_ENV = {
  REAL_MARKETS_EDGE_AUTH_HEADER: 'X-Edge-Auth',
  REAL_MARKETS_EDGE_AUTH_SECRET: EDGE_SECRET,
};
const EDGE = { 'x-edge-auth': EDGE_SECRET };
const NG = { 'cf-ipcountry': 'NG', ...EDGE };
let api: TestApi | null = null;
let panta: FakeVenue;
let jupiter: FakeVenue;
let mainnet: FakeMainnet;

async function boot(
  capabilities: string,
  env: Record<string, string | undefined> = {},
): Promise<TestApi> {
  if (api) await api.stop();
  api = await bootApi(capabilities, { ...EDGE_ENV, ...env });
  return api;
}

async function player(adult = true): Promise<Player> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const r = await api!.app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': uuidv7() },
    payload: { wallet },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  if (adult) {
    await buildContext().db.withConnection((c) =>
      c.query(
        `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id, age_confirmed_at)
         VALUES ($1, $2, $3, '{}'::jsonb, 'degen', ARRAY[]::text[], 'be_rich', 'studio', now())`,
        [uuidv7(), b.id, `rm-${b.id.slice(-12)}`],
      ),
    );
  }
  return { sub: b.id, token: b.accessToken, wallet };
}

async function call(
  who: Player,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = NG,
  idemKey?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await api!.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${who.token}`,
      ...(method === 'POST' ? { 'idempotency-key': idemKey ?? uuidv7() } : {}),
      ...headers,
    },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return { status: r.statusCode, body: r.json() as Record<string, unknown> };
}

const code = (r: { body: Record<string, unknown> }): string | undefined =>
  (r.body.error as { code?: string } | undefined)?.code;
const details = (r: { body: Record<string, unknown> }): Record<string, unknown> =>
  (r.body.error as { details?: Record<string, unknown> } | undefined)?.details ?? {};

const order = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: 'panta',
  marketId: MARKET,
  side: 'yes',
  amountUsdc: '10',
  riskAccepted: true,
  ...extra,
});

/** A fake signature: 64 random bytes in base58 (never a real transaction). */
function fakeSignature(): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 88; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

beforeAll(() => {
  mainnet = new FakeMainnet();
  _setRealMarketsRpcForTests(mainnet);
});
beforeEach(async () => {
  panta = new FakeVenue('panta');
  jupiter = new FakeVenue('jupiter');
  jupiter.minOrderBase = 5_000_000n;
  _setRealMarketProviderForTests('panta', panta);
  _setRealMarketProviderForTests('jupiter', jupiter);
  await boot('realMarkets');
  const keys = await buildContext().redis.main.keys('rm:*');
  if (keys.length > 0) await buildContext().redis.main.del(...keys);
});
afterEach(() => {
  _setRealMarketProviderForTests('panta', null);
  _setRealMarketProviderForTests('jupiter', null);
});
afterAll(async () => {
  _setRealMarketsRpcForTests(null);
  if (api) await api.stop();
  api = null;
});

describe('capabilities', () => {
  it('is dark (503 CAPABILITY_OFF) until realMarkets is on, and GET /config says so', async () => {
    await boot('');
    const p = await player();
    const r = await call(p, 'GET', '/v1/real-markets/markets');
    expect(r.status).toBe(503);
    expect(code(r)).toBe('CAPABILITY_OFF');
    expect(details(r)).toMatchObject({ capability: 'realMarkets' });
    const cfg = await call(p, 'GET', '/v1/config');
    const features = (cfg.body.capabilities as { features: Record<string, boolean> }).features;
    expect(features.realMarkets).toBe(false);
    expect(features.realMarketsJupiter).toBe(false);
  });

  it('keeps Jupiter behind realMarketsJupiter', async () => {
    const p = await player();
    const off = await call(p, 'GET', '/v1/real-markets/markets?provider=jupiter');
    expect(off.status).toBe(503);
    expect(details(off)).toMatchObject({ capability: 'realMarketsJupiter' });
    await boot('realMarkets,realMarketsJupiter');
    const p2 = await player();
    const on = await call(p2, 'GET', '/v1/real-markets/markets?provider=jupiter');
    expect(on.status).toBe(200);
    expect(on.body.attribution).toMatchObject({ text: 'Powered by Jupiter', required: true });
  });

  it('answers 503 REAL_MARKETS_PROVIDER_UNAVAILABLE while the venue has no API key', async () => {
    panta.configured = false;
    const p = await player();
    const r = await call(p, 'GET', '/v1/real-markets/markets');
    expect(r.status).toBe(503);
    expect(code(r)).toBe('REAL_MARKETS_PROVIDER_UNAVAILABLE');
  });
});

describe('gate', () => {
  it('config reports eligibility instead of refusing', async () => {
    const minor = await player(false);
    const r = await call(minor, 'GET', '/v1/real-markets/config', undefined, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true,
      eligible: false,
      chain: 'solana:mainnet',
      cluster: 'mainnet',
      wallet: minor.wallet,
      ageConfirmed: false,
      distribution: 'dapp_store_only',
    });
    expect(r.body.reasons).toEqual(['unknown_country', 'age_required']);
    const adult = await player();
    const ok = await call(adult, 'GET', '/v1/real-markets/config');
    expect(ok.body).toMatchObject({ eligible: true, reasons: [], country: 'NG' });
    expect((ok.body.providers as Array<{ id: string }>).map((x) => x.id)).toEqual(['panta']);
  });

  it('refuses blocked, unknown and Tor locations with 451', async () => {
    const p = await player();
    for (const [h, reason] of [
      [{ ...EDGE, 'cf-ipcountry': 'US' }, 'blocked_country'],
      [{ ...EDGE, 'cf-ipcountry': 'KR' }, 'blocked_country'],
      [{}, 'unknown_country'],
      [EDGE, 'unknown_country'],
      [{ 'cf-ipcountry': 'NG' }, 'unknown_country'], // spoofed: no edge secret
      [{ ...EDGE, 'cf-ipcountry': 'XX' }, 'unknown_country'],
      [{ ...EDGE, 'cf-ipcountry': 'T1' }, 'unknown_country'],
      [{ ...EDGE, 'cf-ipcountry': 'UA', 'cf-region-code': '43' }, 'blocked_region'],
    ] as const) {
      const r = await call(p, 'GET', '/v1/real-markets/markets', undefined, h);
      expect(r.status, JSON.stringify(h)).toBe(451);
      expect(code(r)).toBe('REAL_MARKETS_GEO_BLOCKED');
      expect(details(r).reason).toBe(reason);
    }
  });

  it('adds operator countries to the built-in list', async () => {
    await boot('realMarkets', { REAL_MARKETS_BLOCKED_COUNTRIES: 'gb' });
    const p = await player();
    const gb = await call(p, 'GET', '/v1/real-markets/markets', undefined, {
      ...EDGE,
      'cf-ipcountry': 'GB',
    });
    expect(gb.status).toBe(451);
    const us = await call(p, 'GET', '/v1/real-markets/markets', undefined, {
      ...EDGE,
      'cf-ipcountry': 'US',
    });
    expect(us.status).toBe(451); // the seed list still applies
  });

  it('refuses a spoofed country header without the edge secret, accepts it with the secret', async () => {
    const p = await player();
    const spoofed = await call(p, 'GET', '/v1/real-markets/markets', undefined, {
      'cf-ipcountry': 'NG',
    });
    expect(spoofed.status).toBe(451);
    expect(details(spoofed)).toMatchObject({ country: null, reason: 'unknown_country' });
    const wrong = await call(p, 'GET', '/v1/real-markets/markets', undefined, {
      'cf-ipcountry': 'NG',
      'x-edge-auth': 'nope',
    });
    expect(wrong.status).toBe(451);
    const ok = await call(p, 'GET', '/v1/real-markets/markets', undefined, {
      'cf-ipcountry': 'NG',
      'x-edge-auth': EDGE_SECRET,
    });
    expect(ok.status).toBe(200);
  });

  it('trusts no country header at all when no edge secret is configured (fail closed)', async () => {
    await boot('realMarkets', {
      REAL_MARKETS_EDGE_AUTH_HEADER: '',
      REAL_MARKETS_EDGE_AUTH_SECRET: '',
    });
    const p = await player();
    for (const h of [{ 'cf-ipcountry': 'NG' }, NG]) {
      const r = await call(p, 'GET', '/v1/real-markets/markets', undefined, h);
      expect(r.status).toBe(451);
      expect(details(r).reason).toBe('unknown_country');
    }
    const cfg = await call(p, 'GET', '/v1/real-markets/config', undefined, NG);
    expect(cfg.body.reasons).toContain('unknown_country');
  });

  it('requires the 18+ confirmation', async () => {
    const minor = await player(false);
    const r = await call(minor, 'GET', '/v1/real-markets/markets');
    expect(r.status).toBe(403);
    expect(code(r)).toBe('AGE_REQUIRED');
  });

  it('requires auth', async () => {
    const r = await api!.app.inject({
      method: 'GET',
      url: '/v1/real-markets/markets',
      headers: NG,
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('markets', () => {
  it('lists with attribution and asOf, served from a short cache', async () => {
    const p = await player();
    const r = await call(p, 'GET', '/v1/real-markets/markets?category=crypto&limit=10');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      provider: 'panta',
      nextCursor: null,
      attribution: { text: 'Powered by Panta', url: 'https://panta.market', required: true },
    });
    expect((r.body.items as RealMarket[])[0]!.marketId).toBe(MARKET);
    expect(typeof r.body.asOf).toBe('string');
    await call(p, 'GET', '/v1/real-markets/markets?category=crypto&limit=10');
    expect(panta.listCalls).toBe(1);
    expect(JSON.stringify(r.body)).not.toMatch(/cash/i);
  });

  it('rejects a category the venue does not have', async () => {
    const p = await player();
    const r = await call(p, 'GET', '/v1/real-markets/markets?category=esports');
    expect(r.status).toBe(400);
    expect(details(r)).toMatchObject({ reason: 'unknown_category' });
  });

  it('gets one market, 404 for an unknown one', async () => {
    const p = await player();
    const r = await call(p, 'GET', `/v1/real-markets/markets/${MARKET}`);
    expect(r.status).toBe(200);
    expect(r.body.market).toMatchObject({ marketId: MARKET, yesPrice: '0.40' });
    const missing = await call(
      p,
      'GET',
      `/v1/real-markets/markets/${Keypair.generate().publicKey.toBase58()}`,
    );
    expect(missing.status).toBe(404);
  });
});

describe('quote and build', () => {
  it('quotes for the linked wallet', async () => {
    const p = await player();
    const r = await call(p, 'POST', '/v1/real-markets/quote', {
      provider: 'panta',
      marketId: MARKET,
      side: 'yes',
      amountUsdc: '10',
    });
    expect(r.status).toBe(200);
    expect(r.body.quote).toMatchObject({ quoteId: 'qt_1', estShares: '25.00' });
    expect(panta.quotes[0]).toMatchObject({ wallet: p.wallet, amountBase: 10_000_000n });
  });

  it('validates amounts: format, server cap, venue minimum', async () => {
    const p = await player();
    const bad = await call(p, 'POST', '/v1/real-markets/quote', {
      provider: 'panta',
      marketId: MARKET,
      side: 'yes',
      amountUsdc: '1.1234567',
    });
    expect(bad.status).toBe(400);
    const big = await call(p, 'POST', '/v1/real-markets/quote', {
      provider: 'panta',
      marketId: MARKET,
      side: 'yes',
      amountUsdc: '101',
    });
    expect(big.status).toBe(400);
    expect(details(big)).toMatchObject({ reason: 'amount_above_cap', maxUsdc: '100.00' });
    await boot('realMarkets,realMarketsJupiter');
    const p2 = await player();
    const small = await call(p2, 'POST', '/v1/real-markets/quote', {
      provider: 'jupiter',
      marketId: 'POLY-1',
      side: 'no',
      amountUsdc: '4.99',
    });
    expect(small.status).toBe(400);
    expect(details(small)).toMatchObject({ reason: 'amount_below_minimum', minUsdc: '5.00' });
  });

  it('builds an unsigned tx for the linked wallet and records the order', async () => {
    const p = await player();
    const r = await call(p, 'POST', '/v1/real-markets/order/build', order({ quoteId: 'qt_1' }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      provider: 'panta',
      chain: 'solana:mainnet',
      wallet: p.wallet,
      marketId: MARKET,
      side: 'yes',
      amountUsdc: '10.00',
      attribution: { text: 'Powered by Panta' },
    });
    expect(typeof r.body.expiresAt).toBe('string');
    const tx = VersionedTransaction.deserialize(Buffer.from(r.body.txBase64 as string, 'base64'));
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(p.wallet);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    expect(panta.builds[0]).toMatchObject({
      wallet: p.wallet,
      quoteId: 'qt_1',
      maxSlippageBps: 100,
    });
    const list = await call(p, 'GET', '/v1/real-markets/orders');
    expect((list.body.orders as Array<{ orderId: string; status: string }>)[0]).toMatchObject({
      orderId: r.body.orderId,
      status: 'built',
    });
  });

  it('refuses a build without the risk acceptance or for another wallet', async () => {
    const p = await player();
    const noRisk = await call(
      p,
      'POST',
      '/v1/real-markets/order/build',
      order({ riskAccepted: false }),
    );
    expect(noRisk.status).toBe(400);
    expect(code(noRisk)).toBe('RISK_NOT_ACCEPTED');
    const oldCopy = await call(
      p,
      'POST',
      '/v1/real-markets/order/build',
      order({ riskWarningVersion: '2020-01-01' }),
    );
    expect(code(oldCopy)).toBe('RISK_NOT_ACCEPTED');
    const other = await call(
      p,
      'POST',
      '/v1/real-markets/order/build',
      order({ wallet: Keypair.generate().publicKey.toBase58() }),
    );
    expect(other.status).toBe(403);
    expect(code(other)).toBe('REAL_MARKETS_WALLET_MISMATCH');
    expect(panta.builds).toHaveLength(0);
  });

  it('needs an Idempotency-Key and replays the same order for the same key', async () => {
    const p = await player();
    const noKey = await api!.app.inject({
      method: 'POST',
      url: '/v1/real-markets/order/build',
      headers: { authorization: `Bearer ${p.token}`, ...NG },
      payload: order(),
    });
    expect(noKey.statusCode).toBe(400);
    const key = uuidv7();
    const a = await call(p, 'POST', '/v1/real-markets/order/build', order(), NG, key);
    const b = await call(p, 'POST', '/v1/real-markets/order/build', order(), NG, key);
    expect(b.body.orderId).toBe(a.body.orderId);
    expect(panta.builds).toHaveLength(1);
  });

  it('caps orders per day', async () => {
    await boot('realMarkets', { REAL_MARKETS_DAILY_ORDER_CAP: '1' });
    const p = await player();
    expect((await call(p, 'POST', '/v1/real-markets/order/build', order())).status).toBe(201);
    const second = await call(p, 'POST', '/v1/real-markets/order/build', order());
    expect(second.status).toBe(429);
    expect(details(second)).toMatchObject({ reason: 'real_markets_daily_cap', cap: 1 });
  });
});

describe('submitted signatures', () => {
  async function built(p: Player): Promise<string> {
    const r = await call(p, 'POST', '/v1/real-markets/order/build', order({ quoteId: 'qt_1' }));
    expect(r.status).toBe(201);
    return r.body.orderId as string;
  }

  it('records, verifies on mainnet, then tells the venue', async () => {
    const p = await player();
    const orderId = await built(p);
    const sig = fakeSignature();
    mainnet.landed.set(sig, { feePayer: p.wallet, programs: [PROGRAM], err: null });
    const r = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId,
      signature: sig,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      orderId,
      status: 'confirmed',
      providerState: 'filled',
      signature: sig,
      wallet: p.wallet,
      explorerUrl: `https://solscan.io/tx/${sig}`,
    });
    expect(panta.submitted).toEqual([
      expect.objectContaining({
        providerOrderId: 'ord_1',
        providerQuoteId: 'qt_1',
        signature: sig,
        wallet: p.wallet,
      }),
    ]);
    expect(panta.confirmed).toHaveLength(1);
    // Repeating the same signature is safe and does not notify again.
    const again = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId,
      signature: sig,
    });
    expect(again.body.status).toBe('confirmed');
    expect(panta.submitted).toHaveLength(1);
    expect(panta.confirmed).toHaveLength(1);
  });

  it('stays submitted until it lands, then GET flips it to confirmed', async () => {
    const p = await player();
    const orderId = await built(p);
    const sig = fakeSignature();
    const r = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId,
      signature: sig,
    });
    expect(r.body.status).toBe('submitted');
    mainnet.landed.set(sig, { feePayer: p.wallet, programs: [PROGRAM], err: null });
    const g = await call(p, 'GET', `/v1/real-markets/orders/${orderId}`);
    expect(g.body).toMatchObject({ status: 'confirmed', providerState: 'filled' });
  });

  it('marks an on-chain failure as failed', async () => {
    const p = await player();
    const orderId = await built(p);
    const sig = fakeSignature();
    mainnet.landed.set(sig, {
      feePayer: p.wallet,
      programs: [PROGRAM],
      err: { InstructionError: [0, 'Custom'] },
    });
    const r = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId,
      signature: sig,
    });
    expect(r.body.status).toBe('failed');
    expect(String(r.body.error)).toContain('chain_error');
    expect(panta.confirmed).toHaveLength(0);
  });

  it('rejects a signature from another wallet or for other programs', async () => {
    const p = await player();
    const orderId = await built(p);
    const sig = fakeSignature();
    mainnet.landed.set(sig, {
      feePayer: Keypair.generate().publicKey.toBase58(),
      programs: [PROGRAM],
      err: null,
    });
    const r = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId,
      signature: sig,
    });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('REAL_MARKETS_TX_MISMATCH');
    expect(details(r)).toMatchObject({ reason: 'fee_payer' });
    const g = await call(p, 'GET', `/v1/real-markets/orders/${orderId}`);
    expect(g.body.status).toBe('mismatch');
  });

  it('refuses a signature already used by another order, or a second signature', async () => {
    const p = await player();
    const a = await built(p);
    const b = await built(p);
    const sig = fakeSignature();
    await call(p, 'POST', '/v1/real-markets/order/submitted', { orderId: a, signature: sig });
    const reuse = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId: b,
      signature: sig,
    });
    expect(reuse.status).toBe(422);
    expect(details(reuse)).toMatchObject({ reason: 'signature_reused' });
    const second = await call(p, 'POST', '/v1/real-markets/order/submitted', {
      orderId: a,
      signature: fakeSignature(),
    });
    expect(details(second)).toMatchObject({ reason: 'order_already_submitted' });
  });

  it('hides other players orders', async () => {
    const owner = await player();
    const orderId = await built(owner);
    const stranger = await player();
    const g = await call(stranger, 'GET', `/v1/real-markets/orders/${orderId}`);
    expect(g.status).toBe(404);
    const s = await call(stranger, 'POST', '/v1/real-markets/order/submitted', {
      orderId,
      signature: fakeSignature(),
    });
    expect(s.status).toBe(404);
  });
});

describe('positions', () => {
  it('reads the linked wallet only, valued from market detail', async () => {
    const p = await player();
    const r = await call(p, 'GET', '/v1/real-markets/positions');
    expect(r.status).toBe(200);
    expect(panta.positionWallets).toEqual([p.wallet]);
    expect(r.body).toMatchObject({
      provider: 'panta',
      wallet: p.wallet,
      attribution: { text: 'Powered by Panta' },
    });
    expect((r.body.positions as RealPosition[])[0]).toMatchObject({
      marketId: MARKET,
      title: 'SOL above 300 by Dec?',
      estValueUsdc: '10.00',
    });
  });
});
