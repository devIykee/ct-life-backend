/**
 * Top-up reconciliation against finalized chain data (real DB, fake RPC):
 * missed webhooks credit once, status beats the clock, and nothing but an
 * exact verified transfer credits Cash.
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  getPaymentIntent,
  markSubmitted,
  reconcileOpenIntents,
  reconcilePaymentIntent,
} from './topup.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});
const MINT = Keypair.generate().publicKey.toBase58();
const TREASURY = Keypair.generate().publicKey.toBase58();

/** signature -> finalized parsed tx; reference -> finalized signatures. */
let finalized: Map<string, unknown>;
let history: Map<string, string[]>;

const helius = {
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (method === 'getTransaction') return (finalized.get(params[0] as string) ?? null) as T;
    if (method === 'getSignaturesForAddress') {
      return (history.get(params[0] as string) ?? []).map((signature) => ({
        signature,
        err: null,
      })) as T;
    }
    throw new Error(`unexpected rpc ${method}`);
  },
} as unknown as HeliusClient;

function ctx(): AppContext {
  return { ...buildContext(), helius };
}

interface Intent {
  intentId: string;
  userId: string;
  wallet: string;
  reference: string;
  memo: string;
}

async function newIntent(expiresInMs = 15 * 60_000): Promise<Intent> {
  const userId = uuidv7();
  const wallet = Keypair.generate().publicKey.toBase58();
  await pool.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, wallet]);
  const intent = {
    intentId: uuidv7(),
    userId,
    wallet,
    reference: Keypair.generate().publicKey.toBase58(),
    memo: uuidv7(),
  };
  await pool.query(
    `INSERT INTO payment_intents
     (intent_id, user_id, kind, currency, amount, recipient, mint, reference, memo, cash_cents,
      bonus_bps, status, expires_at)
     VALUES ($1, $2, 'topup', 'USDC', '1000000', $3, $4, $5, $6, 1000, 0, 'pending', $7)`,
    [
      intent.intentId,
      userId,
      TREASURY,
      MINT,
      intent.reference,
      intent.memo,
      new Date(Date.now() + expiresInMs).toISOString(),
    ],
  );
  return intent;
}

function paymentTx(i: Intent, opts: { amount?: string; err?: unknown; payer?: string } = {}) {
  const payer = opts.payer ?? i.wallet;
  const amount = opts.amount ?? '1000000';
  const source = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(payer));
  const destination = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(TREASURY));
  return {
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: opts.err ?? null,
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: MINT,
          owner: TREASURY,
          uiTokenAmount: { amount, decimals: 6 },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: payer, signer: true },
          { pubkey: i.reference, signer: false },
          { pubkey: destination.toBase58(), signer: false },
        ],
        instructions: [
          {
            programId: TOKEN_PROGRAM_ID.toBase58(),
            parsed: {
              type: 'transferChecked',
              info: {
                source: source.toBase58(),
                destination: destination.toBase58(),
                authority: payer,
                mint: MINT,
                tokenAmount: { amount, decimals: 6 },
              },
            },
          },
          { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: i.memo },
        ],
      },
    },
  };
}

function sig(): string {
  return randomUUID().replace(/-/g, '').repeat(3).slice(0, 88);
}

async function cash(userId: string): Promise<bigint> {
  const r = await pool.query<{ cash_cents: string }>(
    'SELECT cash_cents FROM balances WHERE user_id = $1',
    [userId],
  );
  return BigInt(r.rows[0]?.cash_cents ?? '0');
}

async function status(intentId: string): Promise<string> {
  const r = await pool.query<{ status: string }>(
    'SELECT status FROM payment_intents WHERE intent_id = $1',
    [intentId],
  );
  return r.rows[0]!.status;
}

beforeEach(() => {
  finalized = new Map();
  history = new Map();
});

afterAll(async () => {
  await pool.end();
});

describe('top-up reconciliation', () => {
  it('credits a missed webhook from reference history exactly once', async () => {
    const i = await newIntent();
    const s = sig();
    finalized.set(s, paymentTx(i));
    history.set(i.reference, [s]);

    await reconcileOpenIntents(ctx(), 500);
    await reconcileOpenIntents(ctx(), 500);
    expect(await reconcilePaymentIntent(ctx(), i.intentId, s)).toBe('unchanged');

    expect(await status(i.intentId)).toBe('confirmed');
    expect(await cash(i.userId)).toBe(1000n);
  });

  it('keeps a confirmed intent confirmed after its expiry', async () => {
    const i = await newIntent(1_000);
    const s = sig();
    finalized.set(s, paymentTx(i));
    expect(await reconcilePaymentIntent(ctx(), i.intentId, s)).toBe('confirmed');
    await pool.query(
      `UPDATE payment_intents SET expires_at = now() - interval '1 day' WHERE intent_id = $1`,
      [i.intentId],
    );
    await expect(getPaymentIntent(ctx(), i.userId, i.intentId)).resolves.toMatchObject({
      status: 'confirmed',
      signature: s,
    });
  });

  it('keeps a reported but unfinalized payment pending past expiry, then credits it', async () => {
    const i = await newIntent(-60 * 60_000);
    const s = sig();
    await markSubmitted(ctx(), i.userId, i.intentId, s);
    await reconcileOpenIntents(ctx(), 500);
    expect(await status(i.intentId)).toBe('pending');
    await expect(getPaymentIntent(ctx(), i.userId, i.intentId)).resolves.toMatchObject({
      status: 'pending',
    });

    finalized.set(s, paymentTx(i));
    await reconcileOpenIntents(ctx(), 500);
    expect(await status(i.intentId)).toBe('confirmed');
    expect(await cash(i.userId)).toBe(1000n);
  });

  it('credits a payment that lands after an unsigned intent was expired', async () => {
    const i = await newIntent(-60 * 60_000);
    await reconcileOpenIntents(ctx(), 500);
    expect(await status(i.intentId)).toBe('expired');
    await expect(getPaymentIntent(ctx(), i.userId, i.intentId)).rejects.toMatchObject({
      code: 'PAYMENT_EXPIRED',
    });

    const s = sig();
    finalized.set(s, paymentTx(i));
    history.set(i.reference, [s]);
    await reconcileOpenIntents(ctx(), 500);
    expect(await status(i.intentId)).toBe('confirmed');
    expect(await cash(i.userId)).toBe(1000n);
  });

  it.each([
    ['short amount', { amount: '999999' }],
    ['another payer', { payer: Keypair.generate().publicKey.toBase58() }],
  ])('never credits a %s', async (_label, opts) => {
    const i = await newIntent();
    const s = sig();
    finalized.set(s, paymentTx(i, opts));
    history.set(i.reference, [s]);
    expect(await reconcilePaymentIntent(ctx(), i.intentId, s)).toBe('pending');
    expect(await cash(i.userId)).toBe(0n);
  });

  it('marks the intent failed when the reported transfer failed on chain', async () => {
    const i = await newIntent();
    const s = sig();
    finalized.set(s, paymentTx(i, { err: { InstructionError: [0, 'Custom'] } }));
    await markSubmitted(ctx(), i.userId, i.intentId, s);
    expect(await status(i.intentId)).toBe('failed');
    expect(await cash(i.userId)).toBe(0n);
  });

  it('does not let another intent squatting the signature block the payer', async () => {
    const victim = await newIntent();
    const squatter = await newIntent();
    const s = sig();
    await markSubmitted(ctx(), squatter.userId, squatter.intentId, s);
    finalized.set(s, paymentTx(victim));
    history.set(victim.reference, [s]);
    expect(await reconcilePaymentIntent(ctx(), victim.intentId)).toBe('confirmed');
    expect(await cash(victim.userId)).toBe(1000n);
    expect(await cash(squatter.userId)).toBe(0n);
  });
});
