/**
 * Panta adapter against a mocked fetch: request shapes match the partner docs
 * (trailing slashes, X-Api-Key, decimal USDC), responses normalise, the build becomes an
 * unsigned v0 transaction with the player's wallet as fee payer and only signer, venue
 * error codes map to Real Markets errors, and the API key never leaks into an error.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { PantaProvider } from './panta.js';
import type { DomainError } from '../domain/errors.js';

const KEY = 'pk_test_not_a_real_key';
const BASE = 'https://panta.test/api/v1';
const wallet = Keypair.generate().publicKey.toBase58();
const program = Keypair.generate().publicKey.toBase58();
const market = Keypair.generate().publicKey.toBase58();
const blockhash = Keypair.generate().publicKey.toBase58();

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  answer: (s: Seen) => { status: number; body?: unknown; headers?: Record<string, string> },
): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const s: Seen = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    seen.push(s);
    const a = answer(s);
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), {
      status: a.status,
      headers: a.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const now = (): Date => new Date('2026-10-31T12:00:00Z');

function provider(fetchImpl: typeof fetch, apiKey = KEY): PantaProvider {
  return new PantaProvider({ apiKey, baseUrl: BASE, fetchImpl, now });
}

async function caught(p: Promise<unknown>): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected a rejection');
}

const row = {
  marketId: market,
  category: 'crypto',
  title: 'ETH above 5k?',
  description: 'Resolves from CoinGecko.',
  images: ['https://img.test/eth.png'],
  phase: 'primary',
  marketType: 'standard',
  startTime: 1767225600,
  endTime: 1798761599,
  resolutionTime: 1798765199,
  resolved: false,
  status: 'open',
  volumeUsdc: '1200.00',
  yesPrice: '0.52',
  noPrice: '0.48',
};

describe('PantaProvider', () => {
  it('lists the catalog with the documented query and auth header', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: { items: [{ ...row, yesPrice: null, noPrice: null }], nextCursor: 'abc' },
    }));
    const page = await provider(fetchImpl).listMarkets({
      category: 'crypto',
      cursor: 'c1',
      limit: 20,
    });
    expect(seen[0]!.url).toBe(`${BASE}/markets/?limit=20&category=crypto&cursor=c1`);
    expect(seen[0]!.headers['x-api-key']).toBe(KEY);
    expect(page.nextCursor).toBe('abc');
    expect(page.items[0]).toMatchObject({
      provider: 'panta',
      marketId: market,
      title: 'ETH above 5k?',
      status: 'open',
      tradable: true,
      yesPrice: null,
      closeTime: 1798761599,
      imageUrl: 'https://img.test/eth.png',
    });
  });

  it('reads detail prices, and a secondary (graduated) market is not tradable here', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: { ...row, phase: 'secondary' },
    }));
    const m = await provider(fetchImpl).getMarket(market);
    expect(seen[0]!.url).toBe(`${BASE}/markets/${market}/`);
    expect(m).toMatchObject({ yesPrice: '0.52', noPrice: '0.48', tradable: false, status: 'open' });
  });

  it('returns null for an unknown market', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: { code: 'MARKET_NOT_FOUND' } }));
    expect(await provider(fetchImpl).getMarket(market)).toBeNull();
  });

  it('quotes with a decimal USDC amount', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: {
        quoteId: 'qt_1',
        shares: '38.42',
        avgPrice: '0.520800',
        feeUsdc: '0.40',
        expiresAt: '2026-10-31T12:01:30Z',
      },
    }));
    const q = await provider(fetchImpl).quote({
      wallet,
      marketId: market,
      side: 'yes',
      amountBase: 20_000_000n,
    });
    expect(seen[0]!.url).toBe(`${BASE}/primaryorderquote/`);
    expect(seen[0]!.body).toEqual({ wallet, marketId: market, side: 'yes', amountUsdc: '20.00' });
    expect(q).toMatchObject({
      quoteId: 'qt_1',
      estShares: '38.42',
      feeUsdc: '0.40',
      amountUsdc: '20.00',
    });
  });

  it('builds an unsigned v0 transaction: wallet pays and is the only signer', async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: {
        orderId: 'ord_1',
        quoteId: 'qt_1',
        wallet,
        marketId: market,
        expectedShares: '38.40',
        feeUsdc: '0.40',
        instructions: [
          {
            programId: program,
            data: Buffer.from([1, 2, 3]).toString('base64'),
            accounts: [
              { pubkey: wallet, isSigner: true, isWritable: true },
              { pubkey: other, isSigner: false, isWritable: true },
            ],
          },
        ],
        recentBlockhash: blockhash,
        lastValidBlockHeight: 123,
        expiresAt: '2026-10-31T12:02:00Z',
        blockhashExpiryHintSec: 60,
      },
    }));
    const b = await provider(fetchImpl).buildOrder({
      wallet,
      marketId: market,
      side: 'yes',
      amountBase: 20_000_000n,
      quoteId: 'qt_1',
      maxSlippageBps: 100,
    });
    expect(seen[0]!.url).toBe(`${BASE}/primaryorderbuild/`);
    expect(seen[0]!.body).toEqual({ quoteId: 'qt_1', wallet, maxSlippageBps: 100 });
    const tx = VersionedTransaction.deserialize(Buffer.from(b.txBase64, 'base64'));
    expect(tx.version).toBe(0);
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(wallet);
    expect(tx.message.recentBlockhash).toBe(blockhash);
    expect(tx.signatures.every((s) => s.every((x) => x === 0))).toBe(true);
    expect(b).toMatchObject({
      providerOrderId: 'ord_1',
      providerQuoteId: 'qt_1',
      lastValidBlockHeight: 123,
      programIds: [program],
      estShares: '38.40',
    });
    // The blockhash hint (60 s) is sooner than the order session (120 s).
    expect(b.expiresAt.toISOString()).toBe('2026-10-31T12:01:00.000Z');
  });

  it('takes a fresh quote when build has none', async () => {
    const { fetchImpl, seen } = mockFetch((s) =>
      s.url.endsWith('/primaryorderquote/')
        ? { status: 200, body: { quoteId: 'qt_new' } }
        : {
            status: 200,
            body: {
              orderId: 'ord_2',
              instructions: [
                {
                  programId: program,
                  data: '',
                  accounts: [{ pubkey: wallet, isSigner: true, isWritable: true }],
                },
              ],
              recentBlockhash: blockhash,
            },
          },
    );
    const b = await provider(fetchImpl).buildOrder({
      wallet,
      marketId: market,
      side: 'no',
      amountBase: 5_000_000n,
      quoteId: null,
      maxSlippageBps: 100,
    });
    expect(seen.map((s) => s.url.replace(BASE, ''))).toEqual([
      '/primaryorderquote/',
      '/primaryorderbuild/',
    ]);
    expect(b.providerQuoteId).toBe('qt_new');
  });

  it('refuses a build that needs any signer other than the wallet', async () => {
    const intruder = Keypair.generate().publicKey.toBase58();
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: {
        orderId: 'ord_x',
        instructions: [
          {
            programId: program,
            data: '',
            accounts: [{ pubkey: intruder, isSigner: true, isWritable: true }],
          },
        ],
        recentBlockhash: blockhash,
      },
    }));
    const e = await caught(
      provider(fetchImpl).buildOrder({
        wallet,
        marketId: market,
        side: 'yes',
        amountBase: 1_000_000n,
        quoteId: 'qt',
        maxSlippageBps: 100,
      }),
    );
    expect(e.code).toBe('REAL_MARKETS_PROVIDER_ERROR');
    expect(e.details).toMatchObject({ reason: 'unexpected_signer' });
  });

  it('maps venue codes to Real Markets errors', async () => {
    const cases: Array<[number, unknown, string]> = [
      [400, { code: 'QUOTE_STALE' }, 'REAL_MARKETS_QUOTE_EXPIRED'],
      [400, { code: 'QUOTE_EXPIRED' }, 'REAL_MARKETS_QUOTE_EXPIRED'],
      [400, { code: 'AMOUNT_TOO_SMALL', message: 'below min' }, 'REAL_MARKETS_ORDER_REJECTED'],
      [400, { code: 'MARKET_NOT_IN_PRIMARY' }, 'REAL_MARKETS_ORDER_REJECTED'],
      [401, { code: 'UNAUTHORIZED' }, 'REAL_MARKETS_PROVIDER_UNAVAILABLE'],
      [400, { code: 'SOMETHING_NEW' }, 'REAL_MARKETS_PROVIDER_ERROR'],
    ];
    for (const [status, body, code] of cases) {
      const { fetchImpl } = mockFetch(() => ({ status, body }));
      const e = await caught(
        provider(fetchImpl).quote({ wallet, marketId: market, side: 'yes', amountBase: 1n }),
      );
      expect(e.code, JSON.stringify(body)).toBe(code);
      expect(JSON.stringify(e.details)).not.toContain(KEY);
      expect(e.message).not.toContain(KEY);
    }
  });

  it('turns 429 into RATE_LIMITED with the venue Retry-After', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 429,
      body: { code: 'RATE_LIMITED' },
      headers: { 'retry-after': '7' },
    }));
    const e = await caught(
      provider(fetchImpl).listMarkets({ category: null, cursor: null, limit: 5 }),
    );
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.details).toMatchObject({ retryAfterMs: 7000, provider: 'panta' });
  });

  it('retries reads on 5xx, then reports the venue unavailable', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({ status: 503, body: {} }));
    const e = await caught(
      provider(fetchImpl).listMarkets({ category: null, cursor: null, limit: 5 }),
    );
    expect(e.code).toBe('REAL_MARKETS_PROVIDER_UNAVAILABLE');
    expect(seen).toHaveLength(3);
  });

  it('does not retry a quote (not idempotent)', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({ status: 502, body: {} }));
    await caught(
      provider(fetchImpl).quote({ wallet, marketId: market, side: 'yes', amountBase: 1n }),
    );
    expect(seen).toHaveLength(1);
  });

  it('is unavailable without an API key and calls nothing', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({ status: 200, body: {} }));
    const p = provider(fetchImpl, '');
    expect(p.isConfigured()).toBe(false);
    const e = await caught(p.listMarkets({ category: null, cursor: null, limit: 5 }));
    expect(e.code).toBe('REAL_MARKETS_PROVIDER_UNAVAILABLE');
    expect(e.details).toMatchObject({ reason: 'not_configured' });
    expect(seen).toHaveLength(0);
  });

  it('submits, reports and verifies with the documented bodies', async () => {
    const { fetchImpl, seen } = mockFetch((s) =>
      s.url.endsWith('/primaryorderverify/')
        ? { status: 200, body: { orderId: 'ord_1', status: 'confirmed' } }
        : { status: 200, body: { status: 'submitted' } },
    );
    const p = provider(fetchImpl);
    const input = {
      providerOrderId: 'ord_1',
      providerQuoteId: 'qt_1',
      signature: 'sig1',
      wallet,
      marketId: market,
    };
    await p.notifySubmitted(input);
    await p.notifyConfirmed(input);
    expect(await p.orderState(input)).toBe('filled');
    expect(seen.map((s) => [s.url.replace(BASE, ''), s.body])).toEqual([
      ['/primaryordersubmit/', { orderId: 'ord_1', signature: 'sig1', wallet }],
      ['/trades/', { signature: 'sig1', wallet, marketId: market, quoteId: 'qt_1' }],
      ['/primaryorderverify/', { orderId: 'ord_1', signature: 'sig1', wallet }],
    ]);
  });

  it('lists positions for a wallet', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: {
        wallet,
        positions: [
          {
            marketId: market,
            category: 'crypto',
            side: 'yes',
            shares: '38.40',
            phase: 'primary',
            claimable: false,
            claimed: false,
            outcome: null,
          },
          { marketId: market, side: 'maybe', shares: '1' },
        ],
      },
    }));
    const ps = await provider(fetchImpl).positions(wallet);
    expect(seen[0]!.url).toBe(`${BASE}/positions/?wallet=${wallet}`);
    expect(ps).toEqual([
      expect.objectContaining({
        marketId: market,
        side: 'yes',
        shares: '38.40',
        claimable: false,
        outcome: null,
      }),
    ]);
  });
});
