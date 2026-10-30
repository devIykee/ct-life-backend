/**
 * Season pass purchase (unlock C1) over HTTP: dark until `seasonPassPurchase` is on,
 * sku/kind pairing, the 5 USDC intent, settlement grants the pass without Cash and
 * pushes nothing into the ledger, a second purchase is refused, and the old Cash
 * `POST /season-pass/buy` is gone. Real DB; the chain is a fake RPC.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { buildServer } from './main.js';
import { _resetContextForTests, buildContext } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { _setClusterRpcForTests } from '../application/chain-rpc.js';
import { reconcilePaymentIntent } from '../application/topup.js';
import { currentSeason } from '../application/season-tracks.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { HeliusClient } from '../shared/solana/helius.js';

loadDotenv({ path: process.cwd() + '/.env' });

const savedCaps = process.env.CAPABILITIES_ON;
const pool = new Pool({
  connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
});

let finalized: Map<string, unknown> = new Map();
const fakeRpc = {
  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    if (method === 'getTransaction') return (finalized.get(params[0] as string) ?? null) as T;
    if (method === 'getSignaturesForAddress') return [] as T;
    throw new Error(`unexpected rpc ${method}`);
  },
} as unknown as HeliusClient;

let app: Awaited<ReturnType<typeof buildServer>>['app'];
let stop: () => Promise<void>;

async function boot(caps: string | undefined): Promise<void> {
  if (caps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = caps;
  process.env.LOG_LEVEL = 'warn';
  _resetConfigForTests();
  _resetContextForTests();
  const handle = await buildServer();
  app = handle.app;
  await app.ready();
  stop = handle.stop;
}

interface Authed {
  id: string;
  wallet: string;
  token: string;
}

async function devAuth(): Promise<Authed> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const r = await app.inject({
    method: 'POST',
    url: '/v1/auth/dev',
    headers: { 'idempotency-key': `c1-${uuidv7()}` },
    payload: { wallet },
  });
  expect(r.statusCode, r.body).toBe(200);
  const b = r.json() as { id: string; accessToken: string };
  return { id: b.id, wallet, token: b.accessToken };
}

async function post(u: Authed, url: string, payload?: unknown) {
  const r = await app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${u.token}`, 'idempotency-key': uuidv7() },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
  return {
    status: r.statusCode,
    body: (r.body === '' ? {} : r.json()) as Record<string, unknown>,
  };
}

async function cashOf(userId: string): Promise<string> {
  const r = await pool.query<{ cash_cents: string }>(
    'SELECT cash_cents FROM balances WHERE user_id = $1',
    [userId],
  );
  return r.rows[0]?.cash_cents ?? '0';
}

const PASS = { kind: 'season_pass', sku: 'season_pass', currency: 'USDC' };

/** A finalized transferChecked of `amount` from the payer to the treasury, as RPC returns it. */
function transferTx(i: {
  wallet: string;
  recipient: string;
  mint: string;
  reference: string;
  memo: string;
  amount: string;
}) {
  const source = getAssociatedTokenAddressSync(new PublicKey(i.mint), new PublicKey(i.wallet));
  const destination = getAssociatedTokenAddressSync(
    new PublicKey(i.mint),
    new PublicKey(i.recipient),
  );
  return {
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: i.mint,
          owner: i.recipient,
          uiTokenAmount: { amount: i.amount, decimals: 6 },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: i.wallet, signer: true },
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
                authority: i.wallet,
                mint: i.mint,
                tokenAmount: { amount: i.amount, decimals: 6 },
              },
            },
          },
          { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: i.memo },
        ],
      },
    },
  };
}

beforeAll(() => {
  _setClusterRpcForTests(fakeRpc);
  vi.spyOn(Connection.prototype, 'getLatestBlockhash').mockResolvedValue({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 1,
  });
});

afterEach(async () => {
  await stop();
});

afterAll(async () => {
  vi.restoreAllMocks();
  _setClusterRpcForTests(null);
  if (savedCaps === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = savedCaps;
  _resetConfigForTests();
  _resetContextForTests();
  await pool.end();
});

describe('season pass purchase', () => {
  it('is dark while seasonPassPurchase is off: 503 and no config key; /buy is 410', async () => {
    await boot(undefined);
    const u = await devAuth();
    const cfg = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(cfg.json().seasonPass).toBeUndefined();
    const r = await post(u, '/v1/payments/intents', PASS);
    expect(r.status, JSON.stringify(r.body)).toBe(503);
    expect(r.body.error).toMatchObject({
      code: 'CAPABILITY_OFF',
      details: { capability: 'seasonPassPurchase' },
    });
    const buy = await post(u, '/v1/season-pass/buy');
    expect(buy.status).toBe(410);
    expect(buy.body.error).toMatchObject({ code: 'GONE', details: { reason: 'buy_with_intent' } });
  }, 30_000);

  it('refuses a season_pass sku on another kind, and another sku on season_pass', async () => {
    await boot('seasonPassPurchase');
    const u = await devAuth();
    for (const body of [
      { kind: 'season_pass', sku: 'ramen', currency: 'USDC' },
      { kind: 'topup', sku: 'season_pass', currency: 'USDC' },
    ]) {
      const r = await post(u, '/v1/payments/intents', body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { reason: 'sku_kind_mismatch' },
      });
    }
  }, 30_000);

  it('sells the pass for 5 USDC, grants it on a verified transfer without Cash, then 409', async () => {
    await boot('seasonPassPurchase');
    const season = currentSeason(new Date());
    const cfg = (await app.inject({ method: 'GET', url: '/v1/config' })).json();
    if (season === null) {
      // No season running today: nothing on sale.
      expect(cfg.seasonPass).toBeUndefined();
      return;
    }
    expect(cfg.seasonPass).toEqual({
      sku: 'season_pass',
      priceUsdc: '5000000',
      currency: 'USDC',
      seasonId: season.seasonId,
      endsAt: season.endsAt,
    });

    const u = await devAuth();
    const cashBefore = await cashOf(u.id);
    const r = await post(u, '/v1/payments/intents', PASS);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const intent = r.body as Record<string, string | number>;
    expect(intent).toMatchObject({ amount: '5000000', currency: 'USDC', cashCents: 0 });
    expect(String(intent.solanaPayUrl)).toContain('amount=5&');
    expect(typeof intent.tx).toBe('string');

    const signature = randomUUID().replace(/-/g, '').repeat(3).slice(0, 88);
    finalized.set(
      signature,
      transferTx({
        wallet: u.wallet,
        recipient: String(intent.recipient),
        mint: String(intent.mint),
        reference: String(intent.reference),
        memo: String(intent.memo),
        amount: '5000000',
      }),
    );
    const sub = await post(u, `/v1/payments/intents/${intent.intentId}/submitted`, { signature });
    expect(sub.status).toBe(204);
    // markSubmitted reconciles at once; a second pass is a no-op.
    expect(await reconcilePaymentIntent(buildContext(), String(intent.intentId))).toBe('unchanged');

    const pass = await app.inject({
      method: 'GET',
      url: '/v1/season-pass/me',
      headers: { authorization: `Bearer ${u.token}` },
    });
    expect(pass.statusCode).toBe(200);
    expect(pass.json()).toMatchObject({
      tier: 'season',
      expiresAt: new Date(season.endsAt).toISOString(),
    });
    expect(await cashOf(u.id)).toBe(cashBefore);
    const credit = await pool.query(
      `SELECT 1 FROM ledger_entries WHERE user_id = $1 AND ref_id = $2`,
      [u.id, intent.intentId],
    );
    expect(credit.rows.length).toBe(0);

    const again = await post(u, '/v1/payments/intents', PASS);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'CONFLICT',
      details: { reason: 'already_active' },
    });
  }, 30_000);

  it('a short transfer never grants the pass', async () => {
    await boot('seasonPassPurchase');
    if (currentSeason(new Date()) === null) return;
    const u = await devAuth();
    const r = await post(u, '/v1/payments/intents', PASS);
    const intent = r.body as Record<string, string>;
    const signature = randomUUID().replace(/-/g, '').repeat(3).slice(0, 88);
    finalized.set(
      signature,
      transferTx({
        wallet: u.wallet,
        recipient: intent.recipient!,
        mint: intent.mint!,
        reference: intent.reference!,
        memo: intent.memo!,
        amount: '4999999',
      }),
    );
    await post(u, `/v1/payments/intents/${intent.intentId}/submitted`, { signature });
    const pass = await pool.query(
      `SELECT 1 FROM season_pass WHERE user_id = $1 AND tier = 'season'`,
      [u.id],
    );
    expect(pass.rows.length).toBe(0);
    // While that signed intent is reconciled, a new one is refused.
    const again = await post(u, '/v1/payments/intents', PASS);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ details: { reason: 'intent_pending' } });
    finalized = new Map();
  }, 30_000);

  /** A season_pass intent written straight to the table, with a verified 'amount' transfer on chain. */
  async function paidIntent(u: Authed, amount: string): Promise<string> {
    const intentId = uuidv7();
    const recipient = Keypair.generate().publicKey.toBase58();
    const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const reference = Keypair.generate().publicKey.toBase58();
    const memo = uuidv7();
    const signature = randomUUID().replace(/-/g, '').repeat(3).slice(0, 88);
    await pool.query(
      `INSERT INTO payment_intents (intent_id, user_id, kind, currency, amount, recipient, mint,
         reference, memo, cash_cents, bonus_bps, status, signature, expires_at)
       VALUES ($1, $2, 'season_pass', 'USDC', $3, $4, $5, $6, $7, 0, 0, 'pending', $8,
               now() + interval '10 minutes')`,
      [intentId, u.id, amount, recipient, mint, reference, memo, signature],
    );
    finalized.set(
      signature,
      transferTx({ wallet: u.wallet, recipient, mint, reference, memo, amount }),
    );
    return intentId;
  }

  it('a legacy season_pass intent at another price never grants a pass (fails, for a manual refund)', async () => {
    await boot('seasonPassPurchase');
    if (currentSeason(new Date()) === null) return;
    const u = await devAuth();
    const id = await paidIntent(u, '1000000');
    expect(await reconcilePaymentIntent(buildContext(), id)).toBe('failed');
    const st = await pool.query('SELECT status FROM payment_intents WHERE intent_id = $1', [id]);
    expect(st.rows[0].status).toBe('failed');
    const pass = await pool.query(
      `SELECT 1 FROM season_pass WHERE user_id = $1 AND tier = 'season'`,
      [u.id],
    );
    expect(pass.rows.length).toBe(0);
  }, 30_000);

  it('while seasonPassPurchase is off a paid 5 USDC intent waits, and settles once it is on', async () => {
    await boot(undefined);
    if (currentSeason(new Date()) === null) return;
    const u = await devAuth();
    const id = await paidIntent(u, '5000000');
    expect(await reconcilePaymentIntent(buildContext(), id)).toBe('pending');
    const none = await pool.query(
      `SELECT 1 FROM season_pass WHERE user_id = $1 AND tier = 'season'`,
      [u.id],
    );
    expect(none.rows.length).toBe(0);
    await stop();
    await boot('seasonPassPurchase');
    expect(await reconcilePaymentIntent(buildContext(), id)).toBe('confirmed');
    const pass = await pool.query(
      `SELECT 1 FROM season_pass WHERE user_id = $1 AND tier = 'season'`,
      [u.id],
    );
    expect(pass.rows.length).toBe(1);
  }, 30_000);
});
