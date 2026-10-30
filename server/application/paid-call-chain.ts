/**
 * The chain side of paid calls (unlock C2): read the ct_escrow Config and Session
 * accounts, build the fan's unsigned `open_session` transaction, verify the fan's
 * reported signature, find out how a closed session was closed, and sign + send the
 * settle authority's `accept`, `settle` and `refund`. Everything here is devnet only.
 *
 * Paid calls run only against an escrow that is (a) the current lib.rs build and
 * (b) initialized with OUR settle authority and Circle's devnet USDC mint. `config`
 * enforces both and answers `503 CAPABILITY_OFF {reason}` otherwise, so a missing
 * `init_config`, the old devnet binary, or a config made with another key can never take
 * a fan's deposit.
 *
 * Settle and refund never depend on the state of an account a player controls. The
 * program accepts ANY USDC token account whose token owner is the fan / creator /
 * treasury (lib.rs Settle and Refund constraints), so before each send the server reads
 * the canonical ATAs and plans a destination for each (`planDestinations`):
 *   - present, owned by the right wallet, not frozen  -> use it (no create, no rent);
 *   - missing                                         -> idempotent ATA create;
 *   - handed to another owner (SetAuthority) or frozen -> a FRESH token account owned by
 *     the right wallet, created in the same transaction (createAccount +
 *     initializeAccount3), so nobody can make settle fail and then refund in full
 *     after the deadline (security review M2). No program change is needed.
 * Every create is rent the settle authority pays; `settle` / `refund` return it so the
 * service can cap it per user (security review M4).
 *
 * The pure pieces (`settleInstructions`, `refundInstructions`, `checkOpenTransaction`,
 * `escrowEventsFromLogs`) are exported for tests; tests swap the whole port with
 * `_setEscrowChainForTests` (no RPC, no keys).
 */
import { createHash } from 'node:crypto';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { AppContext } from './context.js';
import { assertDevnetChain, assertDevnetRpc, clusterRpc } from './chain-rpc.js';
import { CapabilityOffError } from '../shared/domain/errors.js';
import { loadKeypair } from '../shared/solana/keypair.js';
import {
  base58Decode,
  buildAcceptIx,
  buildOpenSessionIx,
  buildRefundIx,
  buildSettleIx,
  configPda,
  CT_ESCROW_PROGRAM_ID,
  decodeCtEscrowEvent,
  decodeEscrowConfig,
  decodeEscrowSession,
  sendAuthorityTx,
  sessionPda,
  sessionVault,
  type DecodedEvent,
  type EscrowConfig,
  type EscrowSession,
} from '../shared/solana/ct-escrow.js';
import { USDC_DEVNET_MINT } from './devnet-drip.js';

/** One call's on-chain identity. */
export interface SessionRef {
  readonly fan: string;
  readonly creator: string;
  readonly sessionId: bigint;
}

/** What `verifyOpen` found for a reported open_session signature. */
export type OpenCheck = 'ok' | 'not_found' | 'failed' | 'mismatch';

/** How a session account that no longer exists was closed. */
export type SessionClosure =
  | {
      kind: 'settled';
      signature: string;
      creatorAmount: bigint;
      fee: bigint;
      refund: bigint;
      minutes: bigint;
    }
  | { kind: 'refunded'; signature: string; refundAmount: bigint };

export interface EscrowChain {
  /** The verified escrow Config (throws 503 CAPABILITY_OFF when unusable). */
  config(ctx: AppContext): Promise<EscrowConfig>;
  /** The Session account, or null when it does not exist (yet, or any more). */
  session(ctx: AppContext, ref: SessionRef): Promise<EscrowSession | null>;
  /** The fan's unsigned v0 open_session transaction, base64. */
  buildOpen(
    ctx: AppContext,
    ref: SessionRef & { ratePerMin: bigint; maxMinutes: number; usdcMint: string },
  ): Promise<string>;
  /** Check a reported signature: confirmed, succeeded, fan-signed open_session of this PDA. */
  verifyOpen(ctx: AppContext, ref: SessionRef, signature: string): Promise<OpenCheck>;
  /** For a closed session: the settle or refund that closed it, or null if not found. */
  closure(ctx: AppContext, ref: SessionRef): Promise<SessionClosure | null>;
  /** Canonical USDC ATA state of each wallet (booking requires 'ok' for fan and creator). */
  usdcAccounts(ctx: AppContext, owners: string[]): Promise<Record<string, TokenAccountState>>;
  /** The settle authority's SOL balance, in lamports. */
  authorityLamports(ctx: AppContext): Promise<bigint>;
  accept(ctx: AppContext, ref: SessionRef): Promise<string>;
  settle(ctx: AppContext, ref: SessionRef & { secondsUsed: bigint }): Promise<AuthoritySend>;
  refund(ctx: AppContext, ref: SessionRef): Promise<AuthoritySend>;
}

/** A settle or refund the authority sent, and the account rent it paid for it. */
export interface AuthoritySend {
  signature: string;
  rentLamports: bigint;
}

/** The canonical ATA of a wallet: usable, missing, or unusable (another owner / frozen). */
export type TokenAccountState = 'ok' | 'missing' | 'unusable';

let override: EscrowChain | null = null;

/** @returns The escrow chain port (the real one unless a test swapped it). */
export function escrowChain(): EscrowChain {
  return override ?? realChain;
}

/** Test-only: replace the chain port (null restores the real one). */
export function _setEscrowChainForTests(chain: EscrowChain | null): void {
  override = chain;
}

let authorityCache: { raw: string; keypair: Keypair } | null = null;

function settleAuthority(ctx: AppContext): Keypair {
  const raw = ctx.config.solana.settleAuthorityKey;
  if (authorityCache?.raw === raw) return authorityCache.keypair;
  let keypair: Keypair;
  try {
    keypair = loadKeypair(raw).keypair;
  } catch {
    throw new CapabilityOffError({ capability: 'paidCalls', reason: 'settle_authority_unusable' });
  }
  authorityCache = { raw, keypair };
  return keypair;
}

async function accountData(ctx: AppContext, key: PublicKey): Promise<Uint8Array | null> {
  const r = await clusterRpc(ctx).rpc<{
    value: { data: [string, string]; owner: string } | null;
  }>('getAccountInfo', [key.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
  if (r.value === null) return null;
  // Escrow accounts are PDAs the program owns; anything else is not ours.
  if (r.value.owner !== CT_ESCROW_PROGRAM_ID.toBase58()) return null;
  return new Uint8Array(Buffer.from(r.value.data[0], 'base64'));
}

function connection(ctx: AppContext): Connection {
  return new Connection(ctx.config.solana.rpcUrl, 'confirmed');
}

function keys(ref: SessionRef): { fan: PublicKey; creator: PublicKey; session: PublicKey } {
  const fan = new PublicKey(ref.fan);
  const creator = new PublicKey(ref.creator);
  return { fan, creator, session: sessionPda(fan, creator, ref.sessionId) };
}

// --- Pure instruction lists -----------------------------------------------------

/** jsonParsed `getMultipleAccounts` value for a token account (null = missing). */
export interface ParsedTokenAccount {
  owner: string;
  data: { parsed?: { info?: { owner?: string; mint?: string; state?: string } } } | unknown;
}

/** Classify a canonical ATA read for `owner` and `mint`. */
export function tokenAccountState(
  acct: ParsedTokenAccount | null,
  owner: string,
  mint: string,
): TokenAccountState {
  if (acct === null) return 'missing';
  const info = (
    acct.data as { parsed?: { info?: { owner?: string; mint?: string; state?: string } } }
  )?.parsed?.info;
  if (acct.owner !== TOKEN_PROGRAM_ID.toBase58() || !info) return 'unusable';
  if (info.owner !== owner || info.mint !== mint || info.state !== 'initialized') return 'unusable';
  return 'ok';
}

/** Where one payout goes, and what (if anything) must be created first. */
interface Destination {
  account: PublicKey;
  instructions: TransactionInstruction[];
  signers: Keypair[];
  rentLamports: bigint;
}

function destination(args: {
  state: TokenAccountState;
  authority: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  rentExemptLamports: bigint;
}): Destination {
  const ata = getAssociatedTokenAddressSync(args.mint, args.owner, true);
  if (args.state === 'ok') return { account: ata, instructions: [], signers: [], rentLamports: 0n };
  if (args.state === 'missing') {
    return {
      account: ata,
      instructions: [
        createAssociatedTokenAccountIdempotentInstruction(
          args.authority,
          ata,
          args.owner,
          args.mint,
        ),
      ],
      signers: [],
      rentLamports: args.rentExemptLamports,
    };
  }
  // The ATA was handed to someone else or frozen: a fresh account the owner holds.
  const fresh = Keypair.generate();
  return {
    account: fresh.publicKey,
    instructions: [
      SystemProgram.createAccount({
        fromPubkey: args.authority,
        newAccountPubkey: fresh.publicKey,
        lamports: Number(args.rentExemptLamports),
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(fresh.publicKey, args.mint, args.owner),
    ],
    signers: [fresh],
    rentLamports: args.rentExemptLamports,
  };
}

/** A planned authority transaction. */
export interface PlannedTx {
  instructions: TransactionInstruction[];
  extraSigners: Keypair[];
  rentLamports: bigint;
}

/**
 * settle, with each payout account planned from its current state (see the header):
 * nothing is created for a usable account, so repeated calls cost no rent.
 */
export function settleInstructions(args: {
  authority: PublicKey;
  cfg: Pick<EscrowConfig, 'usdcMint' | 'treasury'>;
  ref: SessionRef;
  secondsUsed: bigint;
  states: { fan: TokenAccountState; creator: TokenAccountState; treasury: TokenAccountState };
  rentExemptLamports: bigint;
}): PlannedTx {
  const { fan, creator, session } = keys(args.ref);
  const mint = new PublicKey(args.cfg.usdcMint);
  const treasury = new PublicKey(args.cfg.treasury);
  const base = { authority: args.authority, mint, rentExemptLamports: args.rentExemptLamports };
  const f = destination({ ...base, state: args.states.fan, owner: fan });
  const c = destination({ ...base, state: args.states.creator, owner: creator });
  const t = destination({ ...base, state: args.states.treasury, owner: treasury });
  return {
    instructions: [
      ...f.instructions,
      ...c.instructions,
      ...t.instructions,
      buildSettleIx({
        settleAuthority: args.authority,
        fan,
        creator,
        sessionId: args.ref.sessionId,
        secondsUsed: args.secondsUsed,
        vault: sessionVault(session, mint),
        usdcMint: mint,
        creatorUsdcAta: c.account,
        fanUsdcAta: f.account,
        treasuryUsdcAta: t.account,
      }),
    ],
    extraSigners: [...f.signers, ...c.signers, ...t.signers],
    rentLamports: f.rentLamports + c.rentLamports + t.rentLamports,
  };
}

/** refund, with the fan's payout account planned from its current state. */
export function refundInstructions(args: {
  authority: PublicKey;
  cfg: Pick<EscrowConfig, 'usdcMint'>;
  ref: SessionRef;
  fanState: TokenAccountState;
  rentExemptLamports: bigint;
}): PlannedTx {
  const { fan, creator, session } = keys(args.ref);
  const mint = new PublicKey(args.cfg.usdcMint);
  const f = destination({
    authority: args.authority,
    mint,
    rentExemptLamports: args.rentExemptLamports,
    state: args.fanState,
    owner: fan,
  });
  return {
    instructions: [
      ...f.instructions,
      buildRefundIx({
        fan,
        creator,
        sessionId: args.ref.sessionId,
        vault: sessionVault(session, mint),
        usdcMint: mint,
        fanUsdcAta: f.account,
        signer: args.authority,
      }),
    ],
    extraSigners: f.signers,
    rentLamports: f.rentLamports,
  };
}

// --- Pure verification ----------------------------------------------------------

const OPEN_SESSION_DISC = createHash('sha256')
  .update('global:open_session')
  .digest()
  .subarray(0, 8);

/** The parts of a `getTransaction` (encoding `json`) result the checks read. */
export interface RpcTx {
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
  } | null;
  transaction: {
    message: {
      accountKeys: string[];
      header: { numRequiredSignatures: number };
      instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }>;
    };
  };
}

/**
 * Is `tx` a successful open_session of `ref`'s Session PDA, signed by the fan?
 * Only top-level instructions count (the server built a single-instruction tx).
 */
export function checkOpenTransaction(tx: RpcTx | null, ref: SessionRef): OpenCheck {
  if (tx === null) return 'not_found';
  if (tx.meta === null || tx.meta.err !== null) return 'failed';
  const msg = tx.transaction.message;
  const all = [
    ...msg.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const signers = msg.accountKeys.slice(0, msg.header.numRequiredSignatures);
  if (!signers.includes(ref.fan)) return 'mismatch';
  const pda = keys(ref).session.toBase58();
  const program = CT_ESCROW_PROGRAM_ID.toBase58();
  const opens = msg.instructions.some((ix) => {
    if (all[ix.programIdIndex] !== program) return false;
    let data: Uint8Array;
    try {
      data = base58Decode(ix.data);
    } catch {
      return false;
    }
    return (
      data.byteLength >= 8 &&
      Buffer.from(data.subarray(0, 8)).equals(OPEN_SESSION_DISC) &&
      all[ix.accounts[0] ?? -1] === pda
    );
  });
  return opens ? 'ok' : 'mismatch';
}

/**
 * ct_escrow events from a transaction's logs. Only `Program data:` lines emitted while
 * ct_escrow is the executing program count, so another program cannot forge one.
 */
export function escrowEventsFromLogs(logs: readonly string[]): DecodedEvent[] {
  const program = CT_ESCROW_PROGRAM_ID.toBase58();
  const stack: string[] = [];
  const out: DecodedEvent[] = [];
  for (const line of logs) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) {
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \w+ (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (line.startsWith('Program data: ') && stack[stack.length - 1] === program) {
      const ev = decodeCtEscrowEvent(line.slice('Program data: '.length).trim());
      if (ev) out.push(ev);
    }
  }
  return out;
}

/**
 * The closure among `txs` (newest first, each with its signature) for `sessionPda`:
 * the first successful transaction that emitted SessionSettled or SessionRefunded for it.
 */
export function classifyClosure(
  txs: ReadonlyArray<{ signature: string; tx: RpcTx | null }>,
  sessionPdaB58: string,
): SessionClosure | null {
  for (const { signature, tx } of txs) {
    if (!tx || !tx.meta || tx.meta.err !== null) continue;
    for (const ev of escrowEventsFromLogs(tx.meta.logMessages ?? [])) {
      if (ev.kind === 'settled' && ev.session === sessionPdaB58) {
        return {
          kind: 'settled',
          signature,
          creatorAmount: ev.creatorAmount,
          fee: ev.fee,
          refund: ev.refund,
          minutes: ev.minutes,
        };
      }
      if (ev.kind === 'refunded' && ev.session === sessionPdaB58) {
        return { kind: 'refunded', signature, refundAmount: ev.refundAmount };
      }
    }
  }
  return null;
}

async function getTx(ctx: AppContext, signature: string): Promise<RpcTx | null> {
  return clusterRpc(ctx).rpc<RpcTx | null>('getTransaction', [
    signature,
    { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
}

async function readUsdcAccounts(
  ctx: AppContext,
  owners: string[],
): Promise<Record<string, TokenAccountState>> {
  const mint = new PublicKey(USDC_DEVNET_MINT);
  const atas = owners.map((o) => getAssociatedTokenAddressSync(mint, new PublicKey(o), true));
  const r = await clusterRpc(ctx).rpc<{ value: Array<ParsedTokenAccount | null> }>(
    'getMultipleAccounts',
    [atas.map((a) => a.toBase58()), { encoding: 'jsonParsed', commitment: 'confirmed' }],
  );
  const out: Record<string, TokenAccountState> = {};
  owners.forEach((o, i) => {
    out[o] = tokenAccountState(r.value[i] ?? null, o, USDC_DEVNET_MINT);
  });
  return out;
}

async function rentExempt(ctx: AppContext): Promise<bigint> {
  const v = await clusterRpc(ctx).rpc<number>('getMinimumBalanceForRentExemption', [ACCOUNT_SIZE]);
  return BigInt(v);
}

let configCache: { at: number; value: EscrowConfig } | null = null;
const CONFIG_TTL_MS = 60_000;

const realChain: EscrowChain = {
  async config(ctx) {
    assertDevnetChain(ctx, 'paidCalls');
    if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache.value;
    const data = await accountData(ctx, configPda());
    if (data === null) {
      throw new CapabilityOffError({ capability: 'paidCalls', reason: 'escrow_not_initialized' });
    }
    const cfg = decodeEscrowConfig(data);
    if (cfg === null) {
      // The old devnet binary writes a 107-byte Config this build cannot use.
      throw new CapabilityOffError({ capability: 'paidCalls', reason: 'escrow_wrong_version' });
    }
    if (
      cfg.settleAuthority !== settleAuthority(ctx).publicKey.toBase58() ||
      cfg.usdcMint !== USDC_DEVNET_MINT
    ) {
      throw new CapabilityOffError({ capability: 'paidCalls', reason: 'escrow_config_mismatch' });
    }
    configCache = { at: Date.now(), value: cfg };
    return cfg;
  },

  async session(ctx, ref) {
    const data = await accountData(ctx, keys(ref).session);
    return data === null ? null : decodeEscrowSession(data);
  },

  async buildOpen(ctx, ref) {
    assertDevnetChain(ctx, 'paidCalls');
    const { fan, creator } = keys(ref);
    const usdcMint = new PublicKey(ref.usdcMint);
    const ix = buildOpenSessionIx({
      fan,
      fanUsdcAta: getAssociatedTokenAddressSync(usdcMint, fan),
      creator,
      usdcMint,
      sessionId: ref.sessionId,
      rateBaseUnitsPerMin: ref.ratePerMin,
      maxMinutes: ref.maxMinutes,
      feeBps: 0,
    });
    const { blockhash } = await connection(ctx).getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: fan,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  },

  async verifyOpen(ctx, ref, signature) {
    assertDevnetChain(ctx, 'paidCalls');
    return checkOpenTransaction(await getTx(ctx, signature), ref);
  },

  async closure(ctx, ref) {
    const pda = keys(ref).session.toBase58();
    const sigs = await clusterRpc(ctx).rpc<Array<{ signature: string; err: unknown }>>(
      'getSignaturesForAddress',
      [pda, { commitment: 'confirmed', limit: 20 }],
    );
    const txs: Array<{ signature: string; tx: RpcTx | null }> = [];
    for (const s of sigs ?? []) {
      if (s.err !== null) continue;
      txs.push({ signature: s.signature, tx: await getTx(ctx, s.signature) });
    }
    return classifyClosure(txs, pda);
  },

  async usdcAccounts(ctx, owners) {
    return readUsdcAccounts(ctx, owners);
  },

  async authorityLamports(ctx) {
    const r = await clusterRpc(ctx).rpc<{ value: number }>('getBalance', [
      settleAuthority(ctx).publicKey.toBase58(),
      { commitment: 'confirmed' },
    ]);
    return BigInt(r.value);
  },

  async accept(ctx, ref) {
    await assertDevnetRpc(ctx, 'paidCalls');
    const signer = settleAuthority(ctx);
    const { fan, creator } = keys(ref);
    return sendAuthorityTx({
      connection: connection(ctx),
      signer,
      instructions: [
        buildAcceptIx({
          settleAuthority: signer.publicKey,
          fan,
          creator,
          sessionId: ref.sessionId,
        }),
      ],
    });
  },

  async settle(ctx, ref) {
    await assertDevnetRpc(ctx, 'paidCalls');
    const cfg = await realChain.config(ctx);
    const signer = settleAuthority(ctx);
    const states = await readUsdcAccounts(ctx, [ref.fan, ref.creator, cfg.treasury]);
    const plan = settleInstructions({
      authority: signer.publicKey,
      cfg,
      ref,
      secondsUsed: ref.secondsUsed,
      states: {
        fan: states[ref.fan]!,
        creator: states[ref.creator]!,
        treasury: states[cfg.treasury]!,
      },
      rentExemptLamports: await rentExempt(ctx),
    });
    const signature = await sendAuthorityTx({
      connection: connection(ctx),
      signer,
      instructions: plan.instructions,
      extraSigners: plan.extraSigners,
    });
    return { signature, rentLamports: plan.rentLamports };
  },

  async refund(ctx, ref) {
    await assertDevnetRpc(ctx, 'paidCalls');
    const cfg = await realChain.config(ctx);
    const signer = settleAuthority(ctx);
    const states = await readUsdcAccounts(ctx, [ref.fan]);
    const plan = refundInstructions({
      authority: signer.publicKey,
      cfg,
      ref,
      fanState: states[ref.fan]!,
      rentExemptLamports: await rentExempt(ctx),
    });
    const signature = await sendAuthorityTx({
      connection: connection(ctx),
      signer,
      instructions: plan.instructions,
      extraSigners: plan.extraSigners,
    });
    return { signature, rentLamports: plan.rentLamports };
  },
};
