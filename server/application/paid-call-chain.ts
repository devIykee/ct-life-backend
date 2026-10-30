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
 * Settle and refund (re)create every token account they pay into (fan, creator,
 * treasury) with the idempotent ATA instruction, paid by the settle authority, so a fan
 * who closes their own USDC account cannot make settle fail and then refund the whole
 * deposit after the deadline.
 *
 * The pure pieces (`settleInstructions`, `refundInstructions`, `checkOpenTransaction`,
 * `escrowEventsFromLogs`) are exported for tests; tests swap the whole port with
 * `_setEscrowChainForTests` (no RPC, no keys).
 */
import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
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
  accept(ctx: AppContext, ref: SessionRef): Promise<string>;
  settle(ctx: AppContext, ref: SessionRef & { secondsUsed: bigint }): Promise<string>;
  refund(ctx: AppContext, ref: SessionRef): Promise<string>;
}

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

/**
 * settle, preceded by idempotent creates of every token account it pays into (fan,
 * creator, treasury), all paid by the settle authority.
 */
export function settleInstructions(args: {
  authority: PublicKey;
  cfg: Pick<EscrowConfig, 'usdcMint' | 'treasury'>;
  ref: SessionRef;
  secondsUsed: bigint;
}): TransactionInstruction[] {
  const { fan, creator, session } = keys(args.ref);
  const mint = new PublicKey(args.cfg.usdcMint);
  const treasury = new PublicKey(args.cfg.treasury);
  const fanAta = getAssociatedTokenAddressSync(mint, fan);
  const creatorAta = getAssociatedTokenAddressSync(mint, creator);
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury);
  const ata = (a: PublicKey, owner: PublicKey): TransactionInstruction =>
    createAssociatedTokenAccountIdempotentInstruction(args.authority, a, owner, mint);
  return [
    ata(fanAta, fan),
    ata(creatorAta, creator),
    ata(treasuryAta, treasury),
    buildSettleIx({
      settleAuthority: args.authority,
      fan,
      creator,
      sessionId: args.ref.sessionId,
      secondsUsed: args.secondsUsed,
      vault: sessionVault(session, mint),
      usdcMint: mint,
      creatorUsdcAta: creatorAta,
      fanUsdcAta: fanAta,
      treasuryUsdcAta: treasuryAta,
    }),
  ];
}

/** refund, preceded by an idempotent create of the fan's token account. */
export function refundInstructions(args: {
  authority: PublicKey;
  cfg: Pick<EscrowConfig, 'usdcMint'>;
  ref: SessionRef;
}): TransactionInstruction[] {
  const { fan, creator, session } = keys(args.ref);
  const mint = new PublicKey(args.cfg.usdcMint);
  const fanAta = getAssociatedTokenAddressSync(mint, fan);
  return [
    createAssociatedTokenAccountIdempotentInstruction(args.authority, fanAta, fan, mint),
    buildRefundIx({
      fan,
      creator,
      sessionId: args.ref.sessionId,
      vault: sessionVault(session, mint),
      usdcMint: mint,
      fanUsdcAta: fanAta,
      signer: args.authority,
    }),
  ];
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
    return sendAuthorityTx({
      connection: connection(ctx),
      signer,
      instructions: settleInstructions({
        authority: signer.publicKey,
        cfg,
        ref,
        secondsUsed: ref.secondsUsed,
      }),
    });
  },

  async refund(ctx, ref) {
    await assertDevnetRpc(ctx, 'paidCalls');
    const cfg = await realChain.config(ctx);
    const signer = settleAuthority(ctx);
    return sendAuthorityTx({
      connection: connection(ctx),
      signer,
      instructions: refundInstructions({ authority: signer.publicKey, cfg, ref }),
    });
  },
};
