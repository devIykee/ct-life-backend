/**
 * Tips: Cash is purchasable but non-transferable. Cash tips are gone (410), and an
 * on-chain tip is only a note about a wallet-to-wallet transfer: it never moves or
 * credits Cash.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { CashNotTransferableError } from '../shared/domain/errors.js';
import { listTipsTo, recordOnchainTip, sendCashTip } from './tips.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let alice: string;
let bob: string;

beforeAll(async () => {
  alice = uuidv7();
  bob = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4)`, [
    alice,
    `tipAlice-${alice}`,
    bob,
    `tipBob-${bob}`,
  ]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents) VALUES ($1, 100000), ($2, 5000)`, [
    alice,
    bob,
  ]);
});

afterAll(async () => {
  await pool.end();
});

const cash = async (id: string): Promise<number> =>
  Number(
    (await pool.query(`SELECT cash_cents FROM balances WHERE user_id = $1`, [id])).rows[0]
      .cash_cents,
  );
const ledgerRows = async (id: string): Promise<number> =>
  Number(
    (await pool.query(`SELECT count(*) AS n FROM ledger_entries WHERE user_id = $1`, [id])).rows[0]
      .n,
  );

describe('Cash tips are gone', () => {
  it('sendCashTip always refuses with CASH_NOT_TRANSFERABLE (410) and moves nothing', () => {
    expect(() => sendCashTip()).toThrow(CashNotTransferableError);
    try {
      sendCashTip();
    } catch (e) {
      expect((e as CashNotTransferableError).code).toBe('CASH_NOT_TRANSFERABLE');
      expect((e as CashNotTransferableError).httpStatus).toBe(410);
    }
  });
});

describe('on-chain tips never touch Cash', () => {
  it('records a pending note and credits nobody', async () => {
    const ctx = buildContext();
    const beforeA = [await cash(alice), await ledgerRows(alice)];
    const beforeB = [await cash(bob), await ledgerRows(bob)];
    const sig = `sig-${uuidv7()}`;
    const tip = await recordOnchainTip(ctx, alice, bob, sig, '1000000', null, 'gm');
    expect(tip).toMatchObject({
      kind: 'onchain',
      status: 'pending',
      signature: sig,
      amountLamports: '1000000',
      amountCents: null,
    });
    expect([await cash(alice), await ledgerRows(alice)]).toEqual(beforeA);
    expect([await cash(bob), await ledgerRows(bob)]).toEqual(beforeB);
    // Nothing flips it to confirmed: no code path verifies it or pays Cash for it.
    expect((await listTipsTo(ctx, bob, 10)).find((t) => t.tipId === tip.tipId)?.status).toBe(
      'pending',
    );
  });

  it('refuses a duplicate signature and a self-tip', async () => {
    const ctx = buildContext();
    const sig = `sig-dup-${uuidv7()}`;
    await recordOnchainTip(ctx, alice, bob, sig, '1000000', null, null);
    await expect(
      recordOnchainTip(ctx, alice, bob, sig, '1000000', null, null),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      recordOnchainTip(ctx, alice, alice, `s-${uuidv7()}`, '5', null, null),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('listTipsTo returns the notes', async () => {
    const ctx = buildContext();
    await recordOnchainTip(ctx, alice, bob, `sig-l-${uuidv7()}`, '7', null, null);
    const list = await listTipsTo(ctx, bob, 10);
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.every((t) => t.toUserId === bob)).toBe(true);
  });
});
