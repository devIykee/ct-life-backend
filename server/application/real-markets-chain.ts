/**
 * Real Markets' own Solana MAINNET RPC, kept apart from the app's cluster.
 *
 * Why separate: the game economy runs on devnet (`config.solana.cluster`, chosen by
 * APP_ENV, with the D0 boot guard refusing APP_ENV=prod unless ALLOW_MAINNET=1). Panta
 * and Jupiter exist only on mainnet. This module reads mainnet through
 * `config.realMarkets.mainnetRpcUrl` and NEVER reads or changes `config.solana`, so turning
 * Real Markets on does not move the economy to mainnet and does not need ALLOW_MAINNET.
 * That is safe because Real Markets never sign or send: this client is read-only
 * (`getGenesisHash`, `getSignatureStatuses`, `getTransaction`, `getBlockHeight`, and
 * `getSignaturesForAddress` for reconciliation, real-markets-reconcile.ts).
 *
 * Before the first verification the RPC must prove it is mainnet (`getGenesisHash`), so a
 * mis-set URL pointing at devnet can never "confirm" a trade that did not happen.
 */
import type { AppContext } from './context.js';
import { createHeliusClient, HeliusError, type HeliusClient } from '../shared/solana/helius.js';
import { CapabilityOffError } from '../shared/domain/errors.js';
import { MAINNET_GENESIS_HASH } from '../shared/domain/real-markets.js';

let override: HeliusClient | null = null;
let cached: { url: string; client: HeliusClient } | null = null;
let mainnetChecked = false;

/**
 * @param ctx - The app context.
 * @returns A read-only JSON-RPC client on the Real Markets mainnet URL.
 */
export function realMarketsRpc(ctx: Pick<AppContext, 'config'>): HeliusClient {
  if (override !== null) return override;
  const url = ctx.config.realMarkets.mainnetRpcUrl;
  if (cached?.url !== url) {
    cached = { url, client: createHeliusClient({ url, apiKey: '' }) };
  }
  return cached.client;
}

/** Test-only: answer every Real Markets RPC call with `client` (null restores the real one). */
export function _setRealMarketsRpcForTests(client: HeliusClient | null): void {
  override = client;
  mainnetChecked = false;
}

/**
 * Refuse (503 CAPABILITY_OFF {reason: rpc_not_mainnet}) unless the Real Markets RPC is
 * mainnet-beta. Checked once per process.
 *
 * @param ctx - The app context.
 */
export async function assertMainnetRpc(ctx: Pick<AppContext, 'config'>): Promise<void> {
  if (mainnetChecked) return;
  let genesis: string;
  try {
    genesis = await realMarketsRpc(ctx).rpc<string>('getGenesisHash', []);
  } catch {
    throw new CapabilityOffError({ capability: 'realMarkets', reason: 'rpc_unreachable' });
  }
  if (genesis !== MAINNET_GENESIS_HASH) {
    throw new CapabilityOffError({ capability: 'realMarkets', reason: 'rpc_not_mainnet' });
  }
  mainnetChecked = true;
}

export type ChainVerdict =
  /** Not seen yet (or only `processed`), or the RPC did not answer: ask again later. */
  | { readonly kind: 'pending' }
  /** Never landed and its blockhash can no longer land. */
  | { readonly kind: 'expired' }
  /** Landed from the right wallet, with an on-chain error. */
  | { readonly kind: 'failed'; readonly error: string }
  /** Landed, succeeded, from the order's wallet, invoking every built program. */
  | { readonly kind: 'confirmed' }
  /** Landed but is not this order. */
  | { readonly kind: 'mismatch'; readonly reason: 'fee_payer' | 'programs' };

interface SigStatus {
  readonly confirmationStatus?: 'processed' | 'confirmed' | 'finalized' | null;
  readonly err?: unknown;
}

interface JsonTx {
  readonly meta?: { readonly err?: unknown } | null;
  readonly transaction?: {
    readonly message?: {
      readonly accountKeys?: readonly string[];
      readonly instructions?: ReadonlyArray<{ readonly programIdIndex: number }>;
    };
  };
}

/**
 * Check a player-reported signature against the order it claims to be.
 *
 * @param ctx - The app context.
 * @param o - The order's wallet, built programs and last valid block height.
 * @returns The verdict. RPC failures read as `pending` (the client polls again).
 */
export async function verifyOrderSignature(
  ctx: Pick<AppContext, 'config'>,
  o: {
    readonly signature: string;
    readonly wallet: string;
    readonly programIds: readonly string[];
    readonly lastValidBlockHeight: number | null;
  },
): Promise<ChainVerdict> {
  await assertMainnetRpc(ctx);
  const rpc = realMarketsRpc(ctx);
  try {
    const st = await rpc.rpc<{ value: Array<SigStatus | null> }>('getSignatureStatuses', [
      [o.signature],
      { searchTransactionHistory: true },
    ]);
    const s = st.value[0] ?? null;
    if (s === null || s.confirmationStatus === 'processed' || !s.confirmationStatus) {
      if (s === null && o.lastValidBlockHeight !== null) {
        const height = await rpc.rpc<number>('getBlockHeight', [{ commitment: 'confirmed' }]);
        if (height > o.lastValidBlockHeight) return { kind: 'expired' };
      }
      return { kind: 'pending' };
    }
    const tx = await rpc.rpc<JsonTx | null>('getTransaction', [
      o.signature,
      { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
    ]);
    const keys = tx?.transaction?.message?.accountKeys ?? [];
    if (!tx || keys.length === 0) return { kind: 'pending' };
    if (keys[0] !== o.wallet) return { kind: 'mismatch', reason: 'fee_payer' };
    // Program ids are always static keys (v0 lookup tables cannot load them).
    const invoked = new Set(
      (tx.transaction?.message?.instructions ?? []).map((ix) => keys[ix.programIdIndex]),
    );
    if (!o.programIds.every((p) => invoked.has(p))) return { kind: 'mismatch', reason: 'programs' };
    const err = tx.meta?.err ?? s.err ?? null;
    if (err !== null && err !== undefined) return { kind: 'failed', error: JSON.stringify(err) };
    return { kind: 'confirmed' };
  } catch (e) {
    if (e instanceof HeliusError) return { kind: 'pending' };
    throw e;
  }
}
