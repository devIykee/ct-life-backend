import { describe, expect, it, vi } from 'vitest';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { createEconomyChain, ECONOMY_ORE } from './economy-chain.js';
import { ECONOMY_MEMO_PROGRAM } from './economy-chain-solana.js';
import { encode58, evmFixture, nearFixture, solanaFixture } from './economy-chain.fixtures.js';

describe('native payment expectations and unsigned preparation', () => {
  it('rejects off-curve Solana recipients because refunds require the reversed wallet signer', async () => {
    const f = solanaFixture();
    const rpc = vi.fn(f.rpc);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('economy-fixture')],
      SystemProgram.programId,
    );
    const e = { ...f.expectation, recipient: pda.toBase58() };
    expect(await createEconomyChain({ rpc }).verifyPayment(e, f.signature)).toEqual({
      state: 'rejected',
      reason: 'invalid_expectation',
    });
    await expect(createEconomyChain({ rpc }).preparePayment(e)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('rejects unknown assets, zero/noncanonical amounts and invalid windows before RPC', async () => {
    const f = evmFixture();
    const rpc = vi.fn(f.rpc);
    const chain = createEconomyChain({ rpc });
    for (const changes of [
      { assetId: 'native' },
      { amountBaseUnits: '0' },
      { amountBaseUnits: '01' },
      { amountBaseUnits: '1.1' },
      { amountBaseUnits: (1n << 256n).toString() },
      { payer: f.expectation.recipient },
      { notAfterMs: 0 },
    ]) {
      expect((await chain.verifyPayment({ ...f.expectation, ...changes }, f.id)).state).toBe(
        'rejected',
      );
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('prepares exactly a WIF transfer with explicit chain/from and zero ETH value', async () => {
    const f = evmFixture();
    expect(await createEconomyChain({ rpc: f.rpc }).preparePayment(f.expectation)).toEqual({
      kind: 'evm',
      chainId: 'eip155:4663',
      transaction: {
        from: f.expectation.payer,
        to: f.expectation.assetId,
        data: f.transaction.input,
        value: '0x0',
        chainId: '0x1237',
      },
    });
  });
  it.each(['eth_getCode', 'eth_call'])('refuses wrong contract metadata in %s', async (method) => {
    const f = evmFixture();
    f.results[method] = method === 'eth_getCode' ? '0x' : f.word(6n);
    await expect(
      createEconomyChain({ rpc: f.rpc }).preparePayment(f.expectation),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('prepares a single NEAR native transfer without fabricated order memo', async () => {
    const f = nearFixture();
    expect(await createEconomyChain({ rpc: f.rpc }).preparePayment(f.expectation)).toEqual({
      kind: 'near',
      chainId: 'near:mainnet',
      signerId: 'payer.near',
      receiverId: 'merchant.near',
      actions: [{ type: 'Transfer', params: { deposit: '1000' } }],
    });
  });
  it.each([false, true])(
    'builds an unsigned legacy Solana transaction with exact payer, transfer and signed memo (ORE=%s)',
    async (ore) => {
      const f = solanaFixture(ore);
      const prepared = await createEconomyChain({ rpc: f.rpc }).preparePayment(f.expectation);
      expect(prepared.kind).toBe('solana');
      if (prepared.kind !== 'solana') return;
      const tx = Transaction.from(Buffer.from(prepared.transactionBase64, 'base64'));
      expect(tx.feePayer?.toBase58()).toBe(f.expectation.payer);
      expect(tx.signatures).toHaveLength(1);
      expect(tx.signatures[0]?.signature).toBeNull();
      expect(tx.instructions).toHaveLength(ore ? 3 : 2);
      const memo = tx.instructions.at(-1)!;
      expect(memo.programId.toBase58()).toBe(ECONOMY_MEMO_PROGRAM);
      expect(memo.data.toString()).toBe(f.expectation.reference);
      expect(memo.keys).toHaveLength(1);
      expect(memo.keys[0]?.isSigner).toBe(true);
      expect(memo.keys[0]?.pubkey.toBase58()).toBe(f.expectation.payer);
      if (ore) {
        const mint = new PublicKey(ECONOMY_ORE);
        const payer = new PublicKey(f.expectation.payer);
        const recipient = new PublicKey(f.expectation.recipient);
        const ata = tx.instructions[0]!;
        expect(ata.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
        expect([...ata.data]).toEqual([1]);
        expect(ata.keys.map((k) => k.pubkey.toBase58())).toEqual(
          [
            payer,
            getAssociatedTokenAddressSync(mint, recipient),
            recipient,
            mint,
            SystemProgram.programId,
            TOKEN_PROGRAM_ID,
          ].map((k) => k.toBase58()),
        );
        const transfer = decodeTransferCheckedInstruction(tx.instructions[1]!);
        expect(transfer.data.amount).toBe(1000n);
        expect(transfer.data.decimals).toBe(11);
        expect(transfer.keys.owner.pubkey.equals(payer)).toBe(true);
        expect(transfer.keys.source.pubkey.equals(getAssociatedTokenAddressSync(mint, payer))).toBe(
          true,
        );
      } else {
        expect(tx.instructions[0]!.programId.equals(SystemProgram.programId)).toBe(true);
        expect(tx.instructions[0]!.data.readBigUInt64LE(4)).toBe(1000n);
      }
    },
  );
  it.each(['owner', 'decimals', 'initialized'])('refuses ORE mint with wrong %s', async (field) => {
    const f = solanaFixture(true);
    if (field === 'owner') f.mintAccount.value.owner = SystemProgram.programId.toBase58();
    if (field === 'decimals') f.mintAccount.value.data.parsed.info.decimals = 9;
    if (field === 'initialized') f.mintAccount.value.data.parsed.info.isInitialized = false;
    await expect(
      createEconomyChain({ rpc: f.rpc }).preparePayment(f.expectation),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it('redacts an RPC provider error instead of returning endpoint credentials', async () => {
    const f = nearFixture();
    const chain = createEconomyChain({
      rpc: async () => {
        throw new Error('provider-secret');
      },
    });
    await expect(chain.verifyPayment(f.expectation, f.id)).rejects.toMatchObject({
      code: 'CAPABILITY_OFF',
      details: { reason: 'economy_rpc_unavailable', chainId: 'near:mainnet' },
    });
  });
});

describe('Solana finalized payment evidence', () => {
  it.each([false, true])(
    'verifies exact SOL/ORE transfer and stable signed reference (ORE=%s)',
    async (ore) => {
      const f = solanaFixture(ore);
      const result = await createEconomyChain({ rpc: f.rpc }).verifyPayment(
        f.expectation,
        f.signature,
      );
      expect(result).toMatchObject({
        state: 'verified',
        evidence: {
          transactionId: f.signature,
          eventId: `${f.signature}:instruction:0`,
          reference: 'order_123',
          blockTimestampMs: 1_700_000_000_000,
          amountBaseUnits: '1000',
        },
      });
    },
  );
  it('accepts an inner transfer with payer authority and transaction-time ownership evidence', async () => {
    const f = solanaFixture(true);
    const ix = structuredClone(f.transaction.transaction.message.instructions[0]!);
    f.transaction.meta.innerInstructions.push({ index: 0, instructions: [ix] });
    f.transaction.transaction.message.instructions[0]!.programIdIndex = 0;
    expect(
      await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.signature),
    ).toMatchObject({
      state: 'verified',
      evidence: { eventId: `${f.signature}:instruction:0:inner:0` },
    });
  });
  it.each([
    'wrong genesis',
    'failed',
    'wrong memo',
    'unsigned memo',
    'wrong payer',
    'wrong token owner',
    'wrong mint',
    'wrong decimals',
    'wrong delta',
    'missing block signature',
    'slot mismatch',
    'unsafe balance',
    'ambiguous',
  ])('rejects %s', async (attack) => {
    const f = solanaFixture(!['unsafe balance'].includes(attack));
    const msg = f.transaction.transaction.message;
    if (attack === 'wrong genesis') f.results.getGenesisHash = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    if (attack === 'failed') f.transaction.meta.err = { InstructionError: [0, 'Failure'] };
    if (attack === 'wrong memo') msg.instructions[1]!.data = encode58(Buffer.from('another_order'));
    if (attack === 'unsigned memo') msg.instructions[1]!.accounts = [];
    if (attack === 'wrong payer') msg.accountKeys[0] = f.expectation.recipient;
    if (attack === 'wrong token owner')
      f.transaction.meta.postTokenBalances[1]!.owner = f.expectation.payer;
    if (attack === 'wrong mint')
      f.transaction.meta.postTokenBalances[1]!.mint = SystemProgram.programId.toBase58();
    if (attack === 'wrong decimals')
      f.transaction.meta.postTokenBalances[1]!.uiTokenAmount.decimals = 9;
    if (attack === 'wrong delta')
      f.transaction.meta.postTokenBalances[1]!.uiTokenAmount.amount = '2999';
    if (attack === 'missing block signature') f.block.signatures = [];
    if (attack === 'slot mismatch') f.status.slot++;
    if (attack === 'unsafe balance')
      f.transaction.meta.preBalances[0] = Number.MAX_SAFE_INTEGER + 1;
    if (attack === 'ambiguous') msg.instructions.push(structuredClone(msg.instructions[0]!));
    expect(
      (await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.signature)).state,
    ).toBe('rejected');
  });
  it('does not equate a confirmed signature with finality', async () => {
    const f = solanaFixture();
    f.status.confirmationStatus = 'confirmed';
    f.status.confirmations = 3;
    expect(
      await createEconomyChain({ rpc: f.rpc }).verifyPayment(f.expectation, f.signature),
    ).toEqual({ state: 'pending', reason: 'not_finalized' });
  });
  it('accepts a late poll when actual payment block time is in the inclusive order window', async () => {
    const f = solanaFixture();
    const e = { ...f.expectation, notBeforeMs: 1_700_000_000_000, notAfterMs: 1_700_000_000_000 };
    expect((await createEconomyChain({ rpc: f.rpc }).verifyPayment(e, f.signature)).state).toBe(
      'verified',
    );
    expect(
      await createEconomyChain({ rpc: f.rpc }).verifyPayment(
        { ...e, notBeforeMs: e.notBeforeMs + 1, notAfterMs: e.notAfterMs + 1 },
        f.signature,
      ),
    ).toEqual({ state: 'rejected', reason: 'outside_window' });
  });
});
