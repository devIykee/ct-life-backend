/** Real isolated receipt persistence with explicit finalized-RPC fixtures; no chain writes. */
import { randomUUID } from 'node:crypto';
import { Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { likenessFixture } from './likeness-test-fixture.js';
import {
  LikenessCheckoutService,
  likenessPrice,
  type LikenessCheckoutConfig,
  type LikenessCheckoutRpc,
} from './likeness-checkout.js';
let f: Awaited<ReturnType<typeof likenessFixture>>,
  owner: string,
  other: string,
  wallet: string,
  cfg: LikenessCheckoutConfig,
  service: LikenessCheckoutService;
let height = 50;
let history: Array<{ signature: string }> = [];
let tx: unknown, rpcCalls: Array<{ method: string; params: unknown[] }>;
const now = new Date('2026-10-11T12:00:00Z');
const rpc: LikenessCheckoutRpc = {
  async rpc<T>(method: string, params: unknown[]) {
    rpcCalls.push({ method, params });
    return (
      method === 'getLatestBlockhash'
        ? {
            value: {
              blockhash: Keypair.generate().publicKey.toBase58(),
              lastValidBlockHeight: 100,
            },
          }
        : method === 'getBlockHeight'
          ? height
          : method === 'getSignaturesForAddress'
            ? history
            : tx
    ) as T;
  },
};
beforeAll(async () => {
  f = await likenessFixture();
});
beforeEach(async () => {
  await f.clear();
  owner = await f.user();
  other = await f.user();
  wallet = Keypair.generate().publicKey.toBase58();
  await f.pool.query('UPDATE users SET wallet=$2 WHERE id=$1', [owner, wallet]);
  await f.pool.query('UPDATE users SET wallet=$2 WHERE id=$1', [
    other,
    Keypair.generate().publicKey.toBase58(),
  ]);
  cfg = {
    enabled: true,
    priceUsdcCents: 300,
    cluster: 'devnet',
    mint: Keypair.generate().publicKey.toBase58(),
    recipient: Keypair.generate().publicKey.toBase58(),
    models: { head_snow: 'human' },
  };
  service = new LikenessCheckoutService(f.db, cfg, rpc, () => now);
  tx = null;
  height = 50;
  history = [];
  rpcCalls = [];
});
afterAll(async () => f.close());
async function quoted() {
  return service.create(owner, randomUUID(), { modelId: 'head_snow' });
}
async function chainFixture(intentId: string) {
  const row = (await f.pool.query('SELECT * FROM likeness_payment_intents WHERE id=$1', [intentId]))
    .rows[0];
  const source = getAssociatedTokenAddressSync(
    new PublicKey(row.mint),
    new PublicKey(row.payer),
  ).toBase58();
  const destination = getAssociatedTokenAddressSync(
    new PublicKey(row.mint),
    new PublicKey(row.recipient),
  ).toBase58();
  return {
    blockTime: Math.floor(now.getTime() / 1000) + 10,
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: row.mint,
          owner: row.recipient,
          uiTokenAmount: { amount: row.amount_base_units, decimals: 6 },
        },
      ],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: row.payer, signer: true },
          { pubkey: row.reference, signer: false },
          { pubkey: destination, signer: false },
        ],
        instructions: [
          {
            programId: TOKEN_PROGRAM_ID.toBase58(),
            parsed: {
              type: 'transferChecked',
              info: {
                source,
                destination,
                authority: row.payer,
                mint: row.mint,
                tokenAmount: { amount: row.amount_base_units, decimals: 6 },
              },
            },
          },
          { programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', parsed: row.memo },
        ],
      },
    },
  };
}
describe('dedicated likeness checkout', () => {
  it('quotes immutable integer USDC and a real unsigned v0 wallet transaction', async () => {
    const key = randomUUID(),
      q = await service.create(owner, key, { modelId: 'head_snow' });
    expect(q).toMatchObject({
      amountBaseUnits: '3000000',
      currency: 'USDC',
      cluster: 'devnet',
      recipient: cfg.recipient,
      mint: cfg.mint,
    });
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(q.transactionBase64, 'base64'),
    );
    expect(transaction.message.staticAccountKeys[0]?.toBase58()).toBe(wallet);
    expect(transaction.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
    const memo = transaction.message.compiledInstructions[2]!;
    expect(memo.accountKeyIndexes).toHaveLength(0);
    const transfer = transaction.message.compiledInstructions[1]!;
    expect(
      transaction.message.staticAccountKeys[transfer.accountKeyIndexes.at(-1)!]!.toBase58(),
    ).toBe(q.reference);
    const changed = new LikenessCheckoutService(
      f.db,
      { ...cfg, priceUsdcCents: 500 },
      rpc,
      () => now,
    );
    expect(await changed.create(owner, key, { modelId: 'head_snow' })).toEqual(q);
    expect((await f.pool.query('SELECT * FROM likeness_payment_intents')).rowCount).toBe(1);
  });
  it('rejects unavailable checkout and client-controlled price or recipient', async () => {
    await expect(
      new LikenessCheckoutService(f.db, { ...cfg, enabled: false }, rpc).create(
        owner,
        randomUUID(),
        { modelId: 'head_snow' },
      ),
    ).rejects.toMatchObject({ code: 'LIKENESS_UNAVAILABLE' });
    await expect(
      service.create(owner, randomUUID(), { modelId: 'head_snow', amount: 1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(rpcCalls).toHaveLength(0);
    expect((await f.pool.query('SELECT * FROM likeness_payment_intents')).rowCount).toBe(0);
  });
  it('signature submission alone does not grant entitlement', async () => {
    const q = await quoted();
    expect(
      await service.submitted(owner, q.intentId, randomUUID(), { signature: '2'.repeat(88) }),
    ).toMatchObject({ status: 'pending', entitlementId: null });
    expect((await f.pool.query('SELECT * FROM likeness_entitlements')).rowCount).toBe(0);
    expect(rpcCalls.at(-1)).toEqual({
      method: 'getTransaction',
      params: [
        '2'.repeat(88),
        { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 },
      ],
    });
  });
  it('issues exactly one entitlement from a finalized exact transfer, including concurrent verification', async () => {
    const q = await quoted();
    await service.submitted(owner, q.intentId, randomUUID(), { signature: '2'.repeat(88) });
    tx = await chainFixture(q.intentId);
    const results = await Promise.all([
      service.get(owner, q.intentId),
      service.get(owner, q.intentId),
    ]);
    expect(results.every((r) => r.status === 'confirmed')).toBe(true);
    expect(results[0]!.entitlementId).toBeTruthy();
    const rows = await f.pool.query('SELECT * FROM likeness_entitlements');
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]).toMatchObject({
      user_id: owner,
      amount_base_units: '3000000',
      currency: 'USDC',
      payment_source: 'solana_devnet',
    });
  });
  it.each([
    'mint',
    'payer',
    'recipient',
    'amount',
    'decimals',
    'memo',
    'reference',
    'failed',
    'late',
  ])('rejects %s mismatches without creating an entitlement', async (kind) => {
    const q = await quoted(),
      raw = await chainFixture(q.intentId),
      info = raw.transaction.message.instructions[0]!.parsed as { info: Record<string, unknown> };
    if (kind === 'mint') info.info.mint = Keypair.generate().publicKey.toBase58();
    if (kind === 'payer') raw.transaction.message.accountKeys[0]!.signer = false;
    if (kind === 'recipient')
      raw.meta.postTokenBalances[0]!.owner = Keypair.generate().publicKey.toBase58();
    if (kind === 'amount') raw.meta.postTokenBalances[0]!.uiTokenAmount.amount = '2999999';
    if (kind === 'decimals') (info.info.tokenAmount as { decimals: number }).decimals = 9;
    if (kind === 'memo') raw.transaction.message.instructions[1]!.parsed = 'other-order';
    if (kind === 'reference')
      raw.transaction.message.accountKeys[1]!.pubkey = Keypair.generate().publicKey.toBase58();
    if (kind === 'failed')
      (raw.meta as { err: unknown }).err = { InstructionError: [0, 'failure'] };
    if (kind === 'late') raw.blockTime += 3600;
    tx = raw;
    expect(
      await service.submitted(owner, q.intentId, randomUUID(), { signature: '2'.repeat(88) }),
    ).toMatchObject({ status: 'manual_review', entitlementId: null });
    expect((await f.pool.query('SELECT * FROM likeness_entitlements')).rowCount).toBe(0);
  });
  it('does not reveal another owner quote or accept its submitted proof', async () => {
    const q = await quoted();
    await expect(service.get(other, q.intentId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.submitted(other, q.intentId, randomUUID(), { signature: '2'.repeat(88) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('does not let an unverified attacker receipt reserve the real payer signature', async () => {
    const victim = await quoted();
    const attacker = await service.create(other, randomUUID(), { modelId: 'head_snow' });
    tx = await chainFixture(victim.intentId);
    expect(
      await service.submitted(other, attacker.intentId, randomUUID(), {
        signature: '2'.repeat(88),
      }),
    ).toMatchObject({ status: 'manual_review', entitlementId: null });
    expect(
      await service.submitted(owner, victim.intentId, randomUUID(), { signature: '2'.repeat(88) }),
    ).toMatchObject({ status: 'confirmed' });
    const grants = await f.pool.query('SELECT user_id FROM likeness_entitlements');
    expect(grants.rows).toEqual([{ user_id: owner }]);
  });
  it('keeps unresolved pending receipts from creating another charge request', async () => {
    await quoted();
    await expect(quoted()).rejects.toMatchObject({
      details: { reason: 'likeness_payment_already_pending' },
    });
  });
  it('can finish receipt verification while new checkout is disabled', async () => {
    const q = await quoted();
    await service.submitted(owner, q.intentId, randomUUID(), { signature: '2'.repeat(88) });
    tx = await chainFixture(q.intentId);
    expect(
      (
        await new LikenessCheckoutService(f.db, { ...cfg, enabled: false }, rpc, () => now).get(
          owner,
          q.intentId,
        )
      ).status,
    ).toBe('confirmed');
  });
  it('does not quote another charge while a verified purchase is still owed', async () => {
    const q = await quoted();
    tx = await chainFixture(q.intentId);
    await service.submitted(owner, q.intentId, randomUUID(), { signature: '2'.repeat(88) });
    await expect(quoted()).rejects.toMatchObject({
      details: { reason: 'likeness_delivery_already_owed' },
    });
    expect(await service.get(owner, q.intentId)).toMatchObject({
      status: 'confirmed',
      resolution: 'delivery_owed',
    });
  });
  it.each(['failed', 'cancelled', 'reconciliation_required'])(
    'durably keeps delivery owed after %s, without charging again',
    async (failure) => {
      const q = await quoted();
      tx = await chainFixture(q.intentId);
      const paid = await service.submitted(owner, q.intentId, randomUUID(), {
        signature: '2'.repeat(88),
      });
      const upload = randomUUID(),
        job = randomUUID();
      await f.pool.query(
        `INSERT INTO likeness_uploads(id,user_id,object_key,content_sha256,content_type,size_bytes,verified_at,expires_at)
      VALUES($1,$2,$3,$4,'image/jpeg',100,$5,$6)`,
        [upload, owner, randomUUID(), 'a'.repeat(64), now, new Date(now.getTime() + 86400000)],
      );
      await f.pool.query(
        `INSERT INTO likeness_jobs(id,user_id,idempotency_key,request_hash,entitlement_id,upload_id,model_id,mode,provider,consent_version,consent_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'head_snow','human','fixture','likeness-v1',$7,$7,$7)`,
        [job, owner, randomUUID(), 'b'.repeat(64), paid.entitlementId, upload, now],
      );
      await f.pool.query('UPDATE likeness_jobs SET status=$2,phase=$3 WHERE id=$1', [
        job,
        failure === 'reconciliation_required' ? 'processing' : failure,
        failure,
      ]);
      expect(
        (
          await f.pool.query('SELECT fulfillment_status FROM likeness_entitlements WHERE id=$1', [
            paid.entitlementId,
          ])
        ).rows[0].fulfillment_status,
      ).toBe('manual_review');
      expect(
        (
          await f.pool.query('SELECT status FROM likeness_payment_intents WHERE id=$1', [
            q.intentId,
          ])
        ).rows[0].status,
      ).toBe('manual_review');
      expect(await service.get(owner, q.intentId)).toMatchObject({
        status: 'manual_review',
        resolution: 'delivery_owed',
        entitlementId: paid.entitlementId,
      });
      await expect(quoted()).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await f.pool.query('SELECT * FROM likeness_entitlements')).rowCount).toBe(1);
    },
  );
  it('recovers an on-chain payment after app termination before signature submission', async () => {
    const q = await quoted();
    tx = await chainFixture(q.intentId);
    history = [{ signature: '2'.repeat(88) }];
    height = 101;
    const resumed = await service.current(owner);
    expect(resumed.checkout).toMatchObject({ intentId: q.intentId, status: 'confirmed' });
    expect((await f.pool.query('SELECT * FROM likeness_entitlements')).rowCount).toBe(1);
    await expect(quoted()).rejects.toMatchObject({
      details: { reason: 'likeness_delivery_already_owed' },
    });
    expect(rpcCalls.find((c) => c.method === 'getBlockHeight')?.params).toEqual([
      { commitment: 'finalized' },
    ]);
    expect(rpcCalls.find((c) => c.method === 'getSignaturesForAddress')?.params).toEqual([
      q.reference,
      { commitment: 'finalized', limit: 20 },
    ]);
  });
  it('does not expire an unsigned intent on wall-clock timeout while its blockhash can still land', async () => {
    const q = await quoted();
    const later = new LikenessCheckoutService(
      f.db,
      cfg,
      rpc,
      () => new Date(now.getTime() + 3600000),
    );
    expect(await later.get(owner, q.intentId)).toMatchObject({ status: 'pending' });
    await expect(later.create(owner, randomUUID(), { modelId: 'head_snow' })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    );
    height = 101;
    expect(await later.get(owner, q.intentId)).toMatchObject({ status: 'expired' });
    expect(await later.create(owner, randomUUID(), { modelId: 'head_snow' })).toMatchObject({
      amountBaseUnits: '3000000',
    });
  });
  it('does not interpret fractional/negative/unapproved prices as enabled retail prices', () => {
    expect(likenessPrice(300)).toEqual({ amount: '3.00', currency: 'USDC', display: '3.00 USDC' });
    for (const price of [0, -1, 300.5, Infinity, NaN]) expect(likenessPrice(price)).toBeNull();
  });
});
