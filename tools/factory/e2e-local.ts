/**
 * End-to-end check of the real launch code against a cluster that has the DBC
 * program (local validator with it cloned from devnet, or devnet itself).
 * Not part of CI. Needs FACTORY_DBC_CONFIG, HELIUS_RPC_URL_DEVNET pointing at
 * the cluster, PUBLIC_API_BASE_URL (self store) and a funded throwaway wallet
 * keypair file passed as --wallet (stands in for the player's Seeker wallet).
 *
 *   pnpm exec tsx tools/factory/e2e-local.ts --wallet ./throwaway.json
 */
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { buildContext } from '../../server/application/context.js';
import { uuidv7 } from '../../server/shared/domain/uuid.js';
import {
  confirmLaunch,
  getRealFactoryConfig,
  getToken,
  prepareLaunch,
  processFactoryWebhook,
  submitLaunch,
} from '../../server/application/factory-real.js';
import BN from 'bn.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

const i = process.argv.indexOf('--wallet');
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.argv[i + 1]!, 'utf8')) as number[]),
);
const ctx = buildContext();
const conn = new Connection(ctx.config.solana.rpcUrl, 'confirmed');

// A player row for the wallet (adult, with a character).
const userId = uuidv7();
await ctx.db.withConnection(async (c) => {
  await c.query(
    `DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE wallet = $1)`,
    [wallet.publicKey.toBase58()],
  );
  await c.query(`UPDATE users SET wallet = wallet || '-old-' || id WHERE wallet = $1`, [
    wallet.publicKey.toBase58(),
  ]);
  await c.query(`INSERT INTO users (id, wallet, lottery_rolled_at) VALUES ($1, $2, now())`, [
    userId,
    wallet.publicKey.toBase58(),
  ]);
  await c.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, age_confirmed_at, home_id)
     VALUES ($1, $2, $3, '{}', 'trencher', '{a,b}', 'make_10k', now(), 'studio')`,
    [uuidv7(), userId, `e2e_${userId.slice(-8)}`],
  );
});
console.info('config', JSON.stringify(await getRealFactoryConfig(ctx)).slice(0, 300));
const image = (
  await sharp({ create: { width: 64, height: 64, channels: 3, background: '#33cc66' } })
    .png()
    .toBuffer()
).toString('base64');
const tick = () => `E${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

// Path A: the wallet signs the exact bytes and sends.
const a = await prepareLaunch(ctx, userId, {
  name: 'E2E Frog',
  ticker: tick(),
  imageBase64: image,
  riskAccepted: true,
});
const txA = Transaction.from(Buffer.from(a.txBase64, 'base64'));
txA.partialSign(wallet);
const sigA = await conn.sendRawTransaction(txA.serialize());
await conn.confirmTransaction(sigA, 'confirmed');
const tokA = await confirmLaunch(ctx, userId, a.launchId, sigA);
console.info(
  'A confirmed',
  tokA.ticker,
  'priceSol',
  tokA.priceSol,
  'mcapSol',
  tokA.marketCapSol,
  'progressBps',
  tokA.progressBps,
);

// Path C: the wallet rewrites the priority fee and only signs; the server signs last.
const c = await prepareLaunch(ctx, userId, {
  name: 'E2E Toad',
  ticker: tick(),
  imageBase64: image,
  riskAccepted: true,
});
const prepared = Transaction.from(Buffer.from(c.txBase64, 'base64'));
const mod = new Transaction({
  feePayer: wallet.publicKey,
  blockhash: prepared.recentBlockhash!,
  lastValidBlockHeight: 1e9,
});
mod.add(
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1234 }),
  ...prepared.instructions.filter((x) => !x.programId.equals(ComputeBudgetProgram.programId)),
);
mod.partialSign(wallet);
const res = await submitLaunch(
  ctx,
  userId,
  c.launchId,
  mod.serialize({ requireAllSignatures: false }).toString('base64'),
);
console.info('C', res.status, res.token?.ticker);
console.info('token read', JSON.stringify(await getToken(ctx, a.mint)).slice(0, 400));

// Trades and a creator dump, fed to the webhook processor exactly as the RPC returns them
// (Helius raw deliveries use the same getTransaction JSON shape [Unverified]).
const dbc = new DynamicBondingCurveClient(conn, 'confirmed');
const swap = async (baseForQuote: boolean, amountIn: bigint): Promise<string> => {
  const t = await dbc.pool.swap({
    owner: wallet.publicKey,
    pool: new PublicKey(a.pool),
    amountIn: new BN(amountIn.toString()),
    minimumAmountOut: new BN(0),
    swapBaseForQuote: baseForQuote,
    referralTokenAccount: null,
  });
  t.feePayer = wallet.publicKey;
  t.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  t.sign(wallet);
  const sig = await conn.sendRawTransaction(t.serialize());
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
};
const buySig = await swap(false, 500_000_000n); // creator buys 0.5 SOL of their own token
const bal = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(a.mint) });
const held = BigInt((await conn.getTokenAccountBalance(bal.value[0]!.pubkey)).value.amount);
const sellSig = await swap(true, (held * 9n) / 10n); // then dumps 90%
const raw = async (sig: string) =>
  JSON.parse(
    JSON.stringify(
      await conn.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
    ),
  );
const hook = await processFactoryWebhook(ctx, [await raw(buySig), await raw(sellSig)]);
console.info('webhook', JSON.stringify(hook));
const after = await getToken(ctx, a.mint);
console.info(
  'after dump: rugged',
  after?.rugged,
  'trades24h',
  after?.trades24h,
  'volume24hSol',
  after?.volume24hSol,
  'progressBps',
  after?.progressBps,
);
await ctx.db.close();
await ctx.redis.close();
process.exit(0);
