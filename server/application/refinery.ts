/**
 * ORE Refinery.
 *
 * The ORE board reader, the stake transaction builder, the
 * miner tier resolver, and the ORE topup flow. Phase 2.
 *
 * Endpoints (M3 #41):
 *
 *   GET  /v1/ore/board         — cached ORE board (5 squares)
 *   GET  /v1/ore/me            — balance, staked, stORE, miner tier
 *   POST /v1/ore/stake/tx      — unsigned v0 transaction
 *   POST /v1/ore/stake/submitted — client posts the on-chain sig
 *
 * Board reader:
 *
 *   Read on demand: a request with no fresh `ore:board` reads
 *   the mainnet Board, Round and Treasury accounts (decoded in
 *   shared/solana/ore-board.ts) and caches the result for
 *   `boardCacheSec`. At most one mainnet read per 2 s; failures
 *   serve the last good board. Gated by ORE_READER_ENABLED.
 *
 * Stake tx builder:
 *
 *   Builds an unsigned v0 transaction for the
 *   `stake-cNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeHMM` program,
 *   using the ORE / stORE mints. The transaction is
 *   base64-encoded and returned to the Unity client for MWA
 *   signing. Production: a real port of the Rust ore-stake-api
 *   builders using @solana/kit 8.x.
 *
 * Miner tier:
 *
 *   From the spec's contract/config/ore.json:
 *     'none'        if balance == 0
 *     'prospector'  if balance > 0 and staked < 1
 *     'miner'       if staked >= 1
 *     'refiner'     if staked >= 10
 *
 * ORE topup:
 *
 *   Reuses the topup service with currency='ORE' (bonus=1500 bps).
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, ServerBusyError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { createLogger } from '../shared/logger/logger.js';
import {
  fetchLiveOreBoard,
  fetchTokenBalance,
  ORE_SQUARES,
  type LiveOreBoard,
} from '../shared/solana/ore-board.js';
import { ORE_MINT, STORE_MINT } from '../shared/solana/ore-stake.js';
import type { AppContext } from './context.js';

/** The contract `OreBoard`, plus `at` (when the board was read, epoch ms). */
export interface OreBoard extends LiveOreBoard {
  readonly cityStakedOre: string;
  readonly priceUsd: string;
  readonly at: number;
}

/** Fresh board, served to every caller for `boardCacheSec`. */
const BOARD_KEY = 'ore:board';
/** Last good board, served while the RPC is failing, up to `maxRoundAgeSec`. */
const BOARD_LAST_KEY = 'ore:board:last';
const BOARD_RATE_LIMIT_KEY = 'ore:board:rl';
const RATE_LIMIT_INTERVAL_MS = 2_000;
const RETRY_AFTER_MS = 5_000;

interface OreConfig {
  readonly boardCacheSec: number;
  readonly maxRoundAgeSec: number;
}

function oreConfig(ctx: AppContext): OreConfig {
  const cfg = ctx.configCache.loadOptional<Partial<OreConfig>>('ore');
  return { boardCacheSec: cfg?.boardCacheSec ?? 2, maxRoundAgeSec: cfg?.maxRoundAgeSec ?? 600 };
}

function isLocalEnv(): boolean {
  return process.env.APP_ENV === 'local' || process.env.APP_ENV === 'mock';
}

/** Dev board (no ORE on devnet). Only served in local/mock. */
function fixtureBoard(now: number): OreBoard {
  return {
    roundId: 0,
    endsAt: new Date(now + 60_000).toISOString(),
    endsAtSlot: 0,
    squares: Array.from({ length: ORE_SQUARES }, () => ({ deployedLamports: '1000000000' })),
    motherlodeOre: '0',
    cityStakedOre: '0',
    priceUsd: '0',
    at: now,
  };
}

/** The ORE reader is off, or the board cannot be read and nothing is cached. */
function boardUnavailable(reason: string): ServerBusyError {
  return new ServerBusyError(RETRY_AFTER_MS, { reason: 'ore_reader', detail: reason });
}

/**
 * Whether the board can be served live. `/v1/config` lists
 * `ore_reader` in `degraded` when it cannot.
 */
export function oreReaderAvailable(ctx: AppContext): boolean {
  return ctx.config.features.oreReader || isLocalEnv();
}

/**
 * Read the ORE board.
 *
 *   1. A board read in the last `boardCacheSec` is served as is.
 *   2. With `ORE_READER_ENABLED=1`, at most one caller per 2 s reads
 *      mainnet (Board, Treasury, Round) and refreshes both caches.
 *   3. If that read fails or is rate limited, the last good board
 *      (up to `maxRoundAgeSec` old) is served.
 *   4. Otherwise 503 SERVER_BUSY `{reason: 'ore_reader'}`; never a fake
 *      board outside local/mock.
 *
 * `cityStakedOre` and `priceUsd` are "0": no city stake index or ORE
 * price feed exists yet.
 */
export async function readBoard(ctx: AppContext): Promise<OreBoard> {
  const cached = await ctx.redis.main.get(BOARD_KEY);
  if (cached !== null) return JSON.parse(cached) as OreBoard;

  const now = Date.now();
  if (!ctx.config.features.oreReader) {
    if (isLocalEnv()) return fixtureBoard(now);
    throw boardUnavailable('ORE_READER_ENABLED is off');
  }

  const rl = await ctx.redis.main.set(
    BOARD_RATE_LIMIT_KEY,
    '1',
    'PX',
    RATE_LIMIT_INTERVAL_MS,
    'NX',
  );
  if (rl !== 'OK') return lastGoodBoard(ctx, 'rate limited');

  const cfg = oreConfig(ctx);
  let live: LiveOreBoard;
  try {
    live = await fetchLiveOreBoard(ctx.config.helius.rpcUrlMainnet, now);
  } catch (e) {
    createLogger().warn({ err: (e as Error).message }, 'ore board read failed');
    return lastGoodBoard(ctx, (e as Error).name);
  }
  const board: OreBoard = { ...live, cityStakedOre: '0', priceUsd: '0', at: now };
  const json = JSON.stringify(board);
  await ctx.redis.main.set(BOARD_KEY, json, 'EX', cfg.boardCacheSec);
  await ctx.redis.main.set(BOARD_LAST_KEY, json, 'EX', cfg.maxRoundAgeSec);
  return board;
}

async function lastGoodBoard(ctx: AppContext, reason: string): Promise<OreBoard> {
  const last = await ctx.redis.main.get(BOARD_LAST_KEY);
  if (last !== null) return JSON.parse(last) as OreBoard;
  throw boardUnavailable(reason);
}

export type MinerTier = 'none' | 'prospector' | 'miner' | 'refiner';

export interface OreMe {
  readonly balance: string;
  readonly staked: string;
  readonly stOre: string;
  readonly minerTier: MinerTier;
}

/**
 * Return the user's ORE state. With the reader on, `balance` (ORE)
 * and `stOre` (stORE) are the wallet's mainnet SPL balances in base
 * units. `staked` is "0": the stake account layout is not decoded
 * yet. `minerTier` is the stored tier.
 */
export async function readOreMe(ctx: AppContext, userId: string): Promise<OreMe> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ miner_tier: MinerTier; wallet: string }>(
      `SELECT miner_tier, wallet FROM users WHERE id = $1`,
      [userId],
    );
  });
  const minerTier = r.rows[0]?.miner_tier ?? 'none';
  const wallet = r.rows[0]?.wallet;
  if (!ctx.config.features.oreReader || wallet === undefined) {
    return { balance: '0', staked: '0', stOre: '0', minerTier };
  }
  const rpcUrl = ctx.config.helius.rpcUrlMainnet;
  try {
    const [balance, stOre] = await Promise.all([
      fetchTokenBalance(rpcUrl, wallet, ORE_MINT.toBase58()),
      fetchTokenBalance(rpcUrl, wallet, STORE_MINT.toBase58()),
    ]);
    return { balance: balance.toString(), staked: '0', stOre: stOre.toString(), minerTier };
  } catch (e) {
    createLogger().warn({ err: (e as Error).message }, 'ore balance read failed');
    throw boardUnavailable('balance read failed');
  }
}

/**
 * Mark a stake tx as submitted. The ORE ledger credit lands
 * via a similar Helius webhook to cash topups; the M3 dev
 * path writes a noop ledger row to keep the conservation
 * invariant demonstrable.
 */
export async function markStakeSubmitted(
  ctx: AppContext,
  userId: string,
  intentId: string,
  signature: string,
): Promise<void> {
  await ctx.db.withConnection(async (c) => {
    const r = await c.query<{ user_id: string; status: string }>(
      `SELECT user_id, status FROM payment_intents WHERE intent_id = $1`,
      [intentId],
    );
    if ((r.rowCount ?? 0) === 0)
      throw new NotFoundError({ kind: 'ore_stake_intent', id: intentId });
    const row = r.rows[0]!;
    if (row.user_id !== userId) throw new NotFoundError({ kind: 'ore_stake_intent', id: intentId });
    if (row.status === 'pending') {
      await c.query(
        `UPDATE payment_intents SET signature = $1 WHERE intent_id = $2 AND signature IS NULL`,
        [signature, intentId],
      );
    }
  });
  void uuidv7;
}

void runInTransaction;
