/**
 * Jupiter Prediction adapter against a mocked fetch (shapes from prediction.yaml and a
 * keyless live read on 2026-10-31): micro-USD prices normalise, events flatten into
 * markets, the ready-made order transaction is accepted only when the player's wallet
 * is its fee payer and only signer, and order status / positions map.
 */
import { describe, expect, it } from 'vitest';
import {
  Keypair,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { JupiterPredictionProvider } from './jupiter.js';
import type { DomainError } from '../domain/errors.js';

const KEY = 'jup_not_a_real_key';
const BASE = 'https://jup.test/prediction/v1';
const walletKp = Keypair.generate();
const wallet = walletKp.publicKey.toBase58();
const program = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();

function mockFetch(answer: (url: string, body: unknown) => { status: number; body?: unknown }): {
  fetchImpl: typeof fetch;
  seen: Array<{ url: string; body: unknown; headers: Record<string, string> }>;
} {
  const seen: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    seen.push({ url, body, headers: init.headers as Record<string, string> });
    const a = answer(url, body);
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const now = (): Date => new Date('2026-10-31T12:00:00Z');
const provider = (f: typeof fetch): JupiterPredictionProvider =>
  new JupiterPredictionProvider({ apiKey: KEY, baseUrl: BASE, fetchImpl: f, now });

function unsignedTx(signers: Keypair[]): string {
  const ix = new TransactionInstruction({
    programId: program,
    data: Buffer.from([9]),
    keys: signers.map((k) => ({ pubkey: k.publicKey, isSigner: true, isWritable: true })),
  });
  const msg = new TransactionMessage({
    payerKey: signers[0]!.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

async function caught(p: Promise<unknown>): Promise<DomainError> {
  try {
    await p;
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected a rejection');
}

const event = {
  eventId: 'POLY-1112205',
  isActive: true,
  isLive: false,
  category: 'crypto',
  subcategory: 'btc',
  volumeUsd: '16824124000000',
  metadata: {
    eventId: 'POLY-1112205',
    title: 'What price will Bitcoin hit in October?',
    imageUrl: 'https://img.test/btc.png',
  },
  markets: [
    {
      provider: 'polymarket',
      marketId: 'POLY-5170740',
      status: 'open',
      result: null,
      title: '↓ 75,000',
      openTime: 1790831233,
      closeTime: 1793505600,
      resolveAt: null,
      rulesPrimary: 'Resolves Yes if…',
      pricing: {
        buyYesPriceUsd: 31000,
        sellYesPriceUsd: 30000,
        sellNoPriceUsd: 969000,
        buyNoPriceUsd: 970000,
        volume: 1235641,
      },
    },
  ],
};

const order = {
  orderPubkey: 'OrderPda1111111111111111111111111111111111',
  userPubkey: wallet,
  marketId: 'POLY-5170740',
  contractsMicro: '161290000',
  contractsDecimal: '161.29',
  orderCostUsd: '5000000',
  estimatedTotalFeeUsd: '70000',
};

describe('JupiterPredictionProvider', () => {
  it('flattens events into markets with decimal prices', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: { data: [event], pagination: { start: 0, end: 1, hasNext: true } },
    }));
    const page = await provider(fetchImpl).listMarkets({
      category: 'crypto',
      cursor: null,
      limit: 1,
    });
    const url = new URL(seen[0]!.url);
    expect(url.pathname).toBe('/prediction/v1/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: 'polymarket',
      includeMarkets: 'true',
      sortBy: 'volume',
      start: '0',
      end: '1',
      category: 'crypto',
    });
    expect(seen[0]!.headers['x-api-key']).toBe(KEY);
    expect(page.nextCursor).toBe('1');
    expect(page.items[0]).toMatchObject({
      provider: 'jupiter',
      marketId: 'POLY-5170740',
      eventId: 'POLY-1112205',
      eventTitle: 'What price will Bitcoin hit in October?',
      title: '↓ 75,000',
      category: 'crypto',
      status: 'open',
      tradable: true,
      yesPrice: '0.031',
      noPrice: '0.97',
      sellYesPrice: '0.03',
      volumeUsdc: '16824124.00',
      closeTime: 1793505600,
      imageUrl: 'https://img.test/btc.png',
    });
  });

  it('marks a resolved market and keeps its result', async () => {
    const m = { ...event.markets[0], status: 'closed', result: 'yes', eventId: 'POLY-1112205' };
    const { fetchImpl } = mockFetch((url) =>
      url.includes('/markets/') ? { status: 200, body: m } : { status: 200, body: event },
    );
    const got = await provider(fetchImpl).getMarket('POLY-5170740');
    expect(got).toMatchObject({
      status: 'resolved',
      result: 'yes',
      tradable: false,
      category: 'crypto',
    });
  });

  it('builds: posts the documented order body and accepts a wallet-only unsigned tx', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: {
        transaction: unsignedTx([walletKp]),
        txMeta: { blockhash, lastValidBlockHeight: 999 },
        externalOrderId: null,
        order,
      },
    }));
    const b = await provider(fetchImpl).buildOrder({
      wallet,
      marketId: 'POLY-5170740',
      side: 'yes',
      amountBase: 5_000_000n,
      quoteId: null,
      maxSlippageBps: 100,
    });
    expect(seen[0]!.url).toBe(`${BASE}/orders`);
    expect(seen[0]!.body).toEqual({
      ownerPubkey: wallet,
      marketId: 'POLY-5170740',
      isYes: true,
      isBuy: true,
      depositAmount: '5000000',
      depositMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
    expect(b).toMatchObject({
      providerOrderId: order.orderPubkey,
      lastValidBlockHeight: 999,
      programIds: [program.toBase58()],
      estShares: '161.29',
      feeUsdc: '0.07',
    });
    expect(b.expiresAt.toISOString()).toBe('2026-10-31T12:01:00.000Z');
  });

  it('quotes from the order estimates (average price = cost / contracts)', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { transaction: unsignedTx([walletKp]), order },
    }));
    const q = await provider(fetchImpl).quote({
      wallet,
      marketId: 'POLY-5170740',
      side: 'yes',
      amountBase: 5_000_000n,
    });
    expect(q).toMatchObject({
      quoteId: null,
      estShares: '161.29',
      avgPrice: '0.031',
      feeUsdc: '0.07',
      amountUsdc: '5.00',
    });
  });

  it('refuses a transaction that needs another signer', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: { transaction: unsignedTx([walletKp, Keypair.generate()]), order },
    }));
    const e = await caught(
      provider(fetchImpl).buildOrder({
        wallet,
        marketId: 'm',
        side: 'no',
        amountBase: 5_000_000n,
        quoteId: null,
        maxSlippageBps: 100,
      }),
    );
    expect(e.code).toBe('REAL_MARKETS_PROVIDER_ERROR');
    expect(e.details).toMatchObject({ reason: 'unexpected_signer' });
  });

  it('refuses a transaction whose fee payer is someone else', async () => {
    const { fetchImpl } = mockFetch(() => ({
      status: 200,
      body: {
        transaction: unsignedTx([Keypair.generate()]),
        order: { ...order, userPubkey: undefined },
      },
    }));
    const e = await caught(
      provider(fetchImpl).buildOrder({
        wallet,
        marketId: 'm',
        side: 'no',
        amountBase: 5_000_000n,
        quoteId: null,
        maxSlippageBps: 100,
      }),
    );
    expect(e.details).toMatchObject({ reason: 'unexpected_signer' });
  });

  it('maps 400 to ORDER_REJECTED and 403 to UNAVAILABLE without leaking the key', async () => {
    const r400 = mockFetch(() => ({
      status: 400,
      body: { type: 'invalid_request_error', message: 'Minimum order is $5', request_id: 'r' },
    }));
    const e1 = await caught(
      provider(r400.fetchImpl).quote({
        wallet,
        marketId: 'm',
        side: 'yes',
        amountBase: 1_000_000n,
      }),
    );
    expect(e1.code).toBe('REAL_MARKETS_ORDER_REJECTED');
    expect(e1.details).toMatchObject({
      providerCode: 'invalid_request_error',
      providerMessage: 'Minimum order is $5',
    });
    const r403 = mockFetch(() => ({ status: 403, body: { message: 'forbidden' } }));
    const e2 = await caught(
      provider(r403.fetchImpl).listMarkets({ category: null, cursor: null, limit: 5 }),
    );
    expect(e2.code).toBe('REAL_MARKETS_PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(e2.details) + e2.message).not.toContain(KEY);
  });

  it('reads order status; "no history yet" is pending', async () => {
    const input = {
      providerOrderId: order.orderPubkey,
      providerQuoteId: null,
      signature: 's',
      wallet,
      marketId: 'm',
    };
    for (const [status, expected] of [
      ['filled', 'filled'],
      ['partiallyfilled', 'pending'],
      ['failed', 'failed'],
    ] as const) {
      const { fetchImpl } = mockFetch(() => ({ status: 200, body: { status } }));
      expect(await provider(fetchImpl).orderState(input)).toBe(expected);
    }
    const missing = mockFetch(() => ({ status: 404, body: { message: 'no order history found' } }));
    expect(await provider(missing.fetchImpl).orderState(input)).toBe('pending');
  });

  it('maps positions from micro USD', async () => {
    const { fetchImpl, seen } = mockFetch(() => ({
      status: 200,
      body: {
        data: [
          {
            marketId: 'POLY-5170740',
            isYes: false,
            contracts: '161',
            contractsDecimal: '161.29',
            totalCostUsd: '5000000',
            avgPriceUsd: '31000',
            valueUsd: '4838700',
            claimable: false,
            claimed: false,
            marketMetadata: {
              marketId: 'POLY-5170740',
              title: '↓ 75,000',
              status: 'open',
              result: null,
            },
            eventMetadata: { eventId: 'POLY-1112205', title: 'BTC October' },
          },
        ],
        pagination: { start: 0, end: 100, total: 1, hasNext: false },
      },
    }));
    const ps = await provider(fetchImpl).positions(wallet);
    expect(new URL(seen[0]!.url).searchParams.get('ownerPubkey')).toBe(wallet);
    expect(ps[0]).toEqual({
      provider: 'jupiter',
      marketId: 'POLY-5170740',
      title: 'BTC October · ↓ 75,000',
      side: 'no',
      shares: '161.29',
      status: 'open',
      claimable: false,
      claimed: false,
      outcome: null,
      avgPrice: '0.031',
      costUsdc: '5.00',
      estValueUsdc: '4.8387',
    });
  });
});
