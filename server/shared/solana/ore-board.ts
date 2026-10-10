/**
 * ORE v3 board reader (mainnet, read-only).
 *
 * ORE has no devnet deployment, so the board always comes from
 * mainnet. Three accounts make up the live board, all owned by
 * `oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv`. Each is a steel
 * account: an 8-byte discriminator (u8 + 7 pad) then the
 * little-endian `#[repr(C)]` struct. Layouts are from
 * regolith-labs/ore `api/src/state/{board,round,treasury}.rs` and
 * were checked against mainnet on 2026-10-10 (fixture in
 * `fixtures/ore-mainnet.json`).
 *
 *   Board    PDA ["board"]                 disc 105
 *     round_id u64 @8, start_slot u64 @16, end_slot u64 @24
 *   Round    PDA ["round", round_id u64le] disc 109
 *     id u64 @8, deployed [u64; 25] @16  (lamports per square)
 *   Treasury PDA ["treasury"]              disc 104
 *     motherlode u64 @8                   (ORE base units, 11 dp)
 *
 * Nothing here signs or sends a transaction.
 */
import { PublicKey } from '@solana/web3.js';

export const ORE_PROGRAM_ID = new PublicKey('oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv');

const DISC_TREASURY = 104;
const DISC_BOARD = 105;
const DISC_ROUND = 109;
export const ORE_SQUARES = 25;
/** Solana's target slot time; used to turn a slot gap into a wall-clock end. */
const MS_PER_SLOT = 400;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const RPC_TIMEOUT_MS = 3_000;

export const BOARD_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from('board')],
  ORE_PROGRAM_ID,
)[0];
export const TREASURY_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from('treasury')],
  ORE_PROGRAM_ID,
)[0];

/** The Round PDA for a round id. */
export function roundPda(roundId: bigint): PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(roundId);
  return PublicKey.findProgramAddressSync([Buffer.from('round'), id], ORE_PROGRAM_ID)[0];
}

export interface DecodedBoard {
  readonly roundId: bigint;
  readonly startSlot: bigint;
  readonly endSlot: bigint;
}

export interface DecodedRound {
  readonly id: bigint;
  readonly deployed: readonly bigint[];
}

/** Thrown when an account is missing or does not have the expected layout. */
export class OreDecodeError extends Error {
  /** @param message - What did not match. */
  constructor(message: string) {
    super(message);
    this.name = 'OreDecodeError';
  }
}

/** Check length and discriminator before decoding. */
function expect(buf: Buffer, disc: number, minLen: number, what: string): void {
  if (buf.length < minLen) throw new OreDecodeError(`${what}: ${buf.length} bytes < ${minLen}`);
  if (buf[0] !== disc) throw new OreDecodeError(`${what}: discriminator ${buf[0]} != ${disc}`);
}

/** Decode the Board singleton. */
export function decodeBoard(buf: Buffer): DecodedBoard {
  expect(buf, DISC_BOARD, 32, 'board');
  return {
    roundId: buf.readBigUInt64LE(8),
    startSlot: buf.readBigUInt64LE(16),
    endSlot: buf.readBigUInt64LE(24),
  };
}

/** Decode a Round; only the fields the board needs. */
export function decodeRound(buf: Buffer): DecodedRound {
  expect(buf, DISC_ROUND, 16 + ORE_SQUARES * 8, 'round');
  const deployed: bigint[] = [];
  for (let i = 0; i < ORE_SQUARES; i++) deployed.push(buf.readBigUInt64LE(16 + i * 8));
  return { id: buf.readBigUInt64LE(8), deployed };
}

/** Decode the Treasury's motherlode pool (ORE base units). */
export function decodeTreasuryMotherlode(buf: Buffer): bigint {
  expect(buf, DISC_TREASURY, 16, 'treasury');
  return buf.readBigUInt64LE(8);
}

export interface LiveOreBoard {
  readonly roundId: number;
  readonly endsAt: string;
  readonly endsAtSlot: number;
  readonly squares: Array<{ deployedLamports: string }>;
  readonly motherlodeOre: string;
}

/**
 * Turn decoded accounts into the contract board. `end_slot` is
 * u64::MAX while a round waits for its first deploy; the round has
 * no end yet, so `endsAt` is `now` and `endsAtSlot` is 0.
 */
export function toLiveBoard(
  board: DecodedBoard,
  round: DecodedRound,
  motherlode: bigint,
  currentSlot: number,
  nowMs: number,
): LiveOreBoard {
  if (round.id !== board.roundId) {
    throw new OreDecodeError(`round ${round.id} does not match board round ${board.roundId}`);
  }
  const open = board.endSlot !== U64_MAX;
  const slotsLeft = open ? Math.max(0, Number(board.endSlot) - currentSlot) : 0;
  return {
    roundId: Number(board.roundId),
    endsAt: new Date(nowMs + slotsLeft * MS_PER_SLOT).toISOString(),
    endsAtSlot: open ? Number(board.endSlot) : 0,
    squares: round.deployed.map((d) => ({ deployedLamports: d.toString() })),
    motherlodeOre: motherlode.toString(),
  };
}

interface RpcAccount {
  data: [string, string];
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await globalThis.fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'ore-board', method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new OreDecodeError(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.result === undefined) {
    throw new OreDecodeError(`${method}: ${body.error?.message ?? 'no result'}`);
  }
  return body.result;
}

function data(acc: RpcAccount | null, what: string): Buffer {
  if (acc === null) throw new OreDecodeError(`${what} account not found`);
  return Buffer.from(acc.data[0], 'base64');
}

/**
 * Read the live board from a mainnet RPC: Board + Treasury in one
 * call, then the current Round. Two RPC calls, each with a timeout.
 */
export async function fetchLiveOreBoard(rpcUrl: string, nowMs: number): Promise<LiveOreBoard> {
  const multi = await rpc<{ context: { slot: number }; value: Array<RpcAccount | null> }>(
    rpcUrl,
    'getMultipleAccounts',
    [[BOARD_PDA.toBase58(), TREASURY_PDA.toBase58()], { encoding: 'base64' }],
  );
  const board = decodeBoard(data(multi.value[0] ?? null, 'board'));
  const motherlode = decodeTreasuryMotherlode(data(multi.value[1] ?? null, 'treasury'));
  const roundRes = await rpc<{ value: RpcAccount | null }>(rpcUrl, 'getAccountInfo', [
    roundPda(board.roundId).toBase58(),
    { encoding: 'base64' },
  ]);
  const round = decodeRound(data(roundRes.value, 'round'));
  return toLiveBoard(board, round, motherlode, multi.context.slot, nowMs);
}

/**
 * Sum a wallet's SPL balance for one mint (base units). Read-only
 * `getTokenAccountsByOwner`; zero when the wallet holds none.
 */
export async function fetchTokenBalance(
  rpcUrl: string,
  owner: string,
  mint: string,
): Promise<bigint> {
  const r = await rpc<{
    value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }>;
  }>(rpcUrl, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
  return r.value.reduce(
    (sum, a) => sum + BigInt(a.account.data.parsed.info.tokenAmount.amount),
    0n,
  );
}
