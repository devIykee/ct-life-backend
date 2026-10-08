/**
 * Tests for the ORE stake tx builder.
 *
 * Run: `pnpm exec vitest run server/shared/solana/ore-stake.test.ts`
 *
 * Verifies discriminator derivation, PDA derivation, account
 * layout, and the wire-format round-trip for each action.
 */
import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  buildOreStakeTx,
  encodeTxBase64,
  ORE_MINT,
  ORE_STAKE_PROGRAM_ID,
  stakePda,
  STORE_MINT,
} from './ore-stake.js';

function sha256Disc(name: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`global:${name}`).digest().slice(0, 8));
}

function txFor(action: BinaryData, amount?: bigint): Transaction {
  const user = Keypair.generate().publicKey;
  return buildOreStakeTx({
    userPubkey: user,
    action: action === 'deposit' || action === 'withdraw'
      ? (action === 'deposit' ? 'deposit' : 'withdraw')
      : (action === 'claim' ? 'claim' : 'compound'),
    amount: amount ?? 1_000_000n,
  });
}

function dataFor(action: BinaryData, amount?: bigint): Uint8Array {
  const ix = txFor(action, amount).instructions[0];
  if (ix === undefined) throw new Error('no instructions');
  return ix.data;
}

describe('ore-stake: instruction discriminators', () => {
  it('matches sha256("global:<name>")[..8] for every instruction', () => {
    expect(Buffer.from(dataFor('deposit').subarray(0, 8))).toEqual(
      Buffer.from(sha256Disc('deposit')),
    );
    expect(Buffer.from(dataFor('withdraw').subarray(0, 8))).toEqual(
      Buffer.from(sha256Disc('withdraw')),
    );
    expect(Buffer.from(dataFor('claim').subarray(0, 8))).toEqual(
      Buffer.from(sha256Disc('claim')),
    );
    expect(Buffer.from(dataFor('compound').subarray(0, 8))).toEqual(
      Buffer.from(sha256Disc('compound')),
    );
  });
});

type BinaryData = 'deposit' | 'withdraw' | 'claim' | 'compound';

describe('ore-stake: PDA derivation', () => {
  it('derives the stake PDA from ["stake", user]', () => {
    const user = Keypair.generate().publicKey;
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from('stake'), user.toBuffer()],
      ORE_STAKE_PROGRAM_ID,
    )[0];
    expect(stakePda(user).toBase58()).toBe(expected.toBase58());
  });
});

describe('ore-stake: account metas', () => {
  it('deposit lists the right 9 accounts', () => {
    const user = Keypair.generate().publicKey;
    const tx = buildOreStakeTx({ userPubkey: user, action: 'deposit', amount: 1_000_000n });
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programId.toBase58()).toBe(ORE_STAKE_PROGRAM_ID.toBase58());
    expect(ix.keys).toHaveLength(9);
    expect(ix.keys[0]!.pubkey.toBase58()).toBe(user.toBase58());
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(true);
    // 5th key (index 4): ORE_MINT (not writable)
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(ORE_MINT.toBase58());
    expect(ix.keys[4]!.isWritable).toBe(false);
    // 6th key: STORE_MINT
    expect(ix.keys[5]!.pubkey.toBase58()).toBe(STORE_MINT.toBase58());
  });

  it('claim lists 5 accounts', () => {
    const user = Keypair.generate().publicKey;
    const tx = buildOreStakeTx({ userPubkey: user, action: 'claim' });
    expect(tx.instructions[0]!.keys).toHaveLength(5);
  });

  it('compound lists 6 accounts (signer + stake + ore_ata + ore_mint + stake_to + token_program)', () => {
    const user = Keypair.generate().publicKey;
    const tx = buildOreStakeTx({ userPubkey: user, action: 'compound' });
    expect(tx.instructions[0]!.keys).toHaveLength(6);
  });
});

describe('ore-stake: amount encoding', () => {
  it('deposit instruction data is discriminator + u64 amount', () => {
    const user = Keypair.generate().publicKey;
    const tx = buildOreStakeTx({ userPubkey: user, action: 'deposit', amount: 42n });
    const data = tx.instructions[0]!.data;
    expect(data.byteLength).toBe(16);
    expect(Buffer.from(data.subarray(0, 8))).toEqual(Buffer.from(sha256Disc('deposit')));
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(dv.getBigUint64(8, true)).toBe(42n);
  });

  it('withdraw instruction data is discriminator + u64 amount', () => {
    const user = Keypair.generate().publicKey;
    const tx = buildOreStakeTx({ userPubkey: user, action: 'withdraw', amount: 1_234_567n });
    const data = tx.instructions[0]!.data;
    expect(data.byteLength).toBe(16);
    expect(Buffer.from(data.subarray(0, 8))).toEqual(Buffer.from(sha256Disc('withdraw')));
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    expect(dv.getBigUint64(8, true)).toBe(1_234_567n);
  });

  it('throws on missing amount for deposit', () => {
    const user = Keypair.generate().publicKey;
    expect(() => buildOreStakeTx({ userPubkey: user, action: 'deposit' })).toThrow();
  });
});

describe('ore-stake: encodeTxBase64 round-trip', () => {
  it('produces a non-empty base64 string containing the program-id pubkey', () => {
    const user = Keypair.generate().publicKey;
    const tx = buildOreStakeTx({ userPubkey: user, action: 'deposit', amount: 1n });
    // Set a dummy recentBlockhash so serializeMessage() works.
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.feePayer = user;
    const b64 = encodeTxBase64(tx);
    expect(b64.length).toBeGreaterThan(40);
    const raw = Buffer.from(b64, 'base64');
    expect(raw.byteLength).toBeGreaterThan(40);
    // The ORE_STAKE_PROGRAM_ID bytes appear somewhere in the
    // wire-encoded message (we don't pin the offset; we just
    // assert presence).
    const programBytes = Buffer.from(ORE_STAKE_PROGRAM_ID.toBytes());
    let found = false;
    for (let i = 0; i + 32 <= raw.byteLength; i++) {
      if (raw.subarray(i, i + 32).equals(programBytes)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });
});

describe('ore-stake: mainnet constants verification', () => {
  const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

  it.skipIf(!process.env.RUN_MAINNET_TESTS)(
    'verifies ORE_MINT account exists on mainnet',
    async () => {
      const res = await fetch(MAINNET_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [ORE_MINT.toBase58(), { encoding: 'base64' }],
        }),
      });
      const body = await res.json() as { result?: { value?: unknown } };
      expect(body.result?.value).toBeTruthy();
    },
  );

  it.skipIf(!process.env.RUN_MAINNET_TESTS)(
    'verifies STORE_MINT account exists on mainnet',
    async () => {
      const res = await fetch(MAINNET_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [STORE_MINT.toBase58(), { encoding: 'base64' }],
        }),
      });
      const body = await res.json() as { result?: { value?: unknown } };
      expect(body.result?.value).toBeTruthy();
    },
  );

  it.skipIf(!process.env.RUN_MAINNET_TESTS)(
    'verifies ORE_STAKE_PROGRAM_ID account exists on mainnet',
    async () => {
      const res = await fetch(MAINNET_RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getAccountInfo',
          params: [ORE_STAKE_PROGRAM_ID.toBase58(), { encoding: 'base64' }],
        }),
      });
      const body = await res.json() as { result?: { value?: unknown } };
      expect(body.result?.value).toBeTruthy();
    },
  );
});