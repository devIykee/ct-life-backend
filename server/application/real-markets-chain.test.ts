/**
 * Real Markets' mainnet verification against a fake RPC, and its isolation from the
 * app's cluster: turning Real Markets on leaves `config.solana.cluster` on devnet, needs no
 * ALLOW_MAINNET, and refuses an RPC whose genesis hash is not mainnet's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { loadConfig, _resetConfigForTests } from '../shared/config/config.js';
import type { HeliusClient } from '../shared/solana/helius.js';
import { HeliusError } from '../shared/solana/helius.js';
import { MAINNET_GENESIS_HASH } from '../shared/domain/real-markets.js';
import { DEVNET_GENESIS_HASH } from './chain-rpc.js';
import {
  _setRealMarketsRpcForTests,
  assertMainnetRpc,
  verifyOrderSignature,
} from './real-markets-chain.js';

const wallet = Keypair.generate().publicKey.toBase58();
const program = Keypair.generate().publicKey.toBase58();
const computeBudget = 'ComputeBudget111111111111111111111111111111';

interface FakeTx {
  feePayer: string;
  programs: string[];
  err?: unknown;
}

class FakeRpc implements HeliusClient {
  genesis = MAINNET_GENESIS_HASH;
  status: { confirmationStatus: string; err: unknown } | null = null;
  tx: FakeTx | null = null;
  height = 100;
  calls: string[] = [];
  fail = false;
  async health(): Promise<string> {
    return 'ok';
  }
  async rpc<T>(method: string): Promise<T> {
    this.calls.push(method);
    if (this.fail && method !== 'getGenesisHash') throw new HeliusError('down', 'TIMEOUT', 504);
    switch (method) {
      case 'getGenesisHash':
        return this.genesis as T;
      case 'getSignatureStatuses':
        return { value: [this.status] } as T;
      case 'getBlockHeight':
        return this.height as T;
      case 'getTransaction': {
        if (!this.tx) return null as T;
        const keys = [this.tx.feePayer, ...this.tx.programs];
        return {
          meta: { err: this.tx.err ?? null },
          transaction: {
            message: {
              accountKeys: keys,
              instructions: this.tx.programs.map((_, i) => ({ programIdIndex: i + 1 })),
            },
          },
        } as T;
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
  async sgtMintsFor(): Promise<string[]> {
    return [];
  }
  async collectionAssetsOwnedBy(): Promise<string[]> {
    return [];
  }
}

let rpc: FakeRpc;
const order = (lastValid: number | null = 150) => ({
  signature: 'sig',
  wallet,
  programIds: [program],
  lastValidBlockHeight: lastValid,
});

beforeEach(() => {
  rpc = new FakeRpc();
  _setRealMarketsRpcForTests(rpc);
});
afterEach(() => _setRealMarketsRpcForTests(null));

describe('real markets mainnet isolation', () => {
  it('leaves the app on devnet and needs no ALLOW_MAINNET', () => {
    const saved = {
      APP_ENV: process.env.APP_ENV,
      ALLOW_MAINNET: process.env.ALLOW_MAINNET,
      CAPABILITIES_ON: process.env.CAPABILITIES_ON,
    };
    process.env.APP_ENV = 'local';
    delete process.env.ALLOW_MAINNET;
    process.env.CAPABILITIES_ON = 'realMarkets,realMarketsJupiter';
    _resetConfigForTests();
    try {
      const cfg = loadConfig();
      expect(cfg.solana.cluster).toBe('devnet');
      expect(cfg.capabilities.on.has('realMarkets')).toBe(true);
      // Its own mainnet URL; defaults to the mainnet Helius URL, never the devnet one.
      expect(cfg.realMarkets.mainnetRpcUrl).toBe(cfg.helius.rpcUrlMainnet);
      expect(cfg.realMarkets.mainnetRpcUrl).not.toBe(cfg.solana.rpcUrl);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      _resetConfigForTests();
    }
  });

  it('refuses to boot with realMarkets on and no edge secret outside local/test', () => {
    const keys = [
      'APP_ENV',
      'NODE_ENV',
      'ENABLE_DEV_AUTH',
      'CAPABILITIES_ON',
      'REAL_MARKETS_EDGE_AUTH_HEADER',
      'REAL_MARKETS_EDGE_AUTH_SECRET',
    ];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const set = (vars: Record<string, string | undefined>): void => {
      for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      _resetConfigForTests();
    };
    try {
      set({
        APP_ENV: 'staging',
        NODE_ENV: 'development',
        ENABLE_DEV_AUTH: 'false',
        CAPABILITIES_ON: 'realMarkets',
        REAL_MARKETS_EDGE_AUTH_HEADER: undefined,
        REAL_MARKETS_EDGE_AUTH_SECRET: undefined,
      });
      expect(() => loadConfig()).toThrow(/REAL_MARKETS_EDGE_AUTH_SECRET/);
      set({
        REAL_MARKETS_EDGE_AUTH_HEADER: 'x-edge-auth',
        REAL_MARKETS_EDGE_AUTH_SECRET: undefined,
      });
      expect(() => loadConfig()).toThrow(/REAL_MARKETS_EDGE_AUTH_SECRET/);
      set({ REAL_MARKETS_EDGE_AUTH_SECRET: 's3cret' });
      expect(loadConfig().realMarkets.edgeAuthHeader).toBe('x-edge-auth');
      // Capability off: no edge secret needed.
      set({
        CAPABILITIES_ON: '',
        REAL_MARKETS_EDGE_AUTH_HEADER: undefined,
        REAL_MARKETS_EDGE_AUTH_SECRET: undefined,
      });
      expect(() => loadConfig()).not.toThrow();
      // Local development may run without it (every request then reads as unknown_country).
      set({ APP_ENV: 'local', CAPABILITIES_ON: 'realMarkets' });
      expect(() => loadConfig()).not.toThrow();
    } finally {
      set(saved);
    }
  });

  it('refuses an RPC that is not mainnet', async () => {
    rpc.genesis = DEVNET_GENESIS_HASH;
    await expect(assertMainnetRpc({ config: loadConfig() })).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
      details: { capability: 'realMarkets', reason: 'rpc_not_mainnet' },
    });
    await expect(verifyOrderSignature({ config: loadConfig() }, order())).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
    });
  });
});

describe('verifyOrderSignature', () => {
  const ctx = () => ({ config: loadConfig() });

  it('confirms a successful tx from the wallet that invokes the built programs', async () => {
    rpc.status = { confirmationStatus: 'confirmed', err: null };
    // The wallet may add a priority fee (ComputeBudget); extra programs are fine.
    rpc.tx = { feePayer: wallet, programs: [computeBudget, program] };
    expect(await verifyOrderSignature(ctx(), order())).toEqual({ kind: 'confirmed' });
  });

  it('is pending while unseen or only processed', async () => {
    expect(await verifyOrderSignature(ctx(), order())).toEqual({ kind: 'pending' });
    rpc.status = { confirmationStatus: 'processed', err: null };
    expect(await verifyOrderSignature(ctx(), order())).toEqual({ kind: 'pending' });
  });

  it('is expired once unseen past the last valid block height', async () => {
    rpc.height = 151;
    expect(await verifyOrderSignature(ctx(), order(150))).toEqual({ kind: 'expired' });
  });

  it('flags a different fee payer or missing programs as a mismatch', async () => {
    rpc.status = { confirmationStatus: 'finalized', err: null };
    rpc.tx = { feePayer: Keypair.generate().publicKey.toBase58(), programs: [program] };
    expect(await verifyOrderSignature(ctx(), order())).toEqual({
      kind: 'mismatch',
      reason: 'fee_payer',
    });
    rpc.tx = { feePayer: wallet, programs: [computeBudget] };
    expect(await verifyOrderSignature(ctx(), order())).toEqual({
      kind: 'mismatch',
      reason: 'programs',
    });
  });

  it('reports an on-chain error as failed', async () => {
    rpc.status = { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } };
    rpc.tx = { feePayer: wallet, programs: [program], err: { InstructionError: [0, 'Custom'] } };
    const v = await verifyOrderSignature(ctx(), order());
    expect(v.kind).toBe('failed');
  });

  it('reads RPC trouble as pending (the client polls again)', async () => {
    rpc.fail = true;
    expect(await verifyOrderSignature(ctx(), order())).toEqual({ kind: 'pending' });
  });
});
