/**
 * Real Factory launches (migration 104) against a fake chain: prepare builds a
 * tx the mint already signed, submit co-signs last only for the same launch,
 * confirm verifies and registers, the Helius webhook indexes trades and
 * punishes creator sells. The real DBC program was exercised in the Phase 0
 * spike (ct-life-evidence/factory-r5/mwa-spike).
 */
import { createPublicKey, verify as ed25519Verify } from 'node:crypto';
import sharp from 'sharp';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishWorldEvent: vi.fn(async () => undefined),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  AgeRequiredError,
  FactoryUnavailableError,
  LaunchTxMismatchError,
  NameNotAllowedError,
  RiskNotAcceptedError,
} from '../shared/domain/errors.js';
import {
  DBC_PROGRAM_ID,
  type ConfirmedTx,
  type FactoryChain,
  type PoolSnapshot,
} from '../shared/solana/dbc-chain.js';
import type { MetadataStore } from './factory-metadata.js';
import { publishWorldEvent } from './realtime-bus.js';
import {
  _setFactoryChainForTests,
  _setMetadataStoreForTests,
  cleanDescription,
  confirmLaunch,
  getToken,
  isSameLaunch,
  listTokens,
  mintDeltas,
  prepareLaunch,
  processFactoryWebhook,
  submitLaunch,
  type RawTx,
} from './factory-real.js';

loadDotenv({ path: process.cwd() + '/.env' });
process.env.FACTORY_DBC_CONFIG = Keypair.generate().publicKey.toBase58();
_resetConfigForTests();
_resetContextForTests();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const DBC = new PublicKey(DBC_PROGRAM_ID);

/** A fake cluster: records sent txs, answers confirmations and pool reads from memory. */
class FakeChain implements FactoryChain {
  readonly cluster = 'devnet' as const;
  height = 100;
  sent: Buffer[] = [];
  confirmed = new Map<string, ConfirmedTx>();
  pools = new Map<string, PoolSnapshot>();
  async buildCreatePoolTx(p: { mint: PublicKey; wallet: PublicKey }): Promise<Transaction> {
    const pool = Keypair.generate().publicKey;
    return new Transaction().add(
      new TransactionInstruction({
        programId: DBC,
        keys: [
          { pubkey: p.mint, isSigner: true, isWritable: true },
          { pubkey: p.wallet, isSigner: true, isWritable: true },
          { pubkey: pool, isSigner: false, isWritable: true },
        ],
        data: Buffer.from('create-pool'),
      }),
    );
  }
  async latestBlockhash() {
    return {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: this.height + 150,
    };
  }
  async blockHeight() {
    return this.height;
  }
  async sendRaw(bytes: Buffer) {
    this.sent.push(bytes);
    return `sig${this.sent.length}${Math.random().toString(36).slice(2)}`.padEnd(88, 'x');
  }
  async getConfirmedTransaction(sig: string) {
    return this.confirmed.get(sig) ?? null;
  }
  async getPool(pool: string) {
    return this.pools.get(pool) ?? null;
  }
  async getConfig() {
    return null;
  }
}

const store: MetadataStore = {
  kind: 'test',
  async put(name) {
    return `https://meta.test/${name}`;
  },
};

let chain: FakeChain;
beforeEach(() => {
  chain = new FakeChain();
  _setFactoryChainForTests(chain);
  _setMetadataStoreForTests(store);
  vi.mocked(publishWorldEvent).mockClear();
});
afterEach(() => {
  _setFactoryChainForTests(null);
  _setMetadataStoreForTests(undefined);
});
afterAll(async () => {
  delete process.env.FACTORY_DBC_CONFIG;
  _resetConfigForTests();
  await pool.end();
});

async function player(opts: { adult?: boolean } = {}): Promise<{ id: string; wallet: Keypair }> {
  const id = uuidv7();
  const wallet = Keypair.generate();
  await pool.query(`INSERT INTO users (id, wallet, lottery_rolled_at) VALUES ($1, $2, now())`, [
    id,
    wallet.publicKey.toBase58(),
  ]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
     VALUES ($1, $2, $3, '{}', 'trencher', '{a,b}', 'make_10k', $4, 'studio')`,
    [uuidv7(), id, `fr_${id.slice(-12)}`, opts.adult === false ? null : new Date()],
  );
  return { id, wallet };
}

const png = async (): Promise<string> =>
  (
    await sharp({ create: { width: 64, height: 64, channels: 3, background: '#22aa55' } })
      .png()
      .toBuffer()
  ).toString('base64');
const ticker = (): string => `R${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

function sigValid(tx: Transaction, key: PublicKey): boolean {
  const s = tx.signatures.find((x) => x.publicKey.equals(key))?.signature;
  if (!s) return false;
  const pub = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.toBuffer()]),
    format: 'der',
    type: 'spki',
  });
  return ed25519Verify(null, tx.serializeMessage(), pub, s);
}

describe('prepare', () => {
  it('returns a legacy tx with the priority fee in it, the mint signed and the wallet slot empty', async () => {
    const p = await player();
    const out = await prepareLaunch(ctx, p.id, {
      name: 'Frog Of Wall Street',
      ticker: ticker(),
      description: 'a frog that trades',
      imageBase64: await png(),
      riskAccepted: true,
    });
    const tx = Transaction.from(Buffer.from(out.txBase64, 'base64'));
    expect(tx.feePayer?.equals(p.wallet.publicKey)).toBe(true);
    expect(tx.instructions[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(tx.instructions[1]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
    expect(sigValid(tx, new PublicKey(out.mint))).toBe(true);
    expect(tx.signatures.find((s) => s.publicKey.equals(p.wallet.publicKey))?.signature).toBeNull();
    expect(out.metadataUri).toMatch(/^https:\/\/meta\.test\/.+\.json$/);
    // the mint secret is never in Postgres
    const row = await pool.query(`SELECT * FROM factory_launches WHERE launch_id = $1`, [
      out.launchId,
    ]);
    expect(JSON.stringify(row.rows[0])).not.toMatch(/secret/i);
    expect(await ctx.redis.main.get(`factory:mint:${out.launchId}`)).not.toBeNull();
  });

  it('gates: risk warning, 18+, moderation, and 503 when not configured', async () => {
    const p = await player();
    const base = {
      name: 'Good Coin',
      ticker: ticker(),
      imageBase64: await png(),
      riskAccepted: true,
    };
    await expect(prepareLaunch(ctx, p.id, { ...base, riskAccepted: false })).rejects.toBeInstanceOf(
      RiskNotAcceptedError,
    );
    const minor = await player({ adult: false });
    await expect(prepareLaunch(ctx, minor.id, base)).rejects.toBeInstanceOf(AgeRequiredError);
    await expect(
      prepareLaunch(ctx, p.id, { ...base, name: 'f u c k coin' }),
    ).rejects.toBeInstanceOf(NameNotAllowedError);
    expect(() => cleanDescription('buy at scam.xyz now')).toThrow(NameNotAllowedError);
    expect(cleanDescription('this hit different, the frog is it')).toBe(
      'this hit different, the frog is it',
    );
    _setMetadataStoreForTests(null);
    await expect(prepareLaunch(ctx, p.id, base)).rejects.toBeInstanceOf(FactoryUnavailableError);
  });
});

describe('submit (the server signs last) and confirm', () => {
  it('co-signs a wallet-signed tx even if the wallet changed the priority fee, then registers the token', async () => {
    const p = await player();
    const out = await prepareLaunch(ctx, p.id, {
      name: 'Submit Path',
      ticker: ticker(),
      imageBase64: await png(),
      riskAccepted: true,
    });
    const prepared = Transaction.from(Buffer.from(out.txBase64, 'base64'));
    // The wallet rewrites the priority fee and signs only its own key.
    const mod = new Transaction({
      feePayer: p.wallet.publicKey,
      blockhash: prepared.recentBlockhash!,
      lastValidBlockHeight: 999,
    });
    mod.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999 }),
      ...prepared.instructions.filter((i) => !i.programId.equals(ComputeBudgetProgram.programId)),
    );
    mod.partialSign(p.wallet);
    const signedTxBase64 = mod.serialize({ requireAllSignatures: false }).toString('base64');
    const poolAddr = out.pool;
    // What the cluster will report once it lands.
    const origSend = chain.sendRaw.bind(chain);
    chain.sendRaw = async (bytes: Buffer) => {
      const sig = await origSend(bytes);
      const sent = Transaction.from(bytes);
      expect(sigValid(sent, p.wallet.publicKey)).toBe(true);
      expect(sigValid(sent, new PublicKey(out.mint))).toBe(true);
      chain.confirmed.set(sig, {
        err: null,
        feePayer: p.wallet.publicKey.toBase58(),
        accountKeys: [p.wallet.publicKey.toBase58(), out.mint, poolAddr, DBC_PROGRAM_ID],
        slot: 1,
        blockTime: Math.floor(Date.now() / 1000),
      });
      chain.pools.set(poolAddr, {
        config: process.env.FACTORY_DBC_CONFIG!,
        creator: p.wallet.publicKey.toBase58(),
        baseMint: out.mint,
        baseReserve: '800000000000000',
        quoteReserve: '1500000000',
        priceSol: 0.00000003,
        isMigrated: false,
        progressBps: 375,
      });
      return sig;
    };
    const res = await submitLaunch(ctx, p.id, out.launchId, signedTxBase64);
    expect(res.status).toBe('confirmed');
    expect(res.token).toMatchObject({
      mint: out.mint,
      pool: poolAddr,
      progressBps: 375,
      migrated: false,
      creator: { userId: p.id, wallet: p.wallet.publicKey.toBase58() },
    });
    expect(res.token!.marketCapSol).toBeCloseTo(30, 5);
    expect(vi.mocked(publishWorldEvent)).toHaveBeenCalledWith(
      expect.anything(),
      'evt_coin_launch',
      expect.objectContaining({ coinId: out.mint, real: '1' }),
    );
    expect(await ctx.redis.main.get(`factory:mint:${out.launchId}`)).toBeNull();
    // idempotent
    expect((await confirmLaunch(ctx, p.id, out.launchId, res.signature)).mint).toBe(out.mint);
    expect((await listTokens(ctx, p.id, 'mine', 10)).map((t) => t.mint)).toEqual([out.mint]);
  });

  it('refuses anything but the prepared launch', async () => {
    const p = await player();
    const out = await prepareLaunch(ctx, p.id, {
      name: 'Tamper Test',
      ticker: ticker(),
      imageBase64: await png(),
      riskAccepted: true,
    });
    const prepared = Transaction.from(Buffer.from(out.txBase64, 'base64'));
    const evil = new Transaction({
      feePayer: p.wallet.publicKey,
      blockhash: prepared.recentBlockhash!,
      lastValidBlockHeight: 1,
    });
    evil.add(
      ...prepared.instructions,
      SystemProgram.transfer({
        fromPubkey: p.wallet.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    evil.partialSign(p.wallet);
    await expect(
      submitLaunch(
        ctx,
        p.id,
        out.launchId,
        evil.serialize({ requireAllSignatures: false }).toString('base64'),
      ),
    ).rejects.toBeInstanceOf(LaunchTxMismatchError);
    // unsigned by the wallet
    const unsigned = Transaction.from(Buffer.from(out.txBase64, 'base64'));
    await expect(
      submitLaunch(
        ctx,
        p.id,
        out.launchId,
        unsigned.serialize({ requireAllSignatures: false }).toString('base64'),
      ),
    ).rejects.toBeInstanceOf(LaunchTxMismatchError);
    expect(isSameLaunch(prepared, evil, p.wallet.publicKey)).toBe(false);
    expect(isSameLaunch(prepared, prepared, Keypair.generate().publicKey)).toBe(false);
    // confirm with a signature the chain says is someone else's tx
    chain.confirmed.set('x'.repeat(88), {
      err: null,
      feePayer: Keypair.generate().publicKey.toBase58(),
      accountKeys: [],
      slot: 1,
      blockTime: null,
    });
    await expect(
      confirmLaunch(ctx, p.id, out.launchId, 'x'.repeat(88), { attempts: 1 }),
    ).rejects.toBeInstanceOf(LaunchTxMismatchError);
  });
});

describe('Helius raw webhook', () => {
  async function liveToken(): Promise<{ mint: string; creator: { id: string; wallet: Keypair } }> {
    const creator = await player();
    const mint = Keypair.generate().publicKey.toBase58();
    const launchId = uuidv7();
    await pool.query(
      `INSERT INTO factory_launches (launch_id, user_id, wallet, cluster, dbc_config, mint, pool, name, ticker,
         metadata_uri, image_uri, prepared_tx, last_valid_block_height, risk_accepted_at, status, expires_at)
       VALUES ($1,$2,$3,'devnet','cfg',$4,$5,'Hook Coin',$6,'u','i','tx',1,now(),'confirmed',now())`,
      [
        launchId,
        creator.id,
        creator.wallet.publicKey.toBase58(),
        mint,
        Keypair.generate().publicKey.toBase58(),
        ticker(),
      ],
    );
    await pool.query(
      `INSERT INTO factory_tokens (mint, launch_id, pool, cluster, creator_user_id, creator_wallet, name, ticker, image_uri, metadata_uri, signature)
       SELECT mint, launch_id, pool, cluster, user_id, wallet, name, ticker, image_uri, metadata_uri, 's' FROM factory_launches WHERE launch_id = $1`,
      [launchId],
    );
    return { mint, creator };
  }

  function rawTx(o: {
    sig: string;
    signer: string;
    mint: string;
    pre: string;
    post: string;
    lamportsPre: number;
    lamportsPost: number;
  }): RawTx {
    const vault = Keypair.generate().publicKey.toBase58();
    return {
      slot: 5,
      blockTime: Math.floor(Date.now() / 1000),
      meta: {
        err: null,
        fee: 5000,
        preBalances: [o.lamportsPre, 0],
        postBalances: [o.lamportsPost, 0],
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: o.mint,
            owner: o.signer,
            uiTokenAmount: { amount: o.pre, decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: o.mint,
            owner: vault,
            uiTokenAmount: { amount: '1000000', decimals: 6 },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: o.mint,
            owner: o.signer,
            uiTokenAmount: { amount: o.post, decimals: 6 },
          },
          {
            accountIndex: 2,
            mint: o.mint,
            owner: vault,
            uiTokenAmount: { amount: '1000000', decimals: 6 },
          },
        ],
      },
      transaction: {
        signatures: [o.sig],
        message: {
          accountKeys: [o.signer, Keypair.generate().publicKey.toBase58(), vault],
          header: { numRequiredSignatures: 1 },
        },
      },
    };
  }

  it('indexes trades; a creator dump adds heat and one exposé; duplicates are ignored', async () => {
    const { mint, creator } = await liveToken();
    const buyer = Keypair.generate().publicKey.toBase58();
    const buy = rawTx({
      sig: uuidv7(),
      signer: buyer,
      mint,
      pre: '0',
      post: '5000000',
      lamportsPre: 2e9,
      lamportsPost: 1.9e9,
    });
    expect(mintDeltas(buy, mint).find((d) => d.owner === buyer)).toMatchObject({
      pre: 0n,
      post: 5000000n,
    });
    const dump = rawTx({
      sig: uuidv7(),
      signer: creator.wallet.publicKey.toBase58(),
      mint,
      pre: '10000000',
      post: '2000000',
      lamportsPre: 1e9,
      lamportsPost: 1.4e9,
    });
    const out = await processFactoryWebhook(ctx, [buy, dump, dump]);
    expect(out).toEqual({ processed: 2, trades: 2, creatorMoves: 1 });
    const move = await pool.query(
      `SELECT kind, share_bps, heat_added FROM factory_creator_moves WHERE mint = $1`,
      [mint],
    );
    expect(move.rows).toEqual([{ kind: 'sell', share_bps: 8000, heat_added: 47 }]);
    const heat = await pool.query(`SELECT heat FROM player_heat WHERE user_id = $1`, [creator.id]);
    expect(Number(heat.rows[0].heat)).toBeGreaterThanOrEqual(47);
    const post = await pool.query(
      `SELECT kind, meta FROM feed_posts WHERE meta ->> 'coinId' = $1`,
      [mint],
    );
    expect(post.rows).toHaveLength(1);
    expect(post.rows[0].meta).toMatchObject({ real: true, sellSharePct: 80 });
    const tok = await getToken(ctx, mint);
    expect(tok).toMatchObject({ rugged: true, trades24h: 2 });
  });

  it('a creator transfer out (no SOL back) is a smaller penalty, no exposé', async () => {
    const { mint, creator } = await liveToken();
    const move = rawTx({
      sig: uuidv7(),
      signer: creator.wallet.publicKey.toBase58(),
      mint,
      pre: '10000000',
      post: '0',
      lamportsPre: 1e9,
      lamportsPost: 1e9 - 5000,
    });
    await processFactoryWebhook(ctx, [move]);
    const m = await pool.query(
      `SELECT kind, heat_added FROM factory_creator_moves WHERE mint = $1`,
      [mint],
    );
    expect(m.rows).toEqual([{ kind: 'transfer_out', heat_added: 10 }]);
    const post = await pool.query(`SELECT 1 FROM feed_posts WHERE meta ->> 'coinId' = $1`, [mint]);
    expect(post.rowCount).toBe(0);
  });
});
