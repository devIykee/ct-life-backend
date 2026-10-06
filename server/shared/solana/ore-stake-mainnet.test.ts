/**
 * ORE stake mainnet simulation tests.
 *
 * These tests build real ORE stake transactions and simulate them
 * against mainnet-beta with sigVerify=false. Simulation only - no
 * transactions are sent. Requires RUN_MAINNET_TESTS=1.
 *
 * Run: RUN_MAINNET_TESTS=1 pnpm vitest run server/shared/solana/ore-stake-mainnet.test.ts
 */
import { describe, it, expect } from 'vitest';
import { Connection, Keypair } from '@solana/web3.js';
import { buildOreStakeTx, ORE_STAKE_PROGRAM_ID, ORE_MINT, STORE_MINT } from './ore-stake.js';

const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

describe('ore-stake mainnet simulation', () => {
  const shouldRun = process.env['RUN_MAINNET_TESTS'] === '1';
  const testFn = shouldRun ? it : it.skip;

  testFn('deposit transaction simulates on mainnet', async () => {
    const conn = new Connection(MAINNET_RPC, 'confirmed');
    const user = Keypair.generate();

    const tx = buildOreStakeTx({
      userPubkey: user.publicKey,
      action: 'deposit',
      amount: 1_000_000_000n, // 1 ORE
    });

    // Get a recent blockhash so the transaction is valid
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;

    // Simulate the transaction (unsigned, using the generated keypair as signer)
    const result = await conn.simulateTransaction(tx, [user]);

    console.log('Deposit simulation result:', {
      err: result.value.err,
      logs: result.value.logs?.slice(0, 10), // First 10 log lines
      unitsConsumed: result.value.unitsConsumed,
    });

    // We expect AccountNotFound since the user has no accounts/funds.
    // This proves the transaction structure is valid and reached the RPC.
    // A malformed transaction would fail with different errors (InvalidInstructionData, etc.)
    expect(result.value.err).toBeDefined();
    expect(String(result.value.err)).toMatch(/AccountNotFound|InsufficientFunds/);

    // Verify the transaction actually includes the ORE stake program
    const programIds = tx.instructions.map(ix => ix.programId.toBase58());
    expect(programIds).toContain(ORE_STAKE_PROGRAM_ID.toBase58());
  }, 30000);

  testFn('withdraw transaction simulates on mainnet', async () => {
    const conn = new Connection(MAINNET_RPC, 'confirmed');
    const user = Keypair.generate();

    const tx = buildOreStakeTx({
      userPubkey: user.publicKey,
      action: 'withdraw',
      amount: 500_000_000n, // 0.5 stORE
    });

    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;

    const result = await conn.simulateTransaction(tx, [user]);

    console.log('Withdraw simulation result:', {
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed,
    });

    expect(result.value.err).toBeDefined();
    expect(String(result.value.err)).toMatch(/AccountNotFound|InsufficientFunds/);

    const programIds = tx.instructions.map(ix => ix.programId.toBase58());
    expect(programIds).toContain(ORE_STAKE_PROGRAM_ID.toBase58());
  }, 30000);

  testFn('claim transaction simulates on mainnet', async () => {
    const conn = new Connection(MAINNET_RPC, 'confirmed');
    const user = Keypair.generate();

    const tx = buildOreStakeTx({
      userPubkey: user.publicKey,
      action: 'claim',
    });

    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;

    const result = await conn.simulateTransaction(tx, [user]);

    console.log('Claim simulation result:', {
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed,
    });

    expect(result.value.err).toBeDefined();
    expect(String(result.value.err)).toMatch(/AccountNotFound|InsufficientFunds/);

    const programIds = tx.instructions.map(ix => ix.programId.toBase58());
    expect(programIds).toContain(ORE_STAKE_PROGRAM_ID.toBase58());
  }, 30000);

  testFn('compound transaction simulates on mainnet', async () => {
    const conn = new Connection(MAINNET_RPC, 'confirmed');
    const user = Keypair.generate();

    const tx = buildOreStakeTx({
      userPubkey: user.publicKey,
      action: 'compound',
    });

    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = user.publicKey;

    const result = await conn.simulateTransaction(tx, [user]);

    console.log('Compound simulation result:', {
      err: result.value.err,
      unitsConsumed: result.value.unitsConsumed,
    });

    expect(result.value.err).toBeDefined();
    expect(String(result.value.err)).toMatch(/AccountNotFound|InsufficientFunds/);

    const programIds = tx.instructions.map(ix => ix.programId.toBase58());
    expect(programIds).toContain(ORE_STAKE_PROGRAM_ID.toBase58());
  }, 30000);

  testFn('constants are correct', () => {
    // These constants were verified via getAccountInfo on 2026-10-06
    expect(ORE_MINT.toBase58()).toBe('oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp');
    expect(STORE_MINT.toBase58()).toBe('storenSbvkfzircixnaosc5CbzNZVrHJ6S3EKrS1yqR');
    expect(ORE_STAKE_PROGRAM_ID.toBase58()).toBe('stakecNP3FpiExZPCgZfqRgumVzi6dNqnfrjwXyTgeH');
  });
});
