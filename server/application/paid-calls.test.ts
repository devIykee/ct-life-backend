/**
 * Paid-calls tests.
 *
 * Settlement math is the focus. The other code paths (start,
 * accept, decline, end) hit the DB and LiveKit; for those we
 * unit-test the math directly and use real DB for the happy
 * path that exercises runInTransaction.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let payer: string;
let payee: string;

beforeAll(async () => {
  payer = uuidv7();
  payee = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4)`, [
    payer,
    `pcPayer-${payer}`,
    payee,
    `pcPayee-${payee}`,
  ]);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // The ledger is append-only; we cannot DELETE its rows. We leave
  // them behind — every test uses a unique call_id (uuidv7) and
  // idempotency_ref, so per-call assertions stay isolated.
  await pool.query(
    `DELETE FROM voice_speakers WHERE room_id IN
       (SELECT 'paid_call:' || call_id FROM paid_call_escrow WHERE payer_user_id = $1 OR payee_user_id = $1)`,
    [payer],
  );
  await pool.query(
    `DELETE FROM voice_rooms WHERE room_id IN
       (SELECT 'paid_call:' || call_id FROM paid_call_escrow WHERE payer_user_id = $1 OR payee_user_id = $1)`,
    [payer],
  );
  await pool.query(`DELETE FROM paid_call_escrow WHERE payer_user_id = $1 OR payee_user_id = $1`, [
    payer,
  ]);
});

function makeCtx(): import('./context.js').AppContext {
  const ctx = buildContext();
  // Replace livekit with mocks AFTER buildContext so setParticipantCanPublish
  // does not hit the real LiveKit server (which would 401).
  const livekitMock = {
    mintRtcToken: vi.fn(async () => ({
      token: 't',
      url: 'ws://localhost:7880',
      roomName: 'paid_call:0',
      identity: 'x',
      expiresAt: 0,
      canPublish: true,
    })),
    endRoom: vi.fn(async () => undefined),
    setParticipantCanPublish: vi.fn(async () => undefined),
  };
  Object.defineProperty(ctx, 'livekit', { value: livekitMock, writable: true });
  return ctx;
}

describe('paid-calls settlement math', () => {
  it('computeSettlement rounds minutes up; floor on fee', async () => {
    const { __test } = await import('./paid-calls.js');
    // 5 minutes at 100 cents/min = 500 gross, 5% fee = 25, net 475
    expect(__test.computeSettlement(300, 100)).toEqual({
      minutes: 5,
      gross: 500,
      fee: 25,
      net: 475,
    });
    // 1 second => 1 minute (ceil)
    expect(__test.computeSettlement(1, 100)).toEqual({
      minutes: 1,
      gross: 100,
      fee: 5,
      net: 95,
    });
    // 60 seconds exactly = 1 minute
    expect(__test.computeSettlement(60, 100)).toEqual({
      minutes: 1,
      gross: 100,
      fee: 5,
      net: 95,
    });
    // 61 seconds => 2 minutes
    expect(__test.computeSettlement(61, 100)).toEqual({
      minutes: 2,
      gross: 200,
      fee: 10,
      net: 190,
    });
    // 0 seconds => 0
    expect(__test.computeSettlement(0, 100)).toEqual({
      minutes: 0,
      gross: 0,
      fee: 0,
      net: 0,
    });
    // Fee floors on odd numbers: 99 cents * 5% = 4.95 -> 4
    expect(__test.computeSettlement(60, 99)).toEqual({
      minutes: 1,
      gross: 99,
      fee: 4,
      net: 95,
    });
  });
});

describe('paid-calls lifecycle', () => {
  it('startPaidCall creates a voice_rooms row, escrow pending, returns token', async () => {
    const ctx = makeCtx();
    const { startPaidCall } = await import('./paid-calls.js');
    const out = await startPaidCall(ctx, payer, {
      payeeUserId: payee,
      pricePerMinuteCents: 100,
      maxMinutes: 30,
    });
    expect(out.call.status).toBe('awaiting_payment');
    expect(Number(out.call.totalCents)).toBe(3000);
    expect(out.livekit.token).toBe('t');
    const escrow = await pool.query<{ status: string; total_cents: number }>(
      `SELECT status, total_cents FROM paid_call_escrow WHERE call_id = $1`,
      [out.call.callId],
    );
    expect(escrow.rows[0]?.status).toBe('pending');
    expect(Number(escrow.rows[0]?.total_cents)).toBe(3000);
  });

  it('happy path: submitted -> accept -> end settles the escrow and moves NO Cash', async () => {
    const ctx = makeCtx();
    const { startPaidCall, submitFundingSignature, acceptPaidCall, endPaidCall } =
      await import('./paid-calls.js');
    const cashOf = async (id: string): Promise<number> =>
      Number(
        (
          await pool.query(
            `SELECT COALESCE(SUM(cash_cents),0) AS c FROM balances WHERE user_id = $1`,
            [id],
          )
        ).rows[0].c,
      );
    const before = [await cashOf(payer), await cashOf(payee)];
    const out = await startPaidCall(ctx, payer, {
      payeeUserId: payee,
      pricePerMinuteCents: 100,
      maxMinutes: 30,
    });
    await submitFundingSignature(ctx, out.call.callId, payer, `sig-${uuidv7()}`);
    await acceptPaidCall(ctx, out.call.callId, payee);
    // 5 minutes = 300 seconds
    const final = await endPaidCall(ctx, out.call.callId, payer, 300);
    expect(final.status).toBe('settled');
    expect(Number(final.settledCents)).toBe(500);
    expect(Number(final.creatorAmount)).toBe(475); // paid on-chain in USDC by the escrow program
    // Cash is purchasable but never transferable: the creator's share is on-chain value, not
    // Cash, so neither balance moves and no ledger row is written for the call.
    expect([await cashOf(payer), await cashOf(payee)]).toEqual(before);
    const rows = await pool.query(
      `SELECT 1 FROM ledger_entries WHERE ref_type = 'paid_call' AND ref_id = $1`,
      [out.call.callId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('decline marks escrow refunded', async () => {
    const ctx = makeCtx();
    const { startPaidCall, submitFundingSignature, declinePaidCall } =
      await import('./paid-calls.js');
    const out = await startPaidCall(ctx, payer, {
      payeeUserId: payee,
      pricePerMinuteCents: 100,
      maxMinutes: 10,
    });
    await submitFundingSignature(ctx, out.call.callId, payer, `sig-${uuidv7()}`);
    const after = await declinePaidCall(ctx, out.call.callId, payee);
    expect(after.status).toBe('refunded');
    expect(Number(after.refundAmount)).toBe(1000);
  });

  it('startPaidCall rejects prices outside the allowed range', async () => {
    const ctx = makeCtx();
    const { startPaidCall } = await import('./paid-calls.js');
    await expect(
      startPaidCall(ctx, payer, { payeeUserId: payee, pricePerMinuteCents: 10, maxMinutes: 5 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      startPaidCall(ctx, payer, { payeeUserId: payee, pricePerMinuteCents: 99999, maxMinutes: 5 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('startPaidCall rejects calls to self', async () => {
    const ctx = makeCtx();
    const { startPaidCall } = await import('./paid-calls.js');
    await expect(
      startPaidCall(ctx, payer, { payeeUserId: payer, pricePerMinuteCents: 100, maxMinutes: 5 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('endPaidCall throws ForbiddenError for non-participant', async () => {
    const ctx = makeCtx();
    const other = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      other,
      `pcOutsider-${other}`,
    ]);
    const { startPaidCall, submitFundingSignature, endPaidCall } = await import('./paid-calls.js');
    const out = await startPaidCall(ctx, payer, {
      payeeUserId: payee,
      pricePerMinuteCents: 100,
      maxMinutes: 5,
    });
    await submitFundingSignature(ctx, out.call.callId, payer, `sig-${uuidv7()}`);
    await expect(endPaidCall(ctx, out.call.callId, other, 60)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
