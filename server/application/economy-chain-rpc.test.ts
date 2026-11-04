import { describe, expect, it, vi } from 'vitest';
import { createEconomyHttpRpc } from './economy-chain-rpc.js';

describe('explicit read-only economy RPC transport', () => {
  it('maps only NEAR UNKNOWN_TRANSACTION to missing evidence for nonblocking polling', async () => {
    const rpc = createEconomyHttpRpc({
      rpcUrls: { 'near:mainnet': 'http://127.0.0.1:1234' },
      fetch: async () =>
        Response.json({
          jsonrpc: '2.0',
          id: 1,
          error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } },
        }),
    });
    expect(
      await rpc('near:mainnet', 'tx', {
        tx_hash: 'fixture',
        sender_account_id: 'payer.near',
        wait_until: 'NONE',
      }),
    ).toBeNull();
    await expect(rpc('near:mainnet', 'status', [])).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
    });
  });
  it('uses configured endpoint and bounded, nonredirecting JSON-RPC POST', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ jsonrpc: '2.0', id: 1, result: '0x1237' }),
    );
    const rpc = createEconomyHttpRpc({
      rpcUrls: { 'eip155:4663': 'https://rpc.example.invalid/private?key=fixture' },
      fetch: request,
    });
    expect(await rpc('eip155:4663', 'eth_chainId', [])).toBe('0x1237');
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toBe('https://rpc.example.invalid/private?key=fixture');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([
    'eth_sendRawTransaction',
    'eth_sendTransaction',
    'sendTransaction',
    'broadcast_tx_commit',
    'wallet_switchEthereumChain',
  ])('rejects %s without network I/O', async (method) => {
    const request = vi.fn<typeof fetch>();
    const rpc = createEconomyHttpRpc({
      rpcUrls: { 'eip155:4663': 'https://rpc.example.invalid' },
      fetch: request,
    });
    await expect(rpc('eip155:4663', method, [])).rejects.toMatchObject({ code: 'CAPABILITY_OFF' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    'http://rpc.example.invalid',
    'https://user:password@rpc.example.invalid',
    'file:///tmp/rpc',
  ])('refuses absent or unsafe configured endpoint %s', async (endpoint) => {
    const request = vi.fn<typeof fetch>();
    const rpc = createEconomyHttpRpc({
      rpcUrls: endpoint ? { 'near:mainnet': endpoint } : {},
      fetch: request,
    });
    await expect(rpc('near:mainnet', 'status', [])).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { jsonrpc: '2.0', id: 2, result: 1 },
    { jsonrpc: '2.0', id: 1, error: { message: 'provider-secret' } },
    { jsonrpc: '1.0', id: 1, result: 1 },
    [],
  ])('rejects malformed/error envelopes without exposing payload', async (body) => {
    const rpc = createEconomyHttpRpc({
      rpcUrls: { 'near:mainnet': 'http://127.0.0.1:1234' },
      fetch: async () => Response.json(body),
    });
    await expect(rpc('near:mainnet', 'status', [])).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
      details: { reason: 'economy_rpc_unavailable', chainId: 'near:mainnet' },
    });
  });
  it('aborts a slow provider request', async () => {
    const request: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('provider-secret')), {
          once: true,
        }),
      );
    const rpc = createEconomyHttpRpc({
      rpcUrls: { 'near:mainnet': 'http://127.0.0.1:1234' },
      fetch: request,
      timeoutMs: 5,
    });
    await expect(rpc('near:mainnet', 'status', [])).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
    });
  });
  it('rejects an oversized response stream', async () => {
    const rpc = createEconomyHttpRpc({
      rpcUrls: { 'near:mainnet': 'http://127.0.0.1:1234' },
      fetch: async () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
    });
    await expect(rpc('near:mainnet', 'status', [])).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
    });
  });
});
