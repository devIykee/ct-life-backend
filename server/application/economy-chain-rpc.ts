/** Explicit, bounded, read-only JSON-RPC transport for native payment evidence. */
import dns from 'node:dns';
import { CapabilityOffError } from '../shared/domain/errors.js';
import type { EconomyChainId, EconomyRpc } from './economy-chain.js';

// Prioritize IPv4 for dual-stack hosts to avoid undici connection timeouts on environments with broken IPv6 routes.
dns.setDefaultResultOrder?.('ipv4first');

const METHODS: Record<EconomyChainId, readonly string[]> = {
  'eip155:4663': [
    'eth_chainId',
    'eth_getCode',
    'eth_call',
    'eth_getTransactionByHash',
    'eth_getTransactionReceipt',
    'eth_getBlockByNumber',
  ],
  'near:mainnet': ['status', 'tx', 'block'],
  'solana:mainnet': [
    'getGenesisHash',
    'getAccountInfo',
    'getLatestBlockhash',
    'getTransaction',
    'getSignatureStatuses',
    'getBlock',
  ],
};
const MAX_BYTES = 16 * 1024 * 1024;

/** No default endpoint, transaction broadcast, redirect, or server signing path. */
export function createEconomyHttpRpc({
  rpcUrls,
  fetch: request = globalThis.fetch,
  timeoutMs = 12_000,
}: {
  readonly rpcUrls: Partial<Record<EconomyChainId, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): EconomyRpc {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('Invalid economy RPC timeout');
  return async (chainId, method, params) => {
    try {
      if (!METHODS[chainId]?.includes(method)) throw new Error('Read-only RPC method required');
      const endpoint = rpcUrls[chainId];
      if (!endpoint) throw new Error('RPC unavailable');
      const url = new URL(endpoint);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if (
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new Error('Invalid RPC URL');
      const response = await request(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      if (!response.ok || !response.body) throw new Error('RPC HTTP failure');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) throw new Error('RPC response too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      const json: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (json === null || typeof json !== 'object' || Array.isArray(json))
        throw new Error('RPC envelope invalid');
      const envelope = json as Record<string, unknown>;
      // Official NEAR tx error contract: NONE returns UNKNOWN_TRANSACTION when
      // unseen; this is absence of evidence, not success or a provider outage.
      // https://docs.near.org/api/rpc/transactions#error-handling
      if (
        chainId === 'near:mainnet' &&
        method === 'tx' &&
        envelope.jsonrpc === '2.0' &&
        envelope.id === 1 &&
        !('result' in envelope)
      ) {
        const error = envelope.error;
        if (error && typeof error === 'object' && !Array.isArray(error)) {
          const detail = error as Record<string, unknown>;
          const cause = detail.cause;
          if (
            detail.name === 'HANDLER_ERROR' &&
            cause &&
            typeof cause === 'object' &&
            !Array.isArray(cause) &&
            (cause as Record<string, unknown>).name === 'UNKNOWN_TRANSACTION'
          )
            return null;
        }
      }
      if (
        envelope.jsonrpc !== '2.0' ||
        envelope.id !== 1 ||
        'error' in envelope ||
        !('result' in envelope)
      )
        throw new Error('RPC result unavailable');
      return envelope.result;
    } catch {
      // Never leak provider response/error text, URLs, query credentials or headers.
      throw new CapabilityOffError({ reason: 'economy_rpc_unavailable', chainId });
    }
  };
}
