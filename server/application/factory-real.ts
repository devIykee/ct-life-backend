/**
 * Real token launches on Meteora DBC (docs/FACTORY-REAL.md). The Cash Factory
 * is retired.
 *
 * Flow (Phase 0 spike, ct-life-evidence/factory-r5/mwa-spike/SPIKE-RESULT.md):
 *   prepare  -> the server builds the DBC create-pool tx (legacy), with the
 *               priority-fee instructions already in it, fee payer = the
 *               player's wallet, a fresh blockhash, and the fresh mint's
 *               signature. The client hands those exact bytes to MWA
 *               `sign_and_send_transactions`.
 *   confirm  -> after the wallet sent it: verify on chain, register the token.
 *   submit   -> fallback if a wallet rewrote the tx (which breaks the mint
 *               signature): the wallet only signs, the server checks it is
 *               the same launch (only ComputeBudget may differ), signs with
 *               the mint LAST, sends, and confirms.
 *
 * Guardrails: 18+ (character age confirmation), an explicit risk warning on
 * every launch, moderated name / ticker / description, re-encoded image. The
 * server never holds a funded key; the mint secret lives in Redis for 15
 * minutes only (for the fallback), never in Postgres or logs.
 *
 * Real rugs are penalties only: a creator-wallet sell of a launched mint adds
 * heat and (for a big share) an exposé post; nothing rewards it.
 */
import { createPublicKey, timingSafeEqual, verify as ed25519Verify } from 'node:crypto';
import sharp from 'sharp';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk';
import type { AppContext } from './context.js';
import { runInTransaction } from '../shared/db/uow.js';
import {
  AgeRequiredError,
  FactoryUnavailableError,
  ForbiddenError,
  LaunchExpiredError,
  LaunchLimitReachedError,
  LaunchNotConfirmedError,
  LaunchTxMismatchError,
  NameNotAllowedError,
  NotFoundError,
  RateLimitedError,
  RiskNotAcceptedError,
  TickerTakenError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { cleanCoinText, isBlockedText } from './factory-filter.js';
import {
  createFactoryChain,
  DBC_PROGRAM_ID,
  type FactoryChain,
  type PoolSnapshot,
} from '../shared/solana/dbc-chain.js';
import { metadataStoreFromConfig, type MetadataStore } from './factory-metadata.js';
import { publishWorldEvent } from './realtime-bus.js';
import { addHeat } from './player-heat.js';
import {
  RUG_HEAT_BASE,
  RUG_HEAT_SHARE_BONUS,
  RUG_SELL_BPS,
  SLEUTH_USER_ID,
  sleuthPostText,
} from './factory-rug.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_SUPPLY = 1_000_000_000; // whole tokens (the partner config's totalTokenSupply)
export const DESCRIPTION_MAX = 200;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const DAILY_REAL_LAUNCH_CAP = 3;
const MINT_SECRET_TTL_S = 15 * 60;
const STATE_TTL_MS = 15_000;
const TRANSFER_OUT_HEAT = 10;
/** Shown before every launch and echoed back as `riskAccepted`. Copy can change; bump the version. */
export const RISK_WARNING = {
  version: '2026-10-26',
  text:
    'This launches a real token on Solana with real money. Token prices can go to zero. ' +
    "Don't launch or buy unless you're prepared to lose all the money you put in. " +
    'Nothing here is financial advice, and no profit is promised.',
} as const;

// --- Wiring (overridable in tests) ------------------------------------------

let chainOverride: FactoryChain | null = null;
let storeOverride: MetadataStore | null | undefined;
let chainCached: FactoryChain | null = null;

/** Test-only: replace the chain adapter (null restores the real one). */
export function _setFactoryChainForTests(c: FactoryChain | null): void {
  chainOverride = c;
}
/** Test-only: replace the metadata store (undefined restores config). */
export function _setMetadataStoreForTests(s: MetadataStore | null | undefined): void {
  storeOverride = s;
}

function chainOf(ctx: AppContext): FactoryChain {
  if (chainOverride) return chainOverride;
  chainCached ??= createFactoryChain(ctx.config.solana.rpcUrl, ctx.config.solana.cluster);
  return chainCached;
}

function storeOf(ctx: AppContext): MetadataStore | null {
  return storeOverride !== undefined ? storeOverride : metadataStoreFromConfig(ctx.config, ctx.db);
}

function requireEnabled(ctx: AppContext): { config: PublicKey; store: MetadataStore } {
  const f = ctx.config.factory;
  const store = storeOf(ctx);
  if (!f.dbcConfig || !store) throw new FactoryUnavailableError({});
  return { config: new PublicKey(f.dbcConfig), store };
}

/**
 * True when real launches can be served: a DBC partner config and a metadata store are
 * configured. `GET /config` adds `factory` only when this and the `factory` capability
 * are both true (application/chain-config.ts).
 */
export function realFactoryEnabled(ctx: AppContext): boolean {
  return Boolean(ctx.config.factory.dbcConfig) && storeOf(ctx) !== null;
}

// --- Config -----------------------------------------------------------------

/** What the client shows before a launch (fees from the on-chain partner config). */
export async function getRealFactoryConfig(ctx: AppContext): Promise<Record<string, unknown>> {
  const f = ctx.config.factory;
  const enabled = realFactoryEnabled(ctx);
  let onChain: Record<string, unknown> | null = null;
  if (enabled) {
    const key = `factory:config:${f.dbcConfig}`;
    const cached = await ctx.redis.main.get(key);
    if (cached) onChain = JSON.parse(cached) as Record<string, unknown>;
    else {
      try {
        const c = await chainOf(ctx).getConfig(f.dbcConfig);
        if (c) {
          onChain = { ...c };
          await ctx.redis.main.set(key, JSON.stringify(onChain), 'EX', 600);
        }
      } catch {
        onChain = null;
      }
    }
  }
  return {
    real: true,
    enabled,
    cluster: ctx.config.solana.cluster,
    dbcConfig: f.dbcConfig || null,
    partnerFeeWallet: f.partnerFeeWallet || null,
    onChain,
    riskWarning: RISK_WARNING,
    ageGate: 18,
    limits: {
      nameMax: 24,
      tickerMax: 6,
      descriptionMax: DESCRIPTION_MAX,
      imageMaxBytes: IMAGE_MAX_BYTES,
      dailyLaunches: DAILY_REAL_LAUNCH_CAP,
    },
    /** [Inference] Measured on the DBC program (spike): rent + fees, before any first buy. */
    estimatedCostSol: 0.025,
  };
}

// --- Moderation -------------------------------------------------------------

/**
 * A launch blurb: at most 200 chars, no links, no blocked word (checked word
 * by word so ordinary sentences pass).
 * @param raw - The description.
 * @returns The cleaned text.
 */
export function cleanDescription(raw: string): string {
  const d = raw.trim().replace(/\s+/g, ' ');
  if (d.length > DESCRIPTION_MAX)
    throw new ValidationFailedError({ reason: 'description too long' });
  if (
    /(https?:\/\/|www\.)/i.test(d) ||
    /\b[\w-]+\.(com|io|xyz|fun|gg|app|net|org|sol)\b/i.test(d)
  ) {
    throw new NameNotAllowedError({ field: 'description', reason: 'links are not allowed' });
  }
  for (const word of d.split(' ')) {
    if (word && isBlockedText(word)) throw new NameNotAllowedError({ field: 'description' });
  }
  return d;
}

/** Decode, bound and re-encode the image (512x512 PNG; strips metadata). */
async function cleanImage(imageBase64: string): Promise<Buffer> {
  const raw = Buffer.from(imageBase64, 'base64');
  if (raw.length === 0 || raw.length > IMAGE_MAX_BYTES) {
    throw new ValidationFailedError({ reason: 'image must be 1 byte to 2 MB' });
  }
  try {
    return await sharp(raw, { limitInputPixels: 4096 * 4096 })
      .resize(512, 512, { fit: 'cover' })
      .png()
      .toBuffer();
  } catch {
    throw new ValidationFailedError({ reason: 'image is not a PNG, JPEG or WebP' });
  }
}

// --- Prepare ----------------------------------------------------------------

export interface PrepareInput {
  readonly name: string;
  readonly ticker: string;
  readonly description?: string;
  readonly imageBase64: string;
  readonly riskAccepted: boolean;
  readonly riskWarningVersion?: string;
}

export interface PreparedLaunch {
  readonly launchId: string;
  readonly txBase64: string;
  readonly mint: string;
  readonly pool: string;
  readonly cluster: 'devnet' | 'mainnet';
  readonly lastValidBlockHeight: number;
  readonly expiresAt: string;
  readonly metadataUri: string;
  readonly imageUri: string;
}

/**
 * Build the launch transaction, partially signed by a fresh mint.
 */
export async function prepareLaunch(
  ctx: AppContext,
  userId: string,
  input: PrepareInput,
  now: Date = new Date(),
): Promise<PreparedLaunch> {
  const { config, store } = requireEnabled(ctx);
  if (input.riskAccepted !== true)
    throw new RiskNotAcceptedError({ version: RISK_WARNING.version });
  const clean = cleanCoinText(input.name, input.ticker);
  if (!clean) throw new NameNotAllowedError({ field: 'name_or_ticker' });
  const description = cleanDescription(input.description ?? '');

  const who = await ctx.db.withConnection((c) =>
    c.query<{ wallet: string; age_confirmed_at: Date | null }>(
      `SELECT u.wallet, ch.age_confirmed_at FROM users u
         LEFT JOIN characters ch ON ch.user_id = u.id WHERE u.id = $1`,
      [userId],
    ),
  );
  const row = who.rows[0];
  if (!row) throw new NotFoundError({ kind: 'user' });
  if (!row.age_confirmed_at) throw new AgeRequiredError({});
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(row.wallet);
  } catch {
    throw new ForbiddenError({ reason: 'wallet_required' });
  }

  const limit = await perUserTokenBucket(
    ctx.redis.main,
    `rl:factory:prepare:${userId}`,
    5,
    1 / 120,
    1,
  );
  if (!limit.allowed) throw new RateLimitedError(limit.retryAfterMs, { limit: 5 });

  const chain = chainOf(ctx);
  const gate = await ctx.db.withConnection((c) =>
    c.query<{ taken: boolean; today: number }>(
      `SELECT EXISTS (SELECT 1 FROM factory_tokens WHERE cluster = $1 AND upper(ticker) = upper($2)) AS taken,
              (SELECT count(*)::int FROM factory_tokens
                WHERE creator_user_id = $3 AND launched_at > $4) AS today`,
      [chain.cluster, clean.ticker, userId, new Date(now.getTime() - 86_400_000)],
    ),
  );
  if (gate.rows[0]?.taken) throw new TickerTakenError({ ticker: clean.ticker });
  if ((gate.rows[0]?.today ?? 0) >= DAILY_REAL_LAUNCH_CAP) {
    throw new LaunchLimitReachedError({ cap: DAILY_REAL_LAUNCH_CAP });
  }

  const image = await cleanImage(input.imageBase64);
  const imageUri = await store.put(`${clean.ticker}.png`, image, 'image/png');
  const metadata = Buffer.from(
    JSON.stringify({
      name: clean.name,
      symbol: clean.ticker,
      description,
      image: imageUri,
      properties: { files: [{ uri: imageUri, type: 'image/png' }], category: 'image' },
    }),
  );
  const metadataUri = await store.put(`${clean.ticker}.json`, metadata, 'application/json');
  if (metadataUri.length > 200) throw new Error('metadata uri longer than 200 chars');

  const mint = Keypair.generate();
  const tx = await chain.buildCreatePoolTx({
    config,
    mint: mint.publicKey,
    wallet,
    name: clean.name,
    symbol: clean.ticker,
    uri: metadataUri,
  });
  // Our own priority fee, so wallets that add one only when it is missing
  // (Phantom documents this) leave the signed message alone.
  tx.instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: ctx.config.factory.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: ctx.config.factory.priorityMicroLamports,
    }),
  );
  const bh = await chain.latestBlockhash();
  tx.feePayer = wallet;
  tx.recentBlockhash = bh.blockhash;
  tx.partialSign(mint);
  const txBase64 = tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
  const pool = deriveDbcPoolAddress(new PublicKey(WSOL_MINT), mint.publicKey, config).toBase58();

  const launchId = uuidv7();
  // A blockhash lives ~60-90 s; the row expires with a margin for the wallet prompt.
  const expiresAt = new Date(now.getTime() + 120_000);
  await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO factory_launches
         (launch_id, user_id, wallet, cluster, dbc_config, mint, pool, name, ticker, description,
          metadata_uri, image_uri, prepared_tx, last_valid_block_height, risk_accepted_at, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16)`,
      [
        launchId,
        userId,
        wallet.toBase58(),
        chain.cluster,
        config.toBase58(),
        mint.publicKey.toBase58(),
        pool,
        clean.name,
        clean.ticker,
        description,
        metadataUri,
        imageUri,
        txBase64,
        bh.lastValidBlockHeight,
        now,
        expiresAt,
      ],
    ),
  );
  await ctx.redis.main.set(
    mintKey(launchId),
    Buffer.from(mint.secretKey).toString('base64'),
    'EX',
    MINT_SECRET_TTL_S,
  );
  return {
    launchId,
    txBase64,
    mint: mint.publicKey.toBase58(),
    pool,
    cluster: chain.cluster,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    expiresAt: expiresAt.toISOString(),
    metadataUri,
    imageUri,
  };
}

const mintKey = (launchId: string): string => `factory:mint:${launchId}`;

// --- Submit (fallback: the server signs last) ---------------------------------

const CB = ComputeBudgetProgram.programId.toBase58();

function instructionKey(i: TransactionInstruction): string {
  return [
    i.programId.toBase58(),
    i.data.toString('hex'),
    i.keys
      .map((k) => `${k.pubkey.toBase58()}${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`)
      .join(','),
  ].join(':');
}

/**
 * True when `returned` is the prepared launch: same fee payer and blockhash,
 * the same non-ComputeBudget instructions in the same order, and at most four
 * ComputeBudget instructions (the wallet may have changed the priority fee).
 * @param prepared - The transaction the server built.
 * @param returned - What the wallet signed.
 * @param wallet - The player's wallet.
 * @returns Whether it is safe to co-sign.
 */
export function isSameLaunch(
  prepared: Transaction,
  returned: Transaction,
  wallet: PublicKey,
): boolean {
  if (!returned.feePayer?.equals(wallet)) return false;
  if (returned.recentBlockhash !== prepared.recentBlockhash) return false;
  const strip = (t: Transaction): string[] =>
    t.instructions.filter((i) => i.programId.toBase58() !== CB).map(instructionKey);
  if (returned.instructions.filter((i) => i.programId.toBase58() === CB).length > 4) return false;
  return JSON.stringify(strip(prepared)) === JSON.stringify(strip(returned));
}

function walletSigned(tx: Transaction, wallet: PublicKey): boolean {
  const sig = tx.signatures.find((s) => s.publicKey.equals(wallet))?.signature;
  if (!sig) return false;
  const pub = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.toBuffer()]),
    format: 'der',
    type: 'spki',
  });
  return ed25519Verify(null, tx.serializeMessage(), pub, sig);
}

interface LaunchRow {
  launch_id: string;
  user_id: string;
  wallet: string;
  cluster: 'devnet' | 'mainnet';
  dbc_config: string;
  mint: string;
  pool: string;
  name: string;
  ticker: string;
  metadata_uri: string;
  image_uri: string;
  prepared_tx: string;
  last_valid_block_height: string;
  status: string;
  signature: string | null;
  expires_at: Date;
}

async function loadLaunch(ctx: AppContext, userId: string, launchId: string): Promise<LaunchRow> {
  const r = await ctx.db.withConnection((c) =>
    c.query<LaunchRow>(`SELECT * FROM factory_launches WHERE launch_id = $1 AND user_id = $2`, [
      launchId,
      userId,
    ]),
  );
  if (!r.rows[0]) throw new NotFoundError({ kind: 'launch', id: launchId });
  return r.rows[0];
}

/**
 * Fallback path: the wallet signed (and maybe rewrote the priority fee); the
 * server checks it, signs with the mint last, sends, and tries to confirm.
 */
export async function submitLaunch(
  ctx: AppContext,
  userId: string,
  launchId: string,
  signedTxBase64: string,
): Promise<{ signature: string; status: 'submitted' | 'confirmed'; token: TokenView | null }> {
  requireEnabled(ctx);
  const launch = await loadLaunch(ctx, userId, launchId);
  if (launch.status === 'confirmed') {
    return {
      signature: launch.signature!,
      status: 'confirmed',
      token: await getToken(ctx, launch.mint),
    };
  }
  if (launch.status !== 'prepared') throw new LaunchExpiredError({ status: launch.status });
  const chain = chainOf(ctx);
  if ((await chain.blockHeight()) > Number(launch.last_valid_block_height)) {
    await markLaunch(ctx, launchId, 'expired', null);
    throw new LaunchExpiredError({});
  }
  let returned: Transaction;
  try {
    returned = Transaction.from(Buffer.from(signedTxBase64, 'base64'));
  } catch {
    throw new LaunchTxMismatchError({ reason: 'not a transaction' });
  }
  const wallet = new PublicKey(launch.wallet);
  const prepared = Transaction.from(Buffer.from(launch.prepared_tx, 'base64'));
  if (!isSameLaunch(prepared, returned, wallet)) throw new LaunchTxMismatchError({});
  if (!walletSigned(returned, wallet))
    throw new LaunchTxMismatchError({ reason: 'wallet signature missing or invalid' });
  const secret = await ctx.redis.main.get(mintKey(launchId));
  if (!secret) throw new LaunchExpiredError({ reason: 'mint key expired' });
  const mint = Keypair.fromSecretKey(Buffer.from(secret, 'base64'));
  if (mint.publicKey.toBase58() !== launch.mint) throw new LaunchTxMismatchError({});
  returned.partialSign(mint);
  const signature = await chain.sendRaw(returned.serialize({ requireAllSignatures: true }));
  await markLaunch(ctx, launchId, 'submitted', signature);
  try {
    const token = await confirmLaunch(ctx, userId, launchId, signature, { attempts: 8 });
    return { signature, status: 'confirmed', token };
  } catch (e) {
    if (e instanceof LaunchNotConfirmedError)
      return { signature, status: 'submitted', token: null };
    throw e;
  }
}

async function markLaunch(
  ctx: AppContext,
  launchId: string,
  status: string,
  signature: string | null,
  error?: string,
): Promise<void> {
  await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE factory_launches SET status = $2, signature = COALESCE($3, signature), error = $4
        WHERE launch_id = $1`,
      [launchId, status, signature, error ?? null],
    ),
  );
}

// --- Confirm ------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Verify the launch on chain and register the token (idempotent).
 */
export async function confirmLaunch(
  ctx: AppContext,
  userId: string,
  launchId: string,
  signature: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<TokenView> {
  requireEnabled(ctx);
  const launch = await loadLaunch(ctx, userId, launchId);
  if (launch.status === 'confirmed') return (await getToken(ctx, launch.mint))!;
  if (launch.signature && launch.signature !== signature) {
    throw new LaunchTxMismatchError({
      reason: 'a different signature was submitted for this launch',
    });
  }
  const chain = chainOf(ctx);
  let tx = null;
  for (let i = 0; i < (opts.attempts ?? 4); i++) {
    tx = await chain.getConfirmedTransaction(signature);
    if (tx) break;
    await sleep(opts.delayMs ?? 1500);
  }
  if (!tx) throw new LaunchNotConfirmedError({ reason: 'not_found_yet' });
  if (tx.err) {
    await markLaunch(ctx, launchId, 'failed', signature, JSON.stringify(tx.err).slice(0, 200));
    throw new LaunchNotConfirmedError({ reason: 'failed_on_chain' });
  }
  const keys = new Set(tx.accountKeys);
  if (
    tx.feePayer !== launch.wallet ||
    !keys.has(launch.mint) ||
    !keys.has(launch.pool) ||
    !keys.has(DBC_PROGRAM_ID)
  ) {
    throw new LaunchTxMismatchError({ reason: 'signature is not this launch' });
  }
  const pool = await chain.getPool(launch.pool);
  if (
    !pool ||
    pool.creator !== launch.wallet ||
    pool.baseMint !== launch.mint ||
    pool.config !== launch.dbc_config
  ) {
    throw new LaunchTxMismatchError({ reason: 'pool does not match' });
  }
  const at = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
  const fresh = await runInTransaction(
    async (c) => {
      const ins = await c.query(
        `INSERT INTO factory_tokens
         (mint, launch_id, pool, cluster, creator_user_id, creator_wallet, name, ticker, image_uri,
          metadata_uri, signature, launched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (mint) DO NOTHING`,
        [
          launch.mint,
          launchId,
          launch.pool,
          launch.cluster,
          launch.user_id,
          launch.wallet,
          launch.name,
          launch.ticker,
          launch.image_uri,
          launch.metadata_uri,
          signature,
          at,
        ],
      );
      await c.query(
        `UPDATE factory_launches SET status = 'confirmed', signature = $2, confirmed_at = now()
        WHERE launch_id = $1`,
        [launchId, signature],
      );
      return (ins.rowCount ?? 0) > 0;
    },
    {},
    ctx.db,
  );
  await saveSnapshot(ctx, launch.mint, pool);
  await ctx.redis.main.del(mintKey(launchId));
  if (fresh) {
    const alias = await aliasOf(ctx, launch.user_id);
    await publishWorldEvent(ctx, 'evt_coin_launch', {
      coinId: launch.mint,
      ticker: launch.ticker,
      real: '1',
      cluster: launch.cluster,
      creatorAlias: alias,
    });
    await watchAddresses(ctx, [launch.wallet, launch.pool]);
  }
  return (await getToken(ctx, launch.mint))!;
}

async function aliasOf(ctx: AppContext, userId: string): Promise<string> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ alias: string }>(`SELECT alias FROM characters WHERE user_id = $1`, [userId]),
  );
  return r.rows[0]?.alias ?? 'anon';
}

/**
 * Add addresses to the Helius raw webhook (best effort; needs
 * HELIUS_FACTORY_WEBHOOK_ID). [Unverified] path: GET then PUT
 * `https://api.helius.xyz/v0/webhooks/{id}?api-key=` with the full address list.
 */
async function watchAddresses(ctx: AppContext, addresses: string[]): Promise<void> {
  const id = ctx.config.factory.heliusWebhookId;
  const key = ctx.config.helius.apiKey;
  if (!id || !key) return;
  try {
    const url = `https://api.helius.xyz/v0/webhooks/${encodeURIComponent(id)}?api-key=${encodeURIComponent(key)}`;
    const cur = (await (await fetch(url)).json()) as Record<string, unknown> & {
      accountAddresses?: string[];
    };
    const next = [...new Set([...(cur.accountAddresses ?? []), ...addresses])];
    if (next.length === (cur.accountAddresses ?? []).length) return;
    const body = {
      webhookURL: cur.webhookURL,
      transactionTypes: cur.transactionTypes ?? ['ANY'],
      accountAddresses: next,
      webhookType: cur.webhookType,
      ...(cur.authHeader ? { authHeader: cur.authHeader } : {}),
    };
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error('[factory] helius webhook update', res.status);
  } catch (e) {
    console.error('[factory] helius webhook update failed:', (e as Error).message);
  }
}

// --- Read model ---------------------------------------------------------------

export interface TokenView {
  readonly mint: string;
  readonly pool: string;
  readonly cluster: string;
  readonly name: string;
  readonly ticker: string;
  readonly imageUri: string;
  readonly metadataUri: string;
  readonly creator: { userId: string; alias: string; wallet: string };
  readonly launchedAt: string;
  readonly signature: string;
  /** SOL per whole token (from the pool's sqrt price). */
  readonly priceSol: number | null;
  /** priceSol x 1,000,000,000 supply. */
  readonly marketCapSol: number | null;
  readonly quoteReserveSol: number | null;
  /** Curve progress to graduation, 0..10000. */
  readonly progressBps: number | null;
  readonly migrated: boolean;
  readonly rugged: boolean;
  readonly volume24hSol: number;
  readonly trades24h: number;
  readonly stateAt: string | null;
}

interface TokenRow {
  mint: string;
  pool: string;
  cluster: string;
  name: string;
  ticker: string;
  image_uri: string;
  metadata_uri: string;
  creator_user_id: string;
  creator_wallet: string;
  alias: string | null;
  launched_at: Date;
  signature: string;
  price_lamports_per_token: string | null;
  quote_reserve_lamports: string | null;
  progress_bps: number | null;
  migrated: boolean;
  rug_flagged_at: Date | null;
  state_refreshed_at: Date | null;
  vol_lamports: string;
  trades: number;
}

const TOKEN_SELECT = `
  SELECT t.*, ch.alias,
         COALESCE((SELECT sum(x.lamports) FROM factory_token_trades x
                    WHERE x.mint = t.mint AND x.at > now() - interval '24 hours'), 0)::text AS vol_lamports,
         (SELECT count(*)::int FROM factory_token_trades x
           WHERE x.mint = t.mint AND x.at > now() - interval '24 hours') AS trades
    FROM factory_tokens t LEFT JOIN characters ch ON ch.user_id = t.creator_user_id`;

function toView(r: TokenRow): TokenView {
  const price =
    r.price_lamports_per_token === null ? null : Number(r.price_lamports_per_token) / 1e9;
  return {
    mint: r.mint,
    pool: r.pool,
    cluster: r.cluster,
    name: r.name,
    ticker: r.ticker,
    imageUri: r.image_uri,
    metadataUri: r.metadata_uri,
    creator: { userId: r.creator_user_id, alias: r.alias ?? 'anon', wallet: r.creator_wallet },
    launchedAt: r.launched_at.toISOString(),
    signature: r.signature,
    priceSol: price,
    marketCapSol: price === null ? null : price * TOKEN_SUPPLY,
    quoteReserveSol:
      r.quote_reserve_lamports === null ? null : Number(r.quote_reserve_lamports) / 1e9,
    progressBps: r.progress_bps,
    migrated: r.migrated,
    rugged: r.rug_flagged_at !== null,
    volume24hSol: Number(r.vol_lamports) / 1e9,
    trades24h: r.trades,
    stateAt: r.state_refreshed_at ? r.state_refreshed_at.toISOString() : null,
  };
}

async function saveSnapshot(ctx: AppContext, mint: string, p: PoolSnapshot): Promise<void> {
  await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE factory_tokens SET price_lamports_per_token = $2, quote_reserve_lamports = $3,
              base_reserve = $4, progress_bps = $5, migrated = $6, state_refreshed_at = now()
        WHERE mint = $1`,
      [
        mint,
        Math.round(p.priceSol * 1e9 * 1e6) / 1e6,
        p.quoteReserve,
        p.baseReserve,
        p.progressBps,
        p.isMigrated,
      ],
    ),
  );
}

async function refreshIfStale(ctx: AppContext, rows: TokenRow[], max: number): Promise<void> {
  const stale = rows
    .filter(
      (r) => !r.state_refreshed_at || Date.now() - r.state_refreshed_at.getTime() > STATE_TTL_MS,
    )
    .slice(0, max);
  await Promise.all(
    stale.map(async (r) => {
      try {
        const p = await chainOf(ctx).getPool(r.pool);
        if (p) await saveSnapshot(ctx, r.mint, p);
      } catch {
        // keep the last known numbers
      }
    }),
  );
}

/** One token with fresh on-chain numbers (refreshed at most every 15 s). */
export async function getToken(ctx: AppContext, mint: string): Promise<TokenView | null> {
  const read = (): Promise<{ rows: TokenRow[] }> =>
    ctx.db.withConnection((c) => c.query<TokenRow>(`${TOKEN_SELECT} WHERE t.mint = $1`, [mint]));
  let r = await read();
  if (!r.rows[0]) return null;
  if (
    !r.rows[0].state_refreshed_at ||
    Date.now() - r.rows[0].state_refreshed_at.getTime() > STATE_TTL_MS
  ) {
    await refreshIfStale(ctx, r.rows, 1);
    r = await read();
  }
  return toView(r.rows[0]!);
}

/** Live tokens: newest, trending (24 h volume) or mine. */
export async function listTokens(
  ctx: AppContext,
  userId: string,
  view: 'new' | 'trending' | 'mine',
  limit: number,
): Promise<TokenView[]> {
  const where = view === 'mine' ? `x.creator_user_id = $2` : `x.cluster = $2`;
  const order =
    view === 'trending' ? `x.vol_lamports::numeric DESC, x.launched_at DESC` : `x.launched_at DESC`;
  const param = view === 'mine' ? userId : chainOf(ctx).cluster;
  const q = (): Promise<{ rows: TokenRow[] }> =>
    ctx.db.withConnection((c) =>
      c.query<TokenRow>(
        `SELECT * FROM (${TOKEN_SELECT}) x WHERE ${where} ORDER BY ${order} LIMIT $1`,
        [Math.min(50, limit), param],
      ),
    );
  const first = await q();
  await refreshIfStale(ctx, first.rows, 10);
  return (await q()).rows.map(toView);
}

/** Recent trades for the chart (newest first). */
export async function listTrades(
  ctx: AppContext,
  mint: string,
  limit: number,
): Promise<
  { signature: string; side: string; trader: string; tokens: number; sol: number; at: string }[]
> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      signature: string;
      side: string;
      trader_wallet: string;
      token_amount: string;
      lamports: string;
      at: Date;
    }>(
      `SELECT signature, side, trader_wallet, token_amount, lamports, at FROM factory_token_trades
        WHERE mint = $1 ORDER BY at DESC LIMIT $2`,
      [mint, Math.min(200, limit)],
    ),
  );
  return r.rows.map((x) => ({
    signature: x.signature,
    side: x.side,
    trader: x.trader_wallet,
    tokens: Number(x.token_amount) / 1e6,
    sol: Number(x.lamports) / 1e9,
    at: x.at.toISOString(),
  }));
}

// --- Helius raw webhook: trades and creator sells -------------------------------

/** Constant-time check of the Authorization header Helius sends. */
export function webhookAuthorized(ctx: AppContext, header: string | undefined): boolean {
  const want = ctx.config.factory.heliusWebhookAuth;
  if (!want || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}
export interface RawTx {
  slot?: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: (string | { pubkey: string })[];
      header?: { numRequiredSignatures: number };
    };
  };
}

interface Delta {
  owner: string;
  pre: bigint;
  post: bigint;
}

/**
 * Per-owner change of one mint in a transaction (token accounts grouped by owner).
 * @param tx - The raw transaction.
 * @param mint - The mint.
 * @returns One entry per owner that held or received it.
 */
export function mintDeltas(tx: RawTx, mint: string): Delta[] {
  const by = new Map<string, Delta>();
  const add = (list: RawTokenBalance[] | undefined, which: 'pre' | 'post'): void => {
    for (const b of list ?? []) {
      if (b.mint !== mint || !b.owner) continue;
      const d = by.get(b.owner) ?? { owner: b.owner, pre: 0n, post: 0n };
      d[which] += BigInt(b.uiTokenAmount.amount);
      by.set(b.owner, d);
    }
  };
  add(tx.meta?.preTokenBalances, 'pre');
  add(tx.meta?.postTokenBalances, 'post');
  return [...by.values()];
}

function keyAt(tx: RawTx, i: number): string {
  const k = tx.transaction.message.accountKeys[i];
  return typeof k === 'string' ? k : (k?.pubkey ?? '');
}

/** Lamport change of an owner's own account (the fee added back for the fee payer). */
function solDelta(tx: RawTx, owner: string): bigint {
  const keys = tx.transaction.message.accountKeys.map((_, i) => keyAt(tx, i));
  const i = keys.indexOf(owner);
  if (i < 0 || !tx.meta) return 0n;
  const d = BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
  return i === 0 ? d + BigInt(tx.meta.fee) : d;
}

function signers(tx: RawTx): Set<string> {
  const n = tx.transaction.message.header?.numRequiredSignatures ?? 1;
  return new Set(tx.transaction.message.accountKeys.slice(0, n).map((_, i) => keyAt(tx, i)));
}

export interface WebhookOutcome {
  readonly processed: number;
  readonly trades: number;
  readonly creatorMoves: number;
}

/**
 * Process a Helius raw webhook delivery (an array of transactions). Duplicates
 * are ignored. Trades by signers on our mints are indexed; a creator-wallet
 * drop is a sell (SOL came back: heat + exposé for a big share) or a transfer
 * out (smaller heat). Penalties only.
 */
export async function processFactoryWebhook(
  ctx: AppContext,
  txs: RawTx[],
): Promise<WebhookOutcome> {
  let processed = 0;
  let trades = 0;
  let moves = 0;
  for (const tx of txs) {
    const signature = tx.transaction?.signatures?.[0];
    if (!signature || !tx.meta || tx.meta.err) continue;
    const mints = [
      ...new Set(
        [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])].map(
          (b) => b.mint,
        ),
      ),
    ];
    if (mints.length === 0) continue;
    const tokens = await ctx.db.withConnection((c) =>
      c.query<{
        mint: string;
        ticker: string;
        creator_wallet: string;
        creator_user_id: string;
        rug_flagged_at: Date | null;
        pool: string;
      }>(
        `SELECT mint, ticker, creator_wallet, creator_user_id, rug_flagged_at, pool FROM factory_tokens WHERE mint = ANY($1::text[])`,
        [mints],
      ),
    );
    if (tokens.rows.length === 0) continue;
    const fresh = await ctx.db.withConnection((c) =>
      c.query(`INSERT INTO factory_webhook_events (signature) VALUES ($1) ON CONFLICT DO NOTHING`, [
        signature,
      ]),
    );
    if (!fresh.rowCount) continue;
    processed++;
    const at = tx.blockTime ? new Date(tx.blockTime * 1000) : new Date();
    const who = signers(tx);
    for (const t of tokens.rows) {
      for (const d of mintDeltas(tx, t.mint)) {
        const change = d.post - d.pre;
        if (change === 0n || !who.has(d.owner)) continue;
        const sol = solDelta(tx, d.owner);
        const side = change > 0n ? 'buy' : 'sell';
        await ctx.db.withConnection((c) =>
          c.query(
            `INSERT INTO factory_token_trades (signature, mint, trader_wallet, side, token_amount, lamports, slot, at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
            [
              signature,
              t.mint,
              d.owner,
              side,
              (change < 0n ? -change : change).toString(),
              (sol < 0n ? -sol : sol).toString(),
              tx.slot ?? null,
              at,
            ],
          ),
        );
        trades++;
        if (d.owner === t.creator_wallet && change < 0n) {
          moves += await creatorMove(ctx, t, signature, -change, d.pre, sol > 0n, at);
        }
      }
    }
  }
  return { processed, trades, creatorMoves: moves };
}

async function creatorMove(
  ctx: AppContext,
  t: { mint: string; ticker: string; creator_user_id: string; rug_flagged_at: Date | null },
  signature: string,
  amount: bigint,
  before: bigint,
  solGained: boolean,
  at: Date,
): Promise<number> {
  const shareBps = before > 0n ? Number((amount * 10_000n) / before) : 10_000;
  const kind = solGained ? 'sell' : 'transfer_out';
  const heat = solGained
    ? RUG_HEAT_BASE + Math.round((shareBps * RUG_HEAT_SHARE_BONUS) / 10_000)
    : TRANSFER_OUT_HEAT;
  return runInTransaction(
    async (c) => {
      const ins = await c.query(
        `INSERT INTO factory_creator_moves (signature, mint, kind, token_amount, share_bps, heat_added, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [signature, t.mint, kind, amount.toString(), shareBps, heat, at],
      );
      if (!ins.rowCount) return 0;
      const total = Math.round(
        await addHeat(c, t.creator_user_id, heat, `factory_real_${kind}`, t.mint, at),
      );
      if (kind === 'sell' && shareBps >= RUG_SELL_BPS && !t.rug_flagged_at) {
        await c.query(
          `UPDATE factory_tokens SET rug_flagged_at = $2 WHERE mint = $1 AND rug_flagged_at IS NULL`,
          [t.mint, at],
        );
        const buyers = await c.query<{ n: number }>(
          `SELECT count(DISTINCT trader_wallet)::int AS n FROM factory_token_trades WHERE mint = $1 AND side = 'buy'`,
          [t.mint],
        );
        const al = await c.query<{ alias: string }>(
          `SELECT alias FROM characters WHERE user_id = $1`,
          [t.creator_user_id],
        );
        const alias = al.rows[0]?.alias ?? 'an anonymous dev';
        const pct = Math.round(shareBps / 100);
        await c.query(
          `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta)
         VALUES ($1, $2, $3, $4, 'sleuth', $5) ON CONFLICT DO NOTHING`,
          [
            uuidv7(),
            SLEUTH_USER_ID,
            sleuthPostText(t.mint, {
              alias,
              ticker: t.ticker,
              pct,
              buyers: buyers.rows[0]?.n ?? 0,
              heat: total,
            }),
            at,
            JSON.stringify({
              coinId: t.mint,
              mint: t.mint,
              real: true,
              ticker: t.ticker,
              launcherUserId: t.creator_user_id,
              launcherAlias: alias,
              sellSharePct: pct,
              heat: total,
              signature,
              deepLink: 'venue:launchpad_tower',
            }),
          ],
        );
      }
      return 1;
    },
    {},
    ctx.db,
  );
}
