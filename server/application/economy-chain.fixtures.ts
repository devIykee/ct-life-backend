import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ECONOMY_ORE,
  ECONOMY_WIF,
  SOLANA_MAINNET_GENESIS,
  type EconomyRpc,
  type PaymentExpectation,
} from './economy-chain.js';
import { ECONOMY_MEMO_PROGRAM } from './economy-chain-solana.js';

const payer = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const hash = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58();

/** Encode deterministic public fixture bytes, including synthetic signatures. */
export function encode58(bytes: Buffer): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(`0x${bytes.toString('hex') || '0'}`);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  let leading = 0;
  while (bytes[leading] === 0) leading++;
  return '1'.repeat(leading) + out;
}

/** Fixture of raw JSON RPC data; it never signs or submits a transaction. */
export function solanaFixture(ore = false) {
  const expectation: PaymentExpectation = {
    chainId: 'solana:mainnet',
    assetId: ore ? ECONOMY_ORE : 'native',
    payer: payer.toBase58(),
    recipient: recipient.toBase58(),
    amountBaseUnits: '1000',
    reference: 'order_123',
    notBeforeMs: 1_699_999_000_000,
    notAfterMs: 1_700_001_000_000,
  };
  const tx = new Transaction({ feePayer: payer, recentBlockhash: hash(3) });
  const mint = new PublicKey(ECONOMY_ORE);
  const source = getAssociatedTokenAddressSync(mint, payer);
  const destination = getAssociatedTokenAddressSync(mint, recipient);
  tx.add(
    ore
      ? createTransferCheckedInstruction(source, mint, destination, payer, 1000n, 11)
      : SystemProgram.transfer({ fromPubkey: payer, toPubkey: recipient, lamports: 1000n }),
  );
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(ECONOMY_MEMO_PROGRAM),
      keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
      data: Buffer.from(expectation.reference),
    }),
  );
  const message = tx.compileMessage();
  const keys = message.accountKeys.map((k) => k.toBase58());
  const signature = encode58(Buffer.alloc(64, 4));
  const pre = keys.map(() => 100_000);
  const post = [...pre];
  post[keys.indexOf(expectation.payer)]! -= 6000;
  if (!ore) post[keys.indexOf(expectation.recipient)]! += 1000;
  const token = (key: PublicKey, owner: PublicKey, amount: string) => ({
    accountIndex: keys.indexOf(key.toBase58()),
    mint: ECONOMY_ORE,
    owner: owner.toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(),
    uiTokenAmount: { amount, decimals: 11 },
  });
  const transaction = {
    slot: 100,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        header: { ...message.header },
        instructions: message.instructions.map((ix) => ({ ...ix, accounts: [...ix.accounts] })),
      },
    },
    meta: {
      err: null as unknown,
      preBalances: pre,
      postBalances: post,
      loadedAddresses: { writable: [] as string[], readonly: [] as string[] },
      innerInstructions: [] as { index: number; instructions: typeof message.instructions }[],
      preTokenBalances: ore
        ? [token(source, payer, '5000'), token(destination, recipient, '2000')]
        : [],
      postTokenBalances: ore
        ? [token(source, payer, '4000'), token(destination, recipient, '3000')]
        : [],
    },
  };
  const status = {
    slot: 100,
    confirmations: null as number | null,
    err: null as unknown,
    confirmationStatus: 'finalized',
  };
  const block = {
    blockhash: hash(5),
    blockHeight: 99,
    blockTime: transaction.blockTime,
    signatures: [signature],
  };
  const mintAccount = {
    value: {
      owner: TOKEN_PROGRAM_ID.toBase58(),
      executable: false,
      data: {
        program: 'spl-token',
        parsed: { type: 'mint', info: { isInitialized: true, decimals: 11 } },
      },
    },
  };
  const results: Record<string, unknown> = {
    getGenesisHash: SOLANA_MAINNET_GENESIS,
    getTransaction: transaction,
    getSignatureStatuses: { value: [status] },
    getBlock: block,
    getAccountInfo: mintAccount,
    getLatestBlockhash: { value: { blockhash: hash(3), lastValidBlockHeight: 150 } },
  };
  const rpc: EconomyRpc = async (_chain, method) => {
    if (!(method in results)) throw new Error(`Unexpected fixture method ${method}`);
    return results[method];
  };
  return { expectation, signature, transaction, status, block, results, rpc, mintAccount };
}

/** One canonical finalized direct ERC20 transfer fixture, without a live provider. */
export function evmFixture() {
  const expectation: PaymentExpectation = {
    chainId: 'eip155:4663',
    assetId: ECONOMY_WIF,
    payer: `0x${'11'.repeat(20)}`,
    recipient: `0x${'22'.repeat(20)}`,
    amountBaseUnits: '1000',
    reference: 'order_123',
    notBeforeMs: 1_699_999_000_000,
    notAfterMs: 1_700_001_000_000,
  };
  const id = `0x${'33'.repeat(32)}`;
  const blockHash = `0x${'44'.repeat(32)}`;
  const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
  const transaction = {
    hash: id,
    from: expectation.payer,
    to: ECONOMY_WIF,
    chainId: '0x1237',
    value: '0x0',
    input: `0xa9059cbb${expectation.recipient.slice(2).padStart(64, '0')}${word(1000n).slice(2)}`,
    blockHash: blockHash as string | null,
    blockNumber: '0x64',
    transactionIndex: '0x0',
  };
  const log = {
    address: ECONOMY_WIF,
    removed: false,
    transactionHash: id,
    blockHash,
    blockNumber: '0x64',
    transactionIndex: '0x0',
    logIndex: '0x1',
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      word(BigInt(expectation.payer)),
      word(BigInt(expectation.recipient)),
    ],
    data: word(1000n),
  };
  const receipt = {
    transactionHash: id,
    from: expectation.payer,
    to: ECONOMY_WIF,
    blockHash: blockHash as string | null,
    blockNumber: '0x64',
    transactionIndex: '0x0',
    status: '0x1',
    logs: [log],
  };
  const block = {
    hash: blockHash,
    number: '0x64',
    timestamp: `0x${(1_700_000_000).toString(16)}`,
    transactions: [id],
  };
  const finalized = { number: '0x65' };
  const results: Record<string, unknown> = {
    eth_chainId: '0x1237',
    eth_getTransactionByHash: transaction,
    eth_getTransactionReceipt: receipt,
    eth_getCode: '0x6000',
    eth_call: word(18n),
  };
  const rpc: EconomyRpc = async (_chain, method, params) => {
    if (method === 'eth_getBlockByNumber')
      return (params as readonly unknown[])[0] === 'finalized' ? finalized : block;
    if (!(method in results)) throw new Error(`Unexpected fixture method ${method}`);
    return results[method];
  };
  return { expectation, id, transaction, receipt, log, block, finalized, results, rpc, word };
}

/** NEAR execution includes both the transfer and its refund receipt outcomes. */
export function nearFixture() {
  const expectation: PaymentExpectation = {
    chainId: 'near:mainnet',
    assetId: 'native',
    payer: 'payer.near',
    recipient: 'merchant.near',
    amountBaseUnits: '1000',
    reference: 'order_123',
    notBeforeMs: 1_699_999_000_000,
    notAfterMs: 1_700_001_000_000,
  };
  const id = hash(10);
  const receiptId = hash(11);
  const refundId = hash(12);
  const blockId = hash(13);
  const outcome = (executor: string, children: string[]) => ({
    executor_id: executor,
    receipt_ids: children,
    status: { SuccessValue: '' } as Record<string, unknown>,
  });
  const payment = {
    id: receiptId,
    block_hash: blockId,
    outcome: outcome(expectation.recipient, [refundId]),
  };
  const refund = { id: refundId, block_hash: blockId, outcome: outcome(expectation.payer, []) };
  const result = {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' } as Record<string, unknown>,
    transaction: {
      hash: id,
      signer_id: expectation.payer,
      receiver_id: expectation.recipient,
      actions: [{ Transfer: { deposit: '1000' } }],
    },
    transaction_outcome: {
      id,
      block_hash: hash(14),
      outcome: {
        executor_id: expectation.payer,
        receipt_ids: [receiptId],
        status: { SuccessReceiptId: receiptId },
      },
    },
    receipts_outcome: [payment, refund],
  };
  const block = {
    header: { hash: blockId, height: 100, timestamp_nanosec: '1700000000000000000' },
  };
  const canonical = structuredClone(block);
  const finalized = { header: { height: 101 } };
  const results: Record<string, unknown> = { status: { chain_id: 'mainnet' }, tx: result };
  const rpc: EconomyRpc = async (_chain, method, params) => {
    if (method === 'block') {
      const p = params as Record<string, unknown>;
      return 'finality' in p ? finalized : typeof p.block_id === 'number' ? canonical : block;
    }
    if (!(method in results)) throw new Error(`Unexpected fixture method ${method}`);
    return results[method];
  };
  return {
    expectation,
    id,
    receiptId,
    result,
    payment,
    refund,
    block,
    canonical,
    finalized,
    results,
    rpc,
  };
}
