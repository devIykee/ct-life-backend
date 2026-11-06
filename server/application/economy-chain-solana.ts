/**
 * SOL/ORE payments with a payer-signed top-level memo. Decodes binary instructions
 * rather than trusting program log text. Inner transfers are accepted only with
 * exact authority/owner/balance evidence; multiple matching transfers are rejected.
 * Sources: solana.com/docs/rpc/{json-structures,http/gettransaction},
 * solana.com/docs/payments/agentic-payments/x402 (full mainnet genesis hash).
 */
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  ECONOMY_ORE,
  SOLANA_MAINNET_GENESIS,
  type EconomyRpc,
  type PaymentExpectation,
  type PaymentVerification,
  type PreparedPayment,
} from './economy-chain.js';
import {
  base58,
  decimal,
  demand,
  evidence,
  list,
  object,
  safeInteger,
} from './economy-chain-validation.js';

export const ECONOMY_MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const TOKEN_PROGRAM = TOKEN_PROGRAM_ID.toBase58();
const SYSTEM_PROGRAM = SystemProgram.programId.toBase58();

async function assertNetwork(rpc: EconomyRpc): Promise<void> {
  demand(
    (await rpc('solana:mainnet', 'getGenesisHash', [])) === SOLANA_MAINNET_GENESIS,
    'network_mismatch',
  );
}

/** Build an unsigned legacy transaction; never acquire or use a private key. */
export async function prepareSolanaPayment(
  rpc: EconomyRpc,
  e: PaymentExpectation,
): Promise<PreparedPayment> {
  await assertNetwork(rpc);
  const payer = new PublicKey(e.payer);
  const recipient = new PublicKey(e.recipient);
  const tx = new Transaction();
  tx.feePayer = payer;
  if (e.assetId === 'native') {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer,
        toPubkey: recipient,
        lamports: BigInt(e.amountBaseUnits),
      }),
    );
  } else {
    const mint = new PublicKey(ECONOMY_ORE);
    const mintAccount = object(
      object(
        await rpc(e.chainId, 'getAccountInfo', [
          ECONOMY_ORE,
          { encoding: 'jsonParsed', commitment: 'finalized' },
        ]),
      ).value,
    );
    demand(
      mintAccount.owner === TOKEN_PROGRAM && mintAccount.executable === false,
      'transfer_mismatch',
    );
    const mintData = object(mintAccount.data);
    const parsed = object(mintData.parsed);
    const info = object(parsed.info);
    demand(
      mintData.program === 'spl-token' &&
        parsed.type === 'mint' &&
        info.isInitialized === true &&
        info.decimals === 11,
      'transfer_mismatch',
    );
    const source = getAssociatedTokenAddressSync(mint, payer);
    const destination = getAssociatedTokenAddressSync(mint, recipient, true);
    tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, destination, recipient, mint));
    tx.add(
      createTransferCheckedInstruction(
        source,
        mint,
        destination,
        payer,
        BigInt(e.amountBaseUnits),
        11,
      ),
    );
  }
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(ECONOMY_MEMO_PROGRAM),
      keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
      data: Buffer.from(e.reference, 'utf8'),
    }),
  );
  const block = object(
    object(await rpc(e.chainId, 'getLatestBlockhash', [{ commitment: 'finalized' }])).value,
  );
  base58(block.blockhash, 32);
  demand(safeInteger(block.lastValidBlockHeight));
  tx.recentBlockhash = block.blockhash as string;
  return {
    kind: 'solana',
    chainId: 'solana:mainnet',
    transactionBase64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
  };
}

interface Instruction {
  readonly program: string;
  readonly accounts: readonly number[];
  readonly data: Buffer;
  readonly eventId: string;
}

function instruction(value: unknown, keys: readonly string[], eventId: string): Instruction {
  const ix = object(value);
  demand(safeInteger(ix.programIdIndex) && keys[ix.programIdIndex] !== undefined);
  const accounts = list(ix.accounts).map((index) => {
    demand(safeInteger(index) && keys[index] !== undefined);
    return index;
  });
  return { program: keys[ix.programIdIndex]!, accounts, data: base58(ix.data), eventId };
}

function tokenBalance(values: unknown, index: number, owner: string, optional: boolean): bigint {
  const matches = list(values)
    .map(object)
    .filter((b) => b.accountIndex === index);
  if (matches.length === 0 && optional) return 0n;
  demand(matches.length === 1);
  const b = matches[0]!;
  demand(
    b.mint === ECONOMY_ORE && b.owner === owner && b.programId === TOKEN_PROGRAM,
    'transfer_mismatch',
  );
  const amount = object(b.uiTokenAmount);
  demand(amount.decimals === 11, 'transfer_mismatch');
  return decimal(amount.amount);
}

function matchingTransfer(
  ix: Instruction,
  keys: readonly string[],
  meta: Record<string, unknown>,
  e: PaymentExpectation,
): boolean {
  const amount = BigInt(e.amountBaseUnits);
  if (e.assetId === 'native') {
    if (ix.program !== SYSTEM_PROGRAM || ix.data.length !== 12 || ix.data.readUInt32LE(0) !== 2)
      return false;
    if (ix.accounts.length !== 2) return false;
    const [source, destination] = ix.accounts;
    if (
      keys[source!] !== e.payer ||
      keys[destination!] !== e.recipient ||
      ix.data.readBigUInt64LE(4) !== amount
    )
      return false;
    const pre = list(meta.preBalances);
    const post = list(meta.postBalances);
    demand(pre.length === keys.length && post.length === keys.length);
    const before = pre[destination!];
    const after = post[destination!];
    const payerBefore = pre[source!];
    const payerAfter = post[source!];
    demand(
      safeInteger(before) &&
        safeInteger(after) &&
        safeInteger(payerBefore) &&
        safeInteger(payerAfter),
    );
    demand(
      BigInt(after) - BigInt(before) === amount &&
        BigInt(payerBefore) - BigInt(payerAfter) >= amount,
      'transfer_mismatch',
    );
    return true;
  }
  if (ix.program !== TOKEN_PROGRAM) return false;
  const checked = ix.data.length === 10 && ix.data[0] === 12 && ix.accounts.length === 4;
  const unchecked = ix.data.length === 9 && ix.data[0] === 3 && ix.accounts.length === 3;
  if (!checked && !unchecked) return false;
  const source = ix.accounts[0]!;
  const destination = ix.accounts[checked ? 2 : 1]!;
  const authority = ix.accounts[checked ? 3 : 2]!;
  if (keys[authority] !== e.payer || ix.data.readBigUInt64LE(1) !== amount) return false;
  if (checked && (keys[ix.accounts[1]!] !== ECONOMY_ORE || ix.data[9] !== 11)) return false;
  // Check token account ownership from transaction-time metadata, not current RPC
  // account state (which can be reassigned or closed after the payment).
  const sourceBefore = tokenBalance(meta.preTokenBalances, source, e.payer, false);
  const sourceAfter = tokenBalance(meta.postTokenBalances, source, e.payer, false);
  const destinationBefore = tokenBalance(meta.preTokenBalances, destination, e.recipient, true);
  const destinationAfter = tokenBalance(meta.postTokenBalances, destination, e.recipient, false);
  demand(
    sourceBefore - sourceAfter === amount && destinationAfter - destinationBefore === amount,
    'transfer_mismatch',
  );
  return true;
}

/** Read finalized transaction, signed memo, transfer instruction and resulting balances. */
export async function verifySolanaPayment(
  rpc: EconomyRpc,
  e: PaymentExpectation,
  transactionId: string,
): Promise<PaymentVerification> {
  base58(transactionId, 64);
  await assertNetwork(rpc);
  const raw = await rpc(e.chainId, 'getTransaction', [
    transactionId,
    { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
  ]);
  if (raw === null) return { state: 'pending', reason: 'not_found' };
  const tx = object(raw);
  demand(safeInteger(tx.slot) && safeInteger(tx.blockTime));
  const meta = object(tx.meta);
  demand(meta.err === null, 'transaction_failed');
  const transaction = object(tx.transaction);
  const signatures = list(transaction.signatures);
  demand(signatures[0] === transactionId);
  const message = object(transaction.message);
  const staticKeys = list(message.accountKeys).map((key) => {
    base58(key, 32);
    return key as string;
  });
  const header = object(message.header);
  demand(
    safeInteger(header.numRequiredSignatures) &&
      header.numRequiredSignatures > 0 &&
      header.numRequiredSignatures <= staticKeys.length &&
      signatures.length === header.numRequiredSignatures,
  );
  const requiredSignatures = header.numRequiredSignatures;
  for (const signature of signatures) base58(signature, 64);
  const signers = staticKeys.slice(0, header.numRequiredSignatures);
  demand(signers.includes(e.payer), 'transfer_mismatch');
  const loaded =
    meta.loadedAddresses === undefined
      ? { writable: [], readonly: [] }
      : object(meta.loadedAddresses);
  const keys = [...staticKeys, ...list(loaded.writable), ...list(loaded.readonly)].map((key) => {
    base58(key, 32);
    return key as string;
  });
  demand(new Set(keys).size === keys.length);
  const outer = list(message.instructions).map((ix, index) =>
    instruction(ix, keys, `${transactionId}:instruction:${index}`),
  );
  const memos = outer.filter((ix) => ix.program === ECONOMY_MEMO_PROGRAM);
  demand(
    memos.length === 1 &&
      memos[0]!.data.equals(Buffer.from(e.reference, 'utf8')) &&
      memos[0]!.accounts.some((index) => keys[index] === e.payer && index < requiredSignatures),
    'reference_mismatch',
  );
  const all = [...outer];
  const innerIndices = new Set<number>();
  for (const value of list(meta.innerInstructions)) {
    const group = object(value);
    demand(
      safeInteger(group.index) && group.index < outer.length && !innerIndices.has(group.index),
    );
    innerIndices.add(group.index);
    all.push(
      ...list(group.instructions).map((ix, index) =>
        instruction(ix, keys, `${transactionId}:instruction:${group.index}:inner:${index}`),
      ),
    );
  }
  const matching = all.filter((ix) => matchingTransfer(ix, keys, meta, e));
  demand(matching.length > 0, 'transfer_mismatch');
  demand(matching.length === 1, 'ambiguous_transfer');

  const statuses = object(
    await rpc(e.chainId, 'getSignatureStatuses', [
      [transactionId],
      { searchTransactionHistory: true },
    ]),
  );
  const values = list(statuses.value);
  demand(values.length === 1);
  if (values[0] === null) return { state: 'pending', reason: 'not_finalized' };
  const status = object(values[0]);
  demand(status.err === null, 'transaction_failed');
  if (status.confirmationStatus !== 'finalized') {
    demand(status.confirmationStatus === 'processed' || status.confirmationStatus === 'confirmed');
    return { state: 'pending', reason: 'not_finalized' };
  }
  demand(status.slot === tx.slot && status.confirmations === null);
  const block = object(
    await rpc(e.chainId, 'getBlock', [
      tx.slot,
      {
        commitment: 'finalized',
        transactionDetails: 'signatures',
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]),
  );
  base58(block.blockhash, 32);
  demand(
    safeInteger(block.blockHeight) &&
      block.blockTime === tx.blockTime &&
      list(block.signatures).includes(transactionId),
  );
  const timestamp = tx.blockTime * 1000;
  demand(safeInteger(timestamp));
  return {
    state: 'verified',
    evidence: evidence(e, {
      transactionId,
      eventId: matching[0]!.eventId,
      blockId: block.blockhash as string,
      blockHeight: String(block.blockHeight),
      blockTimestampMs: timestamp,
      reference: e.reference,
    }),
  };
}
