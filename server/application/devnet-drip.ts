/**
 * Devnet test tokens (unlock WP-C, plan Q6): a small daily SOL drip from an ops
 * treasury, and the facts the client's "Get test tokens" card shows.
 *
 *   GET  /v1/devnet/test-tokens   USDC faucet link + this player's SOL drip status
 *   POST /v1/devnet/drip          send DEVNET_DRIP_LAMPORTS (default 0.02 SOL) once a day
 *
 * Players need devnet SOL for fees (season-pass payments, paid calls, Factory launches)
 * and the public faucet is rate-limited and asks agents not to use it. USDC comes from
 * Circle's faucet (20 USDC per address every 2 h), which the client opens in a browser.
 *
 * Limits: one drip per wallet and per account per UTC day (database UNIQUE), none while
 * the wallet already holds DRIP_BALANCE_CEILING_LAMPORTS, a global daily budget
 * (DEVNET_DRIP_DAILY_CAP_LAMPORTS), and a reserve the treasury never goes below.
 *
 * Safety: devnet only. `assertDevnetRpc` checks the RPC's genesis hash before the
 * first send, so a mis-set RPC URL can never spend mainnet SOL. The ops treasury key
 * (DEVNET_DRIP_KEYPAIR) is a throwaway devnet key that holds only devnet SOL; it is
 * never logged and never used for anything else.
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { AppContext } from './context.js';
import { assertCapabilityOn } from './capabilities.js';
import { assertDevnetRpc, clusterRpc, latestBlockhash } from './chain-rpc.js';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  CapabilityOffError,
  ConflictError,
  NotFoundError,
  RateLimitedError,
  ServerBusyError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { loadKeypair, walletHash } from '../shared/solana/keypair.js';
import { HeliusError } from '../shared/solana/helius.js';
import { getBase58Decoder } from '@solana/kit';

/** Circle's public faucet; the player picks Solana Devnet and pastes their address. */
export const USDC_FAUCET_URL = 'https://faucet.circle.com/';
/** Circle: "20 USDC on testnet every 2 hours, per address, and per blockchain". */
export const USDC_FAUCET_BASE_UNITS = '20000000';
export const USDC_FAUCET_EVERY_HOURS = 2;
/** Circle's devnet USDC mint (developers.circle.com/stablecoins/usdc-contract-addresses). */
export const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** No drip while the wallet already holds this much (0.05 SOL). */
export const DRIP_BALANCE_CEILING_LAMPORTS = 50_000_000n;
/** Bytes to base58 (a transaction signature as the RPC reports it). */
const base58 = getBase58Decoder();

/** The treasury keeps this much for its own fees (0.01 SOL). */
export const DRIP_TREASURY_RESERVE_LAMPORTS = 10_000_000n;

export interface DripSettings {
  /** Path or base58 of the ops treasury keypair; empty = the drip is unconfigured. */
  readonly keypair: string;
  readonly lamports: bigint;
  readonly dailyCapLamports: bigint;
}

function boundedLamports(raw: string | undefined, fallback: bigint, max: bigint): bigint {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`invalid lamports value: ${raw}`);
  const v = BigInt(raw.trim());
  if (v <= 0n || v > max) throw new Error(`lamports value out of range: ${raw}`);
  return v;
}

/**
 * @param env - The process environment.
 * @returns The drip settings (0.02 SOL a drip and 1 SOL a day by default).
 */
export function loadDripSettings(env: NodeJS.ProcessEnv = process.env): DripSettings {
  return {
    keypair: (env.DEVNET_DRIP_KEYPAIR ?? '').trim(),
    // At most 0.1 SOL a drip and 10 SOL a day, whatever the env says.
    lamports: boundedLamports(env.DEVNET_DRIP_LAMPORTS, 20_000_000n, 100_000_000n),
    dailyCapLamports: boundedLamports(
      env.DEVNET_DRIP_DAILY_CAP_LAMPORTS,
      1_000_000_000n,
      10_000_000_000n,
    ),
  };
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

async function walletOf(ctx: AppContext, userId: string): Promise<PublicKey> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ wallet: string }>('SELECT wallet FROM users WHERE id = $1', [userId]),
  );
  const wallet = r.rows[0]?.wallet;
  if (wallet === undefined) throw new NotFoundError({ kind: 'user', id: userId });
  try {
    return new PublicKey(wallet);
  } catch {
    throw new ValidationFailedError({ reason: 'wallet_not_a_pubkey' });
  }
}

async function balanceOf(ctx: AppContext, key: PublicKey): Promise<bigint> {
  const r = await clusterRpc(ctx).rpc<{ value: number }>('getBalance', [
    key.toBase58(),
    { commitment: 'confirmed' },
  ]);
  return BigInt(r.value);
}

export type DripUnavailableReason = 'unconfigured' | 'claimed_today' | 'budget_spent';

export interface TestTokensInfo {
  readonly cluster: 'devnet';
  readonly wallet: string;
  readonly usdc: {
    readonly faucetUrl: string;
    readonly mint: string;
    readonly perRequestBaseUnits: string;
    readonly everyHours: number;
  };
  readonly sol: {
    readonly dripLamports: string;
    readonly available: boolean;
    readonly reason: DripUnavailableReason | null;
    /** When the next drip can be asked for (next 00:00 UTC), or null when available. */
    readonly nextAt: string | null;
  };
}

/**
 * What the "Get test tokens" card shows. Reads only the database (no RPC).
 *
 * @param ctx - The app context.
 * @param userId - The player.
 * @param now - The current time.
 */
export async function testTokensInfo(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<TestTokensInfo> {
  assertCapabilityOn(ctx, 'devnetDrip');
  if (ctx.config.solana.cluster !== 'devnet') {
    throw new CapabilityOffError({ capability: 'devnetDrip', reason: 'devnet_only' });
  }
  const settings = loadDripSettings();
  const wallet = await walletOf(ctx, userId);
  const day = utcDay(now);
  const r = await ctx.db.withConnection((c) =>
    c.query<{ mine: boolean; spent: string }>(
      `SELECT bool_or(user_id = $1 OR wallet_hash = $2) AS mine,
              COALESCE(SUM(lamports), 0)::text AS spent
         FROM devnet_drips WHERE day = $3`,
      [userId, walletHash(wallet.toBase58()), day],
    ),
  );
  const row = r.rows[0];
  let reason: DripUnavailableReason | null = null;
  if (settings.keypair === '') reason = 'unconfigured';
  else if (row?.mine === true) reason = 'claimed_today';
  else if (BigInt(row?.spent ?? '0') + settings.lamports > settings.dailyCapLamports)
    reason = 'budget_spent';
  return {
    cluster: 'devnet',
    wallet: wallet.toBase58(),
    usdc: {
      faucetUrl: USDC_FAUCET_URL,
      mint: USDC_DEVNET_MINT,
      perRequestBaseUnits: USDC_FAUCET_BASE_UNITS,
      everyHours: USDC_FAUCET_EVERY_HOURS,
    },
    sol: {
      dripLamports: settings.lamports.toString(),
      available: reason === null,
      reason,
      nextAt:
        reason === null || reason === 'unconfigured' ? null : nextUtcMidnight(now).toISOString(),
    },
  };
}

export interface DripResult {
  readonly dripId: string;
  readonly signature: string;
  readonly lamports: string;
  readonly wallet: string;
  readonly nextAt: string;
}

/**
 * Send today's drip to the player's wallet. One per wallet and account per UTC day.
 *
 * @param ctx - The app context.
 * @param userId - The player.
 * @param now - The current time.
 * @throws CapabilityOffError when off, off devnet, the RPC is not devnet, the drip has no
 *   key, or the treasury is below its reserve.
 * @throws ConflictError `balance_sufficient` when the wallet already holds 0.05 SOL.
 * @throws RateLimitedError `daily_drip` (already dripped today) or `drip_budget`.
 * @throws ServerBusyError `drip_send_failed` when the transfer provably never reached the
 *   cluster (the slot is freed), or `drip_outcome_unknown` when it may have (the slot is
 *   kept, so it can never be paid twice).
 */
export async function requestDrip(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<DripResult> {
  assertCapabilityOn(ctx, 'devnetDrip');
  const settings = loadDripSettings();
  if (settings.keypair === '') {
    throw new CapabilityOffError({ capability: 'devnetDrip', reason: 'drip_unconfigured' });
  }
  await assertDevnetRpc(ctx, 'devnetDrip');
  const treasury = loadKeypair(settings.keypair).keypair;
  const wallet = await walletOf(ctx, userId);
  const nextAt = nextUtcMidnight(now);
  const retryMs = Math.max(1000, nextAt.getTime() - now.getTime());

  const have = await balanceOf(ctx, wallet);
  if (have >= DRIP_BALANCE_CEILING_LAMPORTS) {
    throw new ConflictError({ reason: 'balance_sufficient', balanceLamports: have.toString() });
  }
  const treasuryHas = await balanceOf(ctx, treasury.publicKey);
  if (treasuryHas < settings.lamports + DRIP_TREASURY_RESERVE_LAMPORTS) {
    throw new CapabilityOffError({ capability: 'devnetDrip', reason: 'treasury_low' });
  }

  const dripId = uuidv7();
  await claimSlot({ dripId, userId, wallet, now, settings, retryMs, nextAt });

  // Sign locally and store the signature BEFORE sending (review L2), so a send whose
  // outcome is unknown can still be looked up and is never paid twice.
  let wire: string;
  let signature: string;
  try {
    const { blockhash, lastValidBlockHeight } = await latestBlockhash(ctx);
    const tx = new Transaction({ feePayer: treasury.publicKey, blockhash, lastValidBlockHeight });
    tx.add(dripInstruction(treasury, wallet, settings.lamports));
    tx.sign(treasury);
    signature = base58.decode(tx.signature!);
    wire = tx.serialize().toString('base64');
    await ctx.db.withConnection((c) =>
      c.query('UPDATE devnet_drips SET signature = $1 WHERE drip_id = $2', [signature, dripId]),
    );
  } catch (e) {
    // Nothing was sent yet: give the day's slot back.
    await releaseSlot(ctx, dripId);
    throw new ServerBusyError(30_000, {
      reason: 'drip_send_failed',
      message: (e as Error).message,
    });
  }

  try {
    await clusterRpc(ctx).rpc<string>('sendTransaction', [
      wire,
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
  } catch (e) {
    const outcome = await sendOutcome(ctx, signature, e);
    if (outcome === 'rejected') {
      await releaseSlot(ctx, dripId);
      throw new ServerBusyError(30_000, {
        reason: 'drip_send_failed',
        message: (e as Error).message,
      });
    }
    if (outcome === 'unknown') {
      // It may still land: keep the slot (and the global budget) and say so.
      throw new ServerBusyError(retryMs, {
        reason: 'drip_outcome_unknown',
        signature,
        nextAt: nextAt.toISOString(),
      });
    }
    // 'landed': the error came after the transfer reached the cluster; answer as sent.
  }
  return {
    dripId,
    signature,
    lamports: settings.lamports.toString(),
    wallet: wallet.toBase58(),
    nextAt: nextAt.toISOString(),
  };
}

async function releaseSlot(ctx: AppContext, dripId: string): Promise<void> {
  await ctx.db.withConnection((c) =>
    c.query('DELETE FROM devnet_drips WHERE drip_id = $1', [dripId]),
  );
}

/**
 * True when the send failed in a way that proves the transfer never reached the
 * cluster: the node answered with a JSON-RPC error object (a failed preflight, a bad
 * signature, an unknown blockhash: the node refuses before forwarding), or the RPC
 * provider refused the HTTP request itself (401, 403, 429). A timeout, a network error
 * or an HTTP 5xx is not proof: the request may have been forwarded.
 * @param e - What `sendTransaction` threw.
 */
export function sendRefusedOutright(e: unknown): boolean {
  if (!(e instanceof HeliusError)) return false;
  if (e.rpcCode !== undefined) return true;
  return e.code === 'UNAUTHORIZED' || e.code === 'RATE_LIMITED';
}

/**
 * What became of a send that threw. The slot is freed only for `rejected`: the RPC
 * refused it outright AND the cluster has no status for the signature. A clean status
 * means it landed; anything else (an ambiguous error, a status with an on-chain error,
 * or the status lookup failing) is `unknown`, which keeps the slot.
 * @param ctx - The app context.
 * @param signature - The drip's signature (base58).
 * @param sendError - What `sendTransaction` threw.
 */
export async function sendOutcome(
  ctx: AppContext,
  signature: string,
  sendError: unknown,
): Promise<'landed' | 'rejected' | 'unknown'> {
  let status: { err: unknown } | null;
  try {
    const r = await clusterRpc(ctx).rpc<{ value: Array<{ err: unknown } | null> }>(
      'getSignatureStatuses',
      [[signature], { searchTransactionHistory: false }],
    );
    status = r.value[0] ?? null;
  } catch {
    return 'unknown';
  }
  if (status !== null) {
    // On chain. With an error the fee was paid but the transfer failed; that is not a
    // provable "never sent" either, so the slot stays.
    return status.err === null || status.err === undefined ? 'landed' : 'unknown';
  }
  return sendRefusedOutright(sendError) ? 'rejected' : 'unknown';
}

/** The transfer the treasury signs. Exported for tests. */
export function dripInstruction(
  treasury: Keypair,
  wallet: PublicKey,
  lamports: bigint,
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: treasury.publicKey,
    toPubkey: wallet,
    lamports,
  });
}

/** Reserve today's slot under the global budget, or throw. */
async function claimSlot(a: {
  dripId: string;
  userId: string;
  wallet: PublicKey;
  now: Date;
  settings: DripSettings;
  retryMs: number;
  nextAt: Date;
}): Promise<void> {
  const day = utcDay(a.now);
  await runInTransaction(async (client) => {
    // One budget check at a time.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('devnet_drip_budget'))`);
    const spent = await client.query<{ s: string }>(
      `SELECT COALESCE(SUM(lamports), 0)::text AS s FROM devnet_drips WHERE day = $1`,
      [day],
    );
    if (BigInt(spent.rows[0]?.s ?? '0') + a.settings.lamports > a.settings.dailyCapLamports) {
      throw new RateLimitedError(a.retryMs, {
        reason: 'drip_budget',
        nextAt: a.nextAt.toISOString(),
      });
    }
    try {
      await client.query(
        `INSERT INTO devnet_drips (drip_id, user_id, wallet_hash, day, lamports)
         VALUES ($1, $2, $3, $4, $5)`,
        [a.dripId, a.userId, walletHash(a.wallet.toBase58()), day, a.settings.lamports.toString()],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new RateLimitedError(a.retryMs, {
          reason: 'daily_drip',
          nextAt: a.nextAt.toISOString(),
        });
      }
      throw e;
    }
  });
}
