import { describe, expect, it } from 'vitest';
import { createEconomyChain } from './economy-chain.js';
import { evmFixture, nearFixture } from './economy-chain.fixtures.js';

describe('Robinhood WIF finalized evidence', () => {
  it('returns exact finalized log identity, parties, amount and canonical block time', async () => {
    const f = evmFixture();
    expect(
      await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id),
    ).toMatchObject({
      state: 'verified',
      evidence: {
        chainId: 'eip155:4663',
        assetId: f.expectation.assetId,
        payer: f.expectation.payer,
        recipient: f.expectation.recipient,
        transactionId: f.id,
        eventId: `${f.id}:log:1`,
        blockHeight: '100',
        blockTimestampMs: 1_700_000_000_000,
        reference: null,
      },
    });
  });
  it.each([
    'network',
    'tx network',
    'reverted',
    'payer',
    'token',
    'input recipient',
    'value',
    'event amount',
    'event recipient',
    'removed',
    'fork',
    'block membership',
    'event tx',
    'duplicate event',
    'ambiguous',
    'noncanonical quantity',
  ])('rejects %s', async (attack) => {
    const f = evmFixture();
    if (attack === 'network') f.results.eth_chainId = '0xb626';
    if (attack === 'tx network') f.transaction.chainId = '0xb626';
    if (attack === 'reverted') f.receipt.status = '0x0';
    if (attack === 'payer') f.transaction.from = f.expectation.recipient;
    if (attack === 'token') f.log.address = f.expectation.recipient;
    if (attack === 'input recipient')
      f.transaction.input = f.transaction.input.replace('22'.repeat(20), '33'.repeat(20));
    if (attack === 'value') f.transaction.value = '0x1';
    if (attack === 'event amount') f.log.data = f.word(999n);
    if (attack === 'event recipient') f.log.topics[2] = f.word(BigInt(f.expectation.payer));
    if (attack === 'removed') f.log.removed = true;
    if (attack === 'fork') f.block.hash = `0x${'55'.repeat(32)}`;
    if (attack === 'block membership') f.block.transactions = [];
    if (attack === 'event tx') f.log.transactionHash = `0x${'66'.repeat(32)}`;
    if (attack === 'duplicate event') f.receipt.logs.push(structuredClone(f.log));
    if (attack === 'ambiguous') f.receipt.logs.push({ ...structuredClone(f.log), logIndex: '0x2' });
    if (attack === 'noncanonical quantity') f.receipt.blockNumber = '0x064';
    expect(
      (await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id)).state,
    ).toBe('rejected');
  });
  it('does not accept execution before canonical finality', async () => {
    const f = evmFixture();
    f.finalized.number = '0x63';
    expect(await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id)).toEqual({
      state: 'pending',
      reason: 'not_finalized',
    });
  });
  it('returns not found for a missing receipt', async () => {
    const f = evmFixture();
    f.results.eth_getTransactionReceipt = null;
    expect(await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id)).toEqual({
      state: 'pending',
      reason: 'not_found',
    });
  });
});

describe('NEAR finalized transfer receipt evidence', () => {
  it('requires FINAL and follows actual receipt execution, including successful refund outcome', async () => {
    const f = nearFixture();
    expect(
      await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id),
    ).toMatchObject({
      state: 'verified',
      evidence: {
        eventId: `${f.id}:receipt:${f.receiptId}:transfer:0`,
        blockId: f.payment.block_hash,
        blockTimestampMs: 1_700_000_000_000,
        reference: null,
      },
    });
  });
  it.each(['NONE', 'INCLUDED', 'EXECUTED_OPTIMISTIC', 'INCLUDED_FINAL', 'EXECUTED'])(
    'does not grant a %s transaction',
    async (status) => {
      const f = nearFixture();
      f.result.final_execution_status = status;
      expect(await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id)).toEqual({
        state: 'pending',
        reason: 'not_finalized',
      });
    },
  );
  it.each([
    'network',
    'failed transaction',
    'contradictory transaction status',
    'failed transfer receipt',
    'contradictory receipt status',
    'failed refund',
    'missing refund',
    'orphan receipt',
    'receipt cycle',
    'wrong signer',
    'wrong receiver',
    'wrong amount',
    'extra action',
    'wrong executor',
    'fork',
    'malformed timestamp',
    'outside window',
  ])('rejects %s', async (attack) => {
    const f = nearFixture();
    if (attack === 'network') f.results.status = { chain_id: 'testnet' };
    if (attack === 'failed transaction') f.result.status = { Failure: {} };
    if (attack === 'contradictory transaction status')
      f.result.status = { SuccessValue: '', Failure: {} };
    if (attack === 'failed transfer receipt') f.payment.outcome.status = { Failure: {} };
    if (attack === 'contradictory receipt status')
      f.payment.outcome.status = { SuccessValue: '', Failure: {} };
    if (attack === 'failed refund') f.refund.outcome.status = { Failure: {} };
    if (attack === 'missing refund') f.result.receipts_outcome.pop();
    if (attack === 'orphan receipt') f.payment.outcome.receipt_ids = [];
    if (attack === 'receipt cycle') f.refund.outcome.receipt_ids.push(f.receiptId);
    if (attack === 'wrong signer') f.result.transaction.signer_id = 'other.near';
    if (attack === 'wrong receiver') f.result.transaction.receiver_id = 'other.near';
    if (attack === 'wrong amount') f.result.transaction.actions[0]!.Transfer.deposit = '999';
    if (attack === 'extra action')
      f.result.transaction.actions.push({ Transfer: { deposit: '1000' } });
    if (attack === 'wrong executor') f.payment.outcome.executor_id = 'other.near';
    if (attack === 'fork') f.canonical.header.hash = f.id;
    if (attack === 'malformed timestamp') f.block.header.timestamp_nanosec = '1.7e18';
    if (attack === 'outside window') f.block.header.timestamp_nanosec = '1800000000000000000';
    expect(
      (await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id)).state,
    ).toBe('rejected');
  });
  it('does not accept a receipt block newer than the finalized block', async () => {
    const f = nearFixture();
    f.finalized.header.height = 99;
    expect(await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.id)).toEqual({
      state: 'pending',
      reason: 'not_finalized',
    });
  });
});
