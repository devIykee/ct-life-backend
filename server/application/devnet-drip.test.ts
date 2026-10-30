/**
 * Review L2: which failed drip sends free the day's slot. Only a send the RPC refused
 * outright (a JSON-RPC error object, or the provider refusing the HTTP request) whose
 * signature has no status on the cluster is `rejected`; a clean status is `landed`;
 * everything else is `unknown` and keeps the slot. Pure: a fake RPC, no database.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { _setClusterRpcForTests } from './chain-rpc.js';
import type { AppContext } from './context.js';
import { sendOutcome, sendRefusedOutright } from './devnet-drip.js';
import { HeliusError, type HeliusClient } from '../shared/solana/helius.js';

const ctx = {} as AppContext;
const refused = new HeliusError('Transaction simulation failed', 'RPC_ERROR', 502, -32002);
const timeout = new HeliusError('sendTransaction timed out', 'TIMEOUT', 504);

function rpcAnswering(status: unknown | Error): void {
  _setClusterRpcForTests({
    async rpc<T>(method: string): Promise<T> {
      expect(method).toBe('getSignatureStatuses');
      if (status instanceof Error) throw status;
      return { value: [status] } as T;
    },
  } as unknown as HeliusClient);
}

afterAll(() => _setClusterRpcForTests(null));

describe('sendRefusedOutright', () => {
  it('is true only for a JSON-RPC error object or an HTTP 401/403/429', () => {
    expect(sendRefusedOutright(refused)).toBe(true);
    expect(sendRefusedOutright(new HeliusError('auth', 'UNAUTHORIZED', 502))).toBe(true);
    expect(sendRefusedOutright(new HeliusError('limit', 'RATE_LIMITED', 503))).toBe(true);
    expect(sendRefusedOutright(timeout)).toBe(false);
    expect(sendRefusedOutright(new HeliusError('reset', 'NETWORK', 502))).toBe(false);
    expect(sendRefusedOutright(new HeliusError('HTTP 502', 'UPSTREAM', 502))).toBe(false);
    // RPC_ERROR without a JSON-RPC code is "no result": the node's answer was malformed.
    expect(sendRefusedOutright(new HeliusError('no result', 'RPC_ERROR', 502))).toBe(false);
    expect(sendRefusedOutright(new Error('boom'))).toBe(false);
  });
});

describe('sendOutcome', () => {
  it('refused outright and no status: rejected (the only case that frees the slot)', async () => {
    rpcAnswering(null);
    expect(await sendOutcome(ctx, 'sig', refused)).toBe('rejected');
  });

  it('no answer and no status yet: unknown (it may still land)', async () => {
    rpcAnswering(null);
    expect(await sendOutcome(ctx, 'sig', timeout)).toBe('unknown');
  });

  it('a clean status: landed, whatever the send threw', async () => {
    rpcAnswering({ slot: 1, confirmations: 0, err: null, confirmationStatus: 'processed' });
    expect(await sendOutcome(ctx, 'sig', timeout)).toBe('landed');
    expect(await sendOutcome(ctx, 'sig', refused)).toBe('landed');
  });

  it('a status with an on-chain error: unknown', async () => {
    rpcAnswering({ slot: 1, confirmations: 0, err: { InstructionError: [0, 'Custom'] } });
    expect(await sendOutcome(ctx, 'sig', refused)).toBe('unknown');
  });

  it('the status lookup fails: unknown, even after an outright refusal', async () => {
    rpcAnswering(new HeliusError('timed out', 'TIMEOUT', 504));
    expect(await sendOutcome(ctx, 'sig', refused)).toBe('unknown');
  });
});
