/**
 * The Solana RPC for the deployment's own cluster, and the devnet assert every WP-C
 * (chain) feature calls before it builds or verifies a transaction.
 *
 * Why this exists: `ctx.helius` is built on `HELIUS_RPC_URL_MAINNET` (the ORE board and
 * the SGT check read mainnet on purpose), but payments, paid calls and the SOL drip
 * must read the cluster the money is on (`config.solana.rpcUrl`: devnet unless
 * APP_ENV=prod). Reading a devnet payment from mainnet RPC never finds it.
 *
 * Mainnet: the D0 boot guard refuses APP_ENV=prod without ALLOW_MAINNET=1. The chain
 * features add their own refusal on top (`assertDevnetChain`), so even an operator who
 * sets ALLOW_MAINNET=1 does not move real funds through code that was only reviewed for
 * devnet. Lifting it is a code change after the mainnet legal review.
 */
import type { AppContext } from './context.js';
import { createHeliusClient, type HeliusClient } from '../shared/solana/helius.js';
import { CapabilityOffError } from '../shared/domain/errors.js';
import type { CapabilityName } from '../shared/domain/capabilities.js';

let override: HeliusClient | null = null;
const byUrl = new Map<string, HeliusClient>();

/**
 * @param ctx - The app context.
 * @returns A JSON-RPC client on `config.solana.rpcUrl` (the deployment's cluster).
 */
export function clusterRpc(ctx: Pick<AppContext, 'config' | 'helius'>): HeliusClient {
  if (override !== null) return override;
  const url = ctx.config.solana.rpcUrl;
  if (url === ctx.config.helius.rpcUrlMainnet) return ctx.helius;
  let client = byUrl.get(url);
  if (client === undefined) {
    client = createHeliusClient({ url, apiKey: ctx.config.helius.apiKey });
    byUrl.set(url, client);
  }
  return client;
}

/** Test-only: answer every `clusterRpc` call with `client` (null restores the real one). */
export function _setClusterRpcForTests(client: HeliusClient | null): void {
  override = client;
}

/**
 * @param ctx - The app context.
 * @returns The latest `confirmed` blockhash and its last valid block height.
 */
export async function latestBlockhash(
  ctx: Pick<AppContext, 'config' | 'helius'>,
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const r = await clusterRpc(ctx).rpc<{
    value: { blockhash: string; lastValidBlockHeight: number };
  }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return r.value;
}

/**
 * Refuse (503 CAPABILITY_OFF, `reason: 'devnet_only'`) unless the deployment is on
 * devnet. Call before building, signing or verifying any chain transaction.
 *
 * @param ctx - The app context.
 * @param capability - The capability the caller serves (echoed in the error).
 */
export function assertDevnetChain(
  ctx: Pick<AppContext, 'config'>,
  capability: CapabilityName,
): void {
  if (ctx.config.solana.cluster !== 'devnet') {
    throw new CapabilityOffError({ capability, reason: 'devnet_only' });
  }
}

/** Genesis hash of Solana devnet (`getGenesisHash`, read 2026-10-30). */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

let devnetRpcChecked = false;

/**
 * Before the server signs and sends anything: refuse unless the cluster RPC really is
 * devnet (`getGenesisHash`), so a mis-set RPC URL can never spend on mainnet even when
 * `config.solana.cluster` says devnet. Checked once per process.
 *
 * @param ctx - The app context.
 * @param capability - The capability the caller serves (echoed in the error).
 */
export async function assertDevnetRpc(
  ctx: Pick<AppContext, 'config' | 'helius'>,
  capability: CapabilityName,
): Promise<void> {
  assertDevnetChain(ctx, capability);
  if (devnetRpcChecked) return;
  const genesis = await clusterRpc(ctx).rpc<string>('getGenesisHash', []);
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new CapabilityOffError({ capability, reason: 'rpc_not_devnet' });
  }
  devnetRpcChecked = true;
}

/** Test-only: forget the genesis check. */
export function _resetDevnetRpcCheckForTests(): void {
  devnetRpcChecked = false;
}
