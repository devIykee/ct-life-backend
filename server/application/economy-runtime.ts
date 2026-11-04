import type { Config } from '../shared/config/config.js';
import { createEconomyChain } from './economy-chain.js';
import { createEconomyHttpRpc } from './economy-chain-rpc.js';

/** Explicit network endpoints only: never fall back from a failed mainnet to devnet. */
export function buildEconomyChain(config: Config, fetcher: typeof fetch = fetch) {
  return createEconomyChain({
    rpc: createEconomyHttpRpc({ rpcUrls: config.economy.rpcUrls, fetch: fetcher }),
  });
}
