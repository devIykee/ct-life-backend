/**
 * The chain side of paid calls (unlock C2): read the ct_escrow Config and Session
 * accounts, build the fan's unsigned `open_session` transaction, and sign + send the
 * settle authority's `accept`, `settle` and `refund`. Everything here is devnet only.
 *
 * Paid calls run only against an escrow that is (a) the current lib.rs build and
 * (b) initialized with OUR settle authority and Circle's devnet USDC mint. `escrowConfig`
 * enforces both and answers `503 CAPABILITY_OFF {reason}` otherwise, so a missing
 * `init_config`, the old devnet binary, or a config made with another key can never take
 * a fan's deposit.
 *
 * Tests swap the whole port with `_setEscrowChainForTests` (no RPC, no keys).
 */
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
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
  buildAcceptIx,
  buildOpenSessionIx,
  buildRefundIx,
  buildSettleIx,
  configPda,
  CT_ESCROW_PROGRAM_ID,
  decodeEscrowConfig,
  decodeEscrowSession,
  sendAuthorityTx,
  sessionPda,
  sessionVault,
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

export interface EscrowChain {
  /** The verified escrow Config (throws 503 CAPABILITY_OFF when unusable). */
  config(ctx: AppContext): Promise<EscrowConfig>;
  /** The Session account, or null when it does not exist (yet). */
  session(ctx: AppContext, ref: SessionRef): Promise<EscrowSession | null>;
  /** The fan's unsigned v0 open_session transaction, base64. */
  buildOpen(
    ctx: AppContext,
    ref: SessionRef & { ratePerMin: bigint; maxMinutes: number; usdcMint: string },
  ): Promise<string>;
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
    const { fan, creator, session } = keys(ref);
    const usdcMint = new PublicKey(cfg.usdcMint);
    const treasury = new PublicKey(cfg.treasury);
    const creatorAta = getAssociatedTokenAddressSync(usdcMint, creator);
    const treasuryAta = getAssociatedTokenAddressSync(usdcMint, treasury);
    return sendAuthorityTx({
      connection: connection(ctx),
      signer,
      instructions: [
        // settle needs both token accounts to exist; the authority pays for them.
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          creatorAta,
          creator,
          usdcMint,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          signer.publicKey,
          treasuryAta,
          treasury,
          usdcMint,
        ),
        buildSettleIx({
          settleAuthority: signer.publicKey,
          fan,
          creator,
          sessionId: ref.sessionId,
          secondsUsed: ref.secondsUsed,
          vault: sessionVault(session, usdcMint),
          usdcMint,
          creatorUsdcAta: creatorAta,
          fanUsdcAta: getAssociatedTokenAddressSync(usdcMint, fan),
          treasuryUsdcAta: treasuryAta,
        }),
      ],
    });
  },

  async refund(ctx, ref) {
    await assertDevnetRpc(ctx, 'paidCalls');
    const cfg = await realChain.config(ctx);
    const signer = settleAuthority(ctx);
    const { fan, creator, session } = keys(ref);
    const usdcMint = new PublicKey(cfg.usdcMint);
    return sendAuthorityTx({
      connection: connection(ctx),
      signer,
      instructions: [
        buildRefundIx({
          fan,
          creator,
          sessionId: ref.sessionId,
          vault: sessionVault(session, usdcMint),
          usdcMint,
          fanUsdcAta: getAssociatedTokenAddressSync(usdcMint, fan),
          signer: signer.publicKey,
        }),
      ],
    });
  },
};
