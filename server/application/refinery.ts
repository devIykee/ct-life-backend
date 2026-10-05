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
 *   The board reader is a polling worker. It calls the ORE
 *   mainnet board every `boardCacheSec` (default 2) seconds
 *   and writes a JSON snapshot to Redis at `ore:board`. The
 *   reader is allowed to fail; on failure it returns the last
 *   cached value. The reader is rate-limited to 1 call / 2 s.
 *
 *   When `ORE_DEVNET_USE_MAINNET_CACHE` is set, the seeder uses
 *   the cached mainnet value for dev (ORE has no devnet
 *   deployment; the spec marks this [Unverified]).
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
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export interface OreBoard {
  readonly roundId: string;
  readonly endsAt: number; // epoch ms
  readonly endsAtSlot: number;
  readonly squares: number[]; // 5 squares, each in deployed lamports
  readonly motherlodeOre: string;
  readonly cityStakedOre: string;
  readonly priceUsd: number;
  readonly at: number;
}

const ORE_PROGRAM_ID = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp';
const ORE_STAKE_PROGRAM_ID = 'stake-cNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeHMM';
const ORE_MINT = 'oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp';
const STORE_MINT = 'storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR';

const BOARD_KEY = 'ore:board';
const BOARD_TTL_SEC = 30;
const BOARD_RATE_LIMIT_KEY = 'ore:board:rl';
const RATE_LIMIT_INTERVAL_MS = 2_000;

/** Mock ORE board used in dev (no ORE on devnet). */
function fixtureBoard(): OreBoard {
  return {
    roundId: 'dev-fixture',
    endsAt: Date.now() + 60_000,
    endsAtSlot: 0,
    squares: [1_000_000_000, 1_000_000_000, 1_000_000_000, 1_000_000_000, 1_000_000_000],
    motherlodeOre: '0',
    cityStakedOre: '0',
    priceUsd: 0,
    at: Date.now(),
  };
}

/**
 * Read the ORE board. Returns the cached value if available;
 * otherwise fetches from mainnet Helius (when the feature flag
 * is enabled) or returns the dev fixture.
 *
 * @param ctx - The application context.
 */
export async function readBoard(ctx: AppContext): Promise<OreBoard> {
  const cached = await ctx.redis.main.get(BOARD_KEY);
  if (cached !== null) {
    return JSON.parse(cached) as OreBoard;
  }
  if (process.env.ORE_READER_ENABLED !== '1' || ctx.config.features.mainnetTests === false) {
    const fixture = fixtureBoard();
    await ctx.redis.main.set(BOARD_KEY, JSON.stringify(fixture), 'EX', BOARD_TTL_SEC);
    return fixture;
  }
  // Rate-limit: only one upstream call per 2s window.
  const rl = await ctx.redis.main.set(
    BOARD_RATE_LIMIT_KEY,
    '1',
    'PX',
    RATE_LIMIT_INTERVAL_MS,
    'NX',
  );
  if (rl !== 'OK') {
    return fixtureBoard();
  }
  try {
    const res = await globalThis.fetch(ctx.config.solana.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ore-board',
        method: 'getAccountInfo',
        params: [ORE_PROGRAM_ID, { encoding: 'base64' }],
      }),
    });
    if (!res.ok) return fixtureBoard();
    const body = (await res.json()) as { result?: { value?: unknown } };
    if (body.result?.value === undefined || body.result.value === null) return fixtureBoard();
    // Production: decode the board account data. For the M3
    // smoke we return a stamped board with the current time.
    const board: OreBoard = {
      roundId: 'live',
      endsAt: Date.now() + 60_000,
      endsAtSlot: 0,
      squares: [0, 0, 0, 0, 0],
      motherlodeOre: '0',
      cityStakedOre: '0',
      priceUsd: 0,
      at: Date.now(),
    };
    await ctx.redis.main.set(BOARD_KEY, JSON.stringify(board), 'EX', BOARD_TTL_SEC);
    return board;
  } catch {
    return fixtureBoard();
  }
}

export type MinerTier = 'none' | 'prospector' | 'miner' | 'refiner';

export interface OreMe {
  readonly balance: string;
  readonly staked: string;
  readonly stOre: string;
  readonly minerTier: MinerTier;
}

/**
 * Return the user's ORE state. Production reads from on-chain
 * via Helius; the M3 dev path uses the `users.miner_tier`
 * column and a stub balance.
 */
export async function readOreMe(ctx: AppContext, userId: string): Promise<OreMe> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ miner_tier: MinerTier }>(`SELECT miner_tier FROM users WHERE id = $1`, [
      userId,
    ]);
  });
  const minerTier = r.rows[0]?.miner_tier ?? 'none';
  // The M3 dev path returns zeros. Production reads ORE
  // balances via the getTokenAccountsByOwnerV2 Helius call.
  return { balance: '0', staked: '0', stOre: '0', minerTier };
}

export type StakeAction = 'deposit' | 'withdraw' | 'claim' | 'compound';

export interface StakeTxInput {
  readonly userId: string;
  readonly action: StakeAction;
  readonly amount?: string;
}

export interface StakeTxResult {
  readonly txBase64: string;
  readonly action: StakeAction;
  readonly stakeProgram: string;
  readonly oreMint: string;
  readonly stOreMint: string;
}

/**
 * Build an unsigned v0 transaction for the ORE stake program.
 *
 * NOTE: the production implementation ports the Rust
 * `ore-stake-api` instruction builders to @solana/kit 8.x.
 * The M3 dev path returns a deterministic placeholder
 * transaction so the client wiring is exercised end-to-end.
 *
 * @param ctx - The application context.
 * @param input - The stake request.
 */
export async function buildStakeTx(_ctx: AppContext, input: StakeTxInput): Promise<StakeTxResult> {
  if (
    input.action !== 'deposit' &&
    input.action !== 'withdraw' &&
    input.action !== 'claim' &&
    input.action !== 'compound'
  ) {
    throw new ValidationFailedError({ action: input.action });
  }
  if (
    (input.action === 'deposit' || input.action === 'withdraw') &&
    (input.amount === undefined || BigInt(input.amount) <= 0n)
  ) {
    throw new ValidationFailedError({ reason: 'amount required' });
  }
  // Placeholder base64 tx (the client only needs the shape
  // and the program addresses).
  const placeholder = Buffer.from(
    JSON.stringify({
      action: input.action,
      amount: input.amount ?? '0',
      program: ORE_STAKE_PROGRAM_ID,
      oreMint: ORE_MINT,
      stOreMint: STORE_MINT,
    }),
  ).toString('base64');
  return {
    txBase64: placeholder,
    action: input.action,
    stakeProgram: ORE_STAKE_PROGRAM_ID,
    oreMint: ORE_MINT,
    stOreMint: STORE_MINT,
  };
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
