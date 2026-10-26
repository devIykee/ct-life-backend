/**
 * Devnet run of real Factory launches THROUGH THE API (not the functions):
 * dev sign-in, prepare -> wallet signs -> send -> confirm (path A), prepare ->
 * wallet rewrites the fee and only signs -> submit (path C), then a creator
 * buy + dump replayed to the Helius webhook endpoint -> heat. Writes a
 * Markdown report with every signature and an explorer link.
 *
 * Needs: an API with ENABLE_DEV_AUTH=true, FACTORY_DBC_CONFIG (devnet config
 * from create-dbc-config.ts), a metadata store, HELIUS_FACTORY_WEBHOOK_AUTH;
 * and a FUNDED throwaway devnet wallet keypair (keypairs/ is gitignored).
 *
 *   pnpm exec tsx tools/factory/devnet-run.ts --api http://localhost:4050 \
 *     --rpc https://api.devnet.solana.com --wallet keypairs/devnet-wallet.keypair.json \
 *     --webhook-auth "$HELIUS_FACTORY_WEBHOOK_AUTH" --out ./devnet-run.md
 *
 * The webhook step replays the transactions as Helius would deliver them
 * (raw = the RPC getTransaction JSON) because Helius cannot reach a local API.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import BN from 'bn.js';
import sharp from 'sharp';
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i < 0 ? undefined : process.argv[i + 1];
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return v;
}

const API = arg('api', 'http://localhost:4050');
const RPC = arg('rpc', 'https://api.devnet.solana.com');
const OUT = arg('out', './devnet-run.md');
const WEBHOOK_AUTH = arg('webhook-auth', '');
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(arg('wallet'), 'utf8')) as number[]),
);
const conn = new Connection(RPC, 'confirmed');
const cluster = RPC.includes('devnet') ? 'devnet' : 'custom';
const explorer = (sig: string): string =>
  cluster === 'devnet'
    ? `https://explorer.solana.com/tx/${sig}?cluster=devnet`
    : `(local cluster, no explorer) ${sig}`;
const lines: string[] = [];
const log = (s: string): void => {
  console.info(s);
  lines.push(s);
};

let token = '';
async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'idempotency-key': randomUUID() } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

interface Prepared {
  launchId: string;
  txBase64: string;
  mint: string;
  pool: string;
}

const started = new Date().toISOString();
log(`# Factory devnet run (${started})`);
log('');
log(`- API ${API}, RPC ${RPC}`);
log(
  `- wallet ${wallet.publicKey.toBase58()} (throwaway), balance ${(await conn.getBalance(wallet.publicKey)) / 1e9} SOL`,
);

// Sign in as the wallet (dev auth), then lottery + an adult character.
const auth = await call<{ accessToken: string; id: string }>('POST', '/v1/auth/dev', {
  wallet: wallet.publicKey.toBase58(),
});
token = auth.accessToken;
await call('POST', '/v1/lottery/roll', {}).catch(() => undefined);
await call('POST', '/v1/characters', {
  alias: `dv_${wallet.publicKey.toBase58().slice(0, 8).toLowerCase()}`,
  look: {
    skinTone: '#f5d0a9',
    headId: 'head_default',
    hairId: 'hair_short',
    topId: 'top_hoodie',
    bottomId: 'bottom_jeans',
    shoesId: 'shoes_sneakers',
    accId: 'acc_none',
  },
  traitIds: ['fast_talker', 'deep_pockets'],
  dreamId: 'make_10k',
  tribeId: 'trencher',
  ageConfirmed: true,
}).catch(() => undefined);
const cfg = await call<{ enabled: boolean; dbcConfig: string; onChain: unknown }>(
  'GET',
  '/v1/factory/config',
);
log(`- user ${auth.id}; factory enabled ${cfg.enabled}; DBC config ${cfg.dbcConfig}`);
if (!cfg.enabled) throw new Error('factory not enabled on this API');

const image = (
  await sharp({ create: { width: 128, height: 128, channels: 3, background: '#2bb673' } })
    .png()
    .toBuffer()
).toString('base64');
const ticker = (): string => `D${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

// Path A: the wallet signs the exact prepared bytes and sends (MWA sign_and_send_transactions).
const a = await call<Prepared>('POST', '/v1/factory/launch/prepare', {
  name: 'Devnet Frog',
  ticker: ticker(),
  description: 'A devnet test token from the CT Life Factory.',
  imageBase64: image,
  riskAccepted: true,
});
const txA = Transaction.from(Buffer.from(a.txBase64, 'base64'));
txA.partialSign(wallet);
const sigA = await conn.sendRawTransaction(txA.serialize());
await conn.confirmTransaction(sigA, 'confirmed');
const tokA = await call<{ ticker: string; marketCapSol: number; progressBps: number }>(
  'POST',
  '/v1/factory/launch/confirm',
  { launchId: a.launchId, signature: sigA },
);
log('');
log(`## Path A (sign_and_send): $${tokA.ticker}`);
log(`- mint ${a.mint}, pool ${a.pool}`);
log(`- create-pool tx: ${explorer(sigA)}`);
log(`- confirmed; market cap ${tokA.marketCapSol} SOL, progress ${tokA.progressBps} bps`);

// Path C: the wallet rewrites the priority fee and only signs; the server signs last.
const c = await call<Prepared>('POST', '/v1/factory/launch/prepare', {
  name: 'Devnet Toad',
  ticker: ticker(),
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
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12_345 }),
  ...prepared.instructions.filter((x) => !x.programId.equals(ComputeBudgetProgram.programId)),
);
mod.partialSign(wallet);
const sub = await call<{ signature: string; status: string }>('POST', '/v1/factory/launch/submit', {
  launchId: c.launchId,
  signedTxBase64: mod.serialize({ requireAllSignatures: false }).toString('base64'),
});
log('');
log('## Path C (wallet rewrote the fee; server signed last)');
log(`- mint ${c.mint}, status ${sub.status}`);
log(`- create-pool tx: ${explorer(sub.signature)}`);

// Creator buy + 90% dump on the first token, replayed to the webhook -> heat.
const dbc = new DynamicBondingCurveClient(conn, 'confirmed');
async function swap(baseForQuote: boolean, amountIn: bigint): Promise<string> {
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
}
const heatBefore = await call<{ heat: number }>('GET', '/v1/heat/me');
const buySig = await swap(false, 200_000_000n);
const accts = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(a.mint) });
const held = BigInt((await conn.getTokenAccountBalance(accts.value[0]!.pubkey)).value.amount);
const sellSig = await swap(true, (held * 9n) / 10n);
const raw = async (sig: string): Promise<unknown> =>
  JSON.parse(
    JSON.stringify(
      await conn.getTransaction(sig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      }),
    ),
  );
const hook = await call<unknown>(
  'POST',
  '/v1/webhooks/helius/factory',
  [await raw(buySig), await raw(sellSig)],
  {
    authorization: WEBHOOK_AUTH,
  },
);
const heatAfter = await call<{ heat: number; level: string }>('GET', '/v1/heat/me');
const after = await call<{ rugged: boolean; trades24h: number; volume24hSol: number }>(
  'GET',
  `/v1/factory/tokens/${a.mint}`,
);
log('');
log('## Creator sell -> heat (penalty only)');
log(`- creator buy 0.2 SOL: ${explorer(buySig)}`);
log(`- creator dumps 90%: ${explorer(sellSig)}`);
log(`- webhook: ${JSON.stringify(hook)}`);
log(
  `- heat ${heatBefore.heat} -> ${heatAfter.heat} (${heatAfter.level}); token rugged ${after.rugged}, trades24h ${after.trades24h}, volume ${after.volume24hSol} SOL`,
);
log(`- wallet balance after: ${(await conn.getBalance(wallet.publicKey)) / 1e9} SOL`);
writeFileSync(OUT, lines.join('\n') + '\n');
console.info(`report: ${OUT}`);
process.exit(0);
