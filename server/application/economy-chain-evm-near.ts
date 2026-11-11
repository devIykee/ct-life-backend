/**
 * Narrow native-payment adapters: direct WIF transfer on RH, direct NEAR Transfer.
 * General contract calls, delegated senders, bridges and fungible NEAR tokens are
 * deliberately outside this receipt format; they need their own semantic verifier.
 * Sources: ethereum.org/developers/docs/apis/json-rpc/, eips.ethereum.org/EIPS/eip-20,
 * docs.robinhood.com/chain/connecting/, docs.near.org/api/rpc/transactions.
 */
import type {
  EconomyRpc,
  PaymentExpectation,
  PaymentVerification,
  PreparedPayment,
} from './economy-chain.js';
import {
  base58,
  decimal,
  demand,
  evidence,
  hex,
  list,
  object,
  quantity,
  safeInteger,
} from './economy-chain-validation.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function transferData(e: PaymentExpectation): string {
  return `0xa9059cbb${e.recipient.slice(2).padStart(64, '0')}${BigInt(e.amountBaseUnits).toString(16).padStart(64, '0')}`;
}

async function assertNetwork(rpc: EconomyRpc, e: PaymentExpectation): Promise<void> {
  if (e.chainId === 'eip155:4663') {
    demand((await rpc(e.chainId, 'eth_chainId', [])) === '0x1237', 'network_mismatch');
  } else {
    demand(object(await rpc(e.chainId, 'status', [])).chain_id === 'mainnet', 'network_mismatch');
  }
}

/** Build a wallet authorization request only; wallet supplies nonce/gas and signs. */
export async function prepareEvmNearPayment(
  rpc: EconomyRpc,
  e: PaymentExpectation,
): Promise<PreparedPayment> {
  await assertNetwork(rpc, e);
  if (e.chainId === 'eip155:4663') {
    const [code, decimals] = await Promise.all([
      rpc(e.chainId, 'eth_getCode', [e.assetId, 'latest']),
      rpc(e.chainId, 'eth_call', [{ to: e.assetId, data: '0x313ce567' }, 'latest']),
    ]);
    demand(typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(code), 'transfer_mismatch');
    demand(BigInt(hex(decimals, 32)) === 18n, 'transfer_mismatch');
    return {
      kind: 'evm',
      chainId: e.chainId,
      transaction: {
        from: e.payer,
        to: e.assetId,
        data: transferData(e),
        value: '0x0',
        chainId: '0x1237',
      },
    };
  }
  demand(e.chainId === 'near:mainnet', 'unsupported_asset');
  return {
    kind: 'near',
    chainId: e.chainId,
    signerId: e.payer,
    receiverId: e.recipient,
    actions: [{ type: 'Transfer', params: { deposit: e.amountBaseUnits } }],
  };
}

/** Verify actual finalized transfer evidence, not merely transaction existence. */
export async function verifyEvmNearPayment(
  rpc: EconomyRpc,
  e: PaymentExpectation,
  transactionId: string,
): Promise<PaymentVerification> {
  await assertNetwork(rpc, e);
  return e.chainId === 'eip155:4663'
    ? verifyEvm(rpc, e, transactionId)
    : verifyNear(rpc, e, transactionId);
}

async function verifyEvm(
  rpc: EconomyRpc,
  e: PaymentExpectation,
  transactionId: string,
): Promise<PaymentVerification> {
  const id = hex(transactionId, 32);
  const [rawTx, rawReceipt] = await Promise.all([
    rpc(e.chainId, 'eth_getTransactionByHash', [id]),
    rpc(e.chainId, 'eth_getTransactionReceipt', [id]),
  ]);
  if (rawTx === null || rawReceipt === null) return { state: 'pending', reason: 'not_found' };
  const tx = object(rawTx);
  const receipt = object(rawReceipt);
  demand(hex(tx.hash, 32) === id && hex(receipt.transactionHash, 32) === id);
  if (tx.blockHash === null || receipt.blockHash === null)
    return { state: 'pending', reason: 'not_finalized' };
  demand(quantity(receipt.status) === 1n, 'transaction_failed');
  demand(quantity(tx.chainId) === 4663n, 'network_mismatch');
  demand(
    hex(tx.from, 20) === e.payer &&
      hex(receipt.from, 20) === e.payer &&
      hex(tx.to, 20) === e.assetId &&
      hex(receipt.to, 20) === e.assetId,
    'transfer_mismatch',
  );
  demand(quantity(tx.value) === 0n && tx.input === transferData(e), 'transfer_mismatch');
  const blockId = hex(receipt.blockHash, 32);
  const blockHeight = quantity(receipt.blockNumber);
  demand(hex(tx.blockHash, 32) === blockId && quantity(tx.blockNumber) === blockHeight);
  demand(quantity(tx.transactionIndex) === quantity(receipt.transactionIndex));
  const [rawFinal, rawBlock] = await Promise.all([
    rpc(e.chainId, 'eth_getBlockByNumber', ['finalized', false]),
    rpc(e.chainId, 'eth_getBlockByNumber', [receipt.blockNumber, false]),
  ]);
  if (rawFinal === null || rawBlock === null) return { state: 'pending', reason: 'not_finalized' };
  const final = object(rawFinal);
  const block = object(rawBlock);
  if (quantity(final.number) < blockHeight) return { state: 'pending', reason: 'not_finalized' };
  demand(hex(block.hash, 32) === blockId && quantity(block.number) === blockHeight);
  const transactions = list(block.transactions);
  const txIndex = quantity(receipt.transactionIndex);
  demand(txIndex < BigInt(transactions.length) && hex(transactions[Number(txIndex)], 32) === id);
  const timestamp = quantity(block.timestamp) * 1000n;
  demand(timestamp <= BigInt(Number.MAX_SAFE_INTEGER));

  const matching: string[] = [];
  const seenIndices = new Set<string>();
  for (const raw of list(receipt.logs)) {
    const log = object(raw);
    if (hex(log.address, 20) !== e.assetId) continue;
    const topics = list(log.topics);
    if (topics[0] !== TRANSFER_TOPIC) continue;
    demand(topics.length === 3 && log.removed === false);
    demand(
      hex(log.transactionHash, 32) === id &&
        hex(log.blockHash, 32) === blockId &&
        quantity(log.blockNumber) === blockHeight,
    );
    demand(quantity(log.transactionIndex) === txIndex);
    const index = quantity(log.logIndex).toString();
    demand(!seenIndices.has(index));
    seenIndices.add(index);
    const from = hex(topics[1], 32);
    const to = hex(topics[2], 32);
    demand(from.slice(2, 26) === '0'.repeat(24) && to.slice(2, 26) === '0'.repeat(24));
    const amount = BigInt(hex(log.data, 32));
    if (
      `0x${from.slice(26)}` === e.payer &&
      `0x${to.slice(26)}` === e.recipient &&
      amount === BigInt(e.amountBaseUnits)
    )
      matching.push(index);
  }
  demand(matching.length > 0, 'transfer_mismatch');
  demand(matching.length === 1, 'ambiguous_transfer');
  return {
    state: 'verified',
    evidence: evidence(e, {
      transactionId: id,
      eventId: `${id}:log:${matching[0]}`,
      blockId,
      blockHeight: blockHeight.toString(),
      blockTimestampMs: Number(timestamp),
      reference: null,
    }),
  };
}

function nearHash(value: unknown): string {
  base58(value, 32);
  return value as string;
}

async function verifyNear(
  rpc: EconomyRpc,
  e: PaymentExpectation,
  transactionId: string,
): Promise<PaymentVerification> {
  nearHash(transactionId);
  // Poll without blocking the request; accept only FINAL, which includes refund
  // receipt finality (unlike INCLUDED_FINAL or EXECUTED).
  const raw = await rpc(e.chainId, 'tx', {
    tx_hash: transactionId,
    sender_account_id: e.payer,
    wait_until: 'NONE',
  });
  if (raw === null) return { state: 'pending', reason: 'not_found' };
  const result = object(raw);
  if (result.final_execution_status !== 'FINAL') {
    demand(
      ['NONE', 'INCLUDED', 'EXECUTED_OPTIMISTIC', 'INCLUDED_FINAL', 'EXECUTED'].includes(
        String(result.final_execution_status),
      ),
    );
    return { state: 'pending', reason: 'not_finalized' };
  }
  const executionStatus = object(result.status);
  demand(
    Object.keys(executionStatus).length === 1 && typeof executionStatus.SuccessValue === 'string',
    'transaction_failed',
  );
  const tx = object(result.transaction);
  demand(nearHash(tx.hash) === transactionId);
  demand(tx.signer_id === e.payer && tx.receiver_id === e.recipient, 'transfer_mismatch');
  const actions = list(tx.actions);
  demand(actions.length === 1, 'transfer_mismatch');
  const transfer = object(actions[0]);
  demand(Object.keys(transfer).length === 1 && 'Transfer' in transfer, 'transfer_mismatch');
  demand(
    decimal(object(transfer.Transfer).deposit) === BigInt(e.amountBaseUnits),
    'transfer_mismatch',
  );

  const root = object(result.transaction_outcome);
  demand(nearHash(root.id) === transactionId);
  const rootOutcome = object(root.outcome);
  demand(rootOutcome.executor_id === e.payer);
  const rootStatus = object(rootOutcome.status);
  demand(Object.keys(rootStatus).length === 1);
  const paymentReceiptId = nearHash(rootStatus.SuccessReceiptId);
  demand(list(rootOutcome.receipt_ids).includes(paymentReceiptId));
  const receipts = new Map<string, Record<string, unknown>>();
  for (const value of list(result.receipts_outcome)) {
    const receipt = object(value);
    const id = nearHash(receipt.id);
    demand(!receipts.has(id));
    receipts.set(id, receipt);
    const receiptStatus = object(object(receipt.outcome).status);
    demand(
      Object.keys(receiptStatus).length === 1 && typeof receiptStatus.SuccessValue === 'string',
      'transaction_failed',
    );
  }
  // Require all generated outcomes, including refunds, to be present and successful.
  const visited = new Set<string>();
  const pending = [rootOutcome];
  while (pending.length > 0) {
    const outcome = pending.pop()!;
    for (const value of list(outcome.receipt_ids)) {
      const id = nearHash(value);
      demand(!visited.has(id) && receipts.has(id));
      visited.add(id);
      pending.push(object(receipts.get(id)!.outcome));
    }
  }
  demand(visited.size === receipts.size && visited.has(paymentReceiptId));
  const receipt = receipts.get(paymentReceiptId)!;
  demand(object(receipt.outcome).executor_id === e.recipient, 'transfer_mismatch');
  const blockId = nearHash(receipt.block_hash);
  const [rawBlock, rawFinal] = await Promise.all([
    rpc(e.chainId, 'block', { block_id: blockId }),
    rpc(e.chainId, 'block', { finality: 'final' }),
  ]);
  const header = object(object(rawBlock).header);
  const finalHeader = object(object(rawFinal).header);
  demand(
    nearHash(header.hash) === blockId &&
      safeInteger(header.height) &&
      safeInteger(finalHeader.height),
  );
  if (header.height > finalHeader.height) return { state: 'pending', reason: 'not_finalized' };
  const canonical = object(
    object(await rpc(e.chainId, 'block', { block_id: header.height })).header,
  );
  demand(nearHash(canonical.hash) === blockId && canonical.height === header.height);
  const timestamp = decimal(header.timestamp_nanosec) / 1_000_000n;
  demand(timestamp <= BigInt(Number.MAX_SAFE_INTEGER));
  return {
    state: 'verified',
    evidence: evidence(e, {
      transactionId,
      eventId: `${transactionId}:receipt:${paymentReceiptId}:transfer:0`,
      blockId,
      blockHeight: String(header.height),
      blockTimestampMs: Number(timestamp),
      reference: null,
    }),
  };
}
