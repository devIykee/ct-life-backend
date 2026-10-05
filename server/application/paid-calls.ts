/**
 * Paid calls service.
 *
 * Endpoints:
 *
 *   POST /v1/paid-calls              — start a paid call (creates
 *                                       voice_rooms row kind='paid_call'
 *                                       + paid_call_escrow row pending)
 *   POST /v1/paid-calls/{id}/submitted — caller posts the funding
 *                                       tx signature; escrow -> active
 *   POST /v1/paid-calls/{id}/accept  — payee accepts the incoming call
 *   POST /v1/paid-calls/{id}/decline — payee declines; escrow -> refunded
 *   POST /v1/paid-calls/{id}/end     — either side ends; computes
 *                                       settled_cents and writes a
 *                                       'tip' ledger row (creator
 *                                       share) and 'fee' ledger row
 *                                       (5% platform fee)
 *   GET  /v1/paid-calls/{id}         — return the call + escrow state
 *
 * Settlement math (server-authoritative):
 *
 *   minutes = ceil(seconds / 60)
 *   gross = minutes * pricePerMinuteCents
 *   fee   = floor(gross * 5 / 100)         # 5% protocol fee, integer cents
 *   net   = gross - fee
 *
 * The caller cannot publish until escrow is 'active'. Once
 * accepted, both sides can publish. End closes the LiveKit room.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export const PLATFORM_FEE_BPS = 500; // 5%

export type PaidCallStatus = 'awaiting_payment' | 'ringing' | 'live' | 'settled' | 'refunded';

export interface PaidCallRow {
  readonly callId: string;
  readonly payerUserId: string;
  readonly payeeUserId: string;
  readonly pricePerMinuteCents: number;
  readonly totalCents: number;
  readonly settledCents: number;
  readonly status: PaidCallStatus;
  readonly settlementTxSignature: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutesUsed: number;
  readonly creatorAmount: number;
  readonly refundAmount: number;
}

export interface StartPaidCallArgs {
  readonly payeeUserId: string;
  readonly pricePerMinuteCents: number;
  readonly maxMinutes: number;
}

const PRICE_MIN = 25; // 0.25 USDC in cents
const PRICE_MAX = 5000; // 50 USDC in cents

function computeSettlement(
  seconds: number,
  pricePerMinuteCents: number,
): { minutes: number; gross: number; fee: number; net: number } {
  const minutes = seconds > 0 ? Math.ceil(seconds / 60) : 0;
  const gross = minutes * pricePerMinuteCents;
  // Floor the fee; the creator gets whatever is left.
  const fee = Math.floor((gross * PLATFORM_FEE_BPS) / 10_000);
  const net = gross - fee;
  return { minutes, gross, fee, net };
}

/** Start a paid call. Returns the call id + the LiveKit URL + token. */
export async function startPaidCall(
  ctx: AppContext,
  payerUserId: string,
  args: StartPaidCallArgs,
): Promise<{ call: PaidCallRow; livekit: { token: string; url: string; roomName: string } }> {
  if (args.pricePerMinuteCents < PRICE_MIN || args.pricePerMinuteCents > PRICE_MAX) {
    throw new ValidationFailedError({
      reason: `pricePerMinuteCents ${PRICE_MIN}..${PRICE_MAX}`,
    });
  }
  if (args.maxMinutes < 1 || args.maxMinutes > 240) {
    throw new ValidationFailedError({ reason: 'maxMinutes 1..240' });
  }
  if (args.payeeUserId === payerUserId) {
    throw new ValidationFailedError({ reason: 'cannot call self' });
  }
  const callId = uuidv7();
  const roomId = `paid_call:${callId}`;
  const totalCents = args.pricePerMinuteCents * args.maxMinutes;
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO voice_rooms
         (room_id, host_user_id, kind, title, max_speakers, requires_payment, price_per_minute_cents)
       VALUES ($1, $2, 'paid_call', $3, 2, true, $4)`,
      [roomId, payerUserId, `paid call ${callId.slice(0, 8)}`, args.pricePerMinuteCents],
    );
    await client.query(
      `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
       VALUES ($1, $2, $3, 'host')`,
      [uuidv7(), roomId, payerUserId],
    );
    // The payee joins after accept. We create a placeholder row so
    // a UNIQUE check on (room_id, user_id) doesn't fail when they
    // accept.
    await client.query(
      `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
       VALUES ($1, $2, $3, 'listener')`,
      [uuidv7(), roomId, args.payeeUserId],
    );
    await client.query(
      `INSERT INTO paid_call_escrow
         (escrow_id, call_id, payer_user_id, payee_user_id, total_cents)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv7(), callId, payerUserId, args.payeeUserId, totalCents],
    );
  });
  const t = await ctx.livekit.mintRtcToken({
    userId: payerUserId,
    kind: 'paid_call',
    id: callId,
    // Until escrow is 'active', caller is listener. They can't
    // publish; they wait for the funding to land.
    canPublish: false,
  });
  return {
    call: {
      callId,
      payerUserId,
      payeeUserId: args.payeeUserId,
      pricePerMinuteCents: args.pricePerMinuteCents,
      totalCents,
      settledCents: 0,
      status: 'awaiting_payment',
      settlementTxSignature: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      minutesUsed: 0,
      creatorAmount: 0,
      refundAmount: totalCents,
    },
    livekit: { token: t.token, url: t.url, roomName: t.roomName },
  };
}

/** Caller posts the funding tx signature. */
export async function submitFundingSignature(
  ctx: AppContext,
  callId: string,
  callerUserId: string,
  signature: string,
): Promise<PaidCallRow> {
  await runInTransaction(async (client) => {
    const r = await client.query<{
      payer_user_id: string;
      payee_user_id: string;
      status: string;
    }>(
      `SELECT payer_user_id, payee_user_id, status FROM paid_call_escrow WHERE call_id = $1::uuid`,
      [callId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError({ resource: 'paid_call', id: callId });
    if (row.payer_user_id !== callerUserId) {
      throw new ForbiddenError({ reason: 'NOT_PAYER' });
    }
    if (row.status !== 'pending') {
      throw new ValidationFailedError({ reason: 'escrow not pending' });
    }
    try {
      await client.query(
        `UPDATE paid_call_escrow
         SET status = 'active', settlement_tx_signature = $1
         WHERE call_id = $2::uuid AND status = 'pending'`,
        [signature, callId],
      );
    } catch (e) {
      // 23505 = duplicate signature (already credited).
      if ((e as { code?: string }).code === '23505') {
        throw new ValidationFailedError({ reason: 'signature already used' });
      }
      throw e;
    }
  });
  // Promote the caller to canPublish so they can speak on the call.
  try {
    await ctx.livekit.setParticipantCanPublish(ctx, {
      kind: 'paid_call',
      id: callId,
      identity: callerUserId,
      canPublish: true,
    });
  } catch {
    /* best-effort */
  }
  return loadPaidCall(ctx, callId);
}

/** Payee accepts the call. */
export async function acceptPaidCall(
  ctx: AppContext,
  callId: string,
  callerUserId: string,
): Promise<PaidCallRow> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ payee_user_id: string; status: string }>(
      `SELECT payee_user_id, status FROM paid_call_escrow WHERE call_id = $1::uuid`,
      [callId],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'paid_call', id: callId });
  if (row.payee_user_id !== callerUserId) {
    throw new ForbiddenError({ reason: 'NOT_PAYEE' });
  }
  if (row.status !== 'active') {
    throw new ValidationFailedError({ reason: 'escrow not active' });
  }
  // Promote payee.
  try {
    await ctx.livekit.setParticipantCanPublish(ctx, {
      kind: 'paid_call',
      id: callId,
      identity: callerUserId,
      canPublish: true,
    });
  } catch {
    /* best-effort */
  }
  return loadPaidCall(ctx, callId);
}

/** Payee declines; escrow is refunded. */
export async function declinePaidCall(
  ctx: AppContext,
  callId: string,
  callerUserId: string,
): Promise<PaidCallRow> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ payee_user_id: string; status: string }>(
      `SELECT payee_user_id, status FROM paid_call_escrow WHERE call_id = $1::uuid`,
      [callId],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'paid_call', id: callId });
  if (row.payee_user_id !== callerUserId && row.status !== 'pending') {
    throw new ForbiddenError({ reason: 'NOT_PAYEE' });
  }
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `UPDATE paid_call_escrow SET status = 'refunded', ended_at = now()
       WHERE call_id = $1::uuid AND status IN ('pending', 'active')`,
      [callId],
    );
  });
  try {
    await ctx.livekit.endRoom(ctx, { kind: 'paid_call', id: callId });
  } catch {
    /* best-effort */
  }
  return loadPaidCall(ctx, callId);
}

/**
 * Either side ends the call. Computes settled_cents, writes a
 * 'tip' ledger row (creator share) and a 'fee' ledger row (5%).
 * Marks the escrow 'settled'.
 */
export async function endPaidCall(
  ctx: AppContext,
  callId: string,
  callerUserId: string,
  secondsUsed: number,
): Promise<PaidCallRow> {
  const loaded = await ctx.db.withConnection(async (c) => {
    return c.query<{
      payer_user_id: string;
      payee_user_id: string;
      status: string;
      price_per_minute_cents: number;
      total_cents: string;
      started_at: Date;
    }>(
      `SELECT ec.payer_user_id, ec.payee_user_id, ec.status, vr.price_per_minute_cents, ec.total_cents, ec.started_at
       FROM paid_call_escrow ec
       JOIN voice_rooms vr ON vr.room_id = $1
       WHERE ec.call_id = $2::uuid`,
      [`paid_call:${callId}`, callId],
    );
  });
  const row = loaded.rows[0];
  if (!row) throw new NotFoundError({ resource: 'paid_call', id: callId });
  if (row.payer_user_id !== callerUserId && row.payee_user_id !== callerUserId) {
    throw new ForbiddenError({ reason: 'NOT_PARTICIPANT' });
  }
  if (row.status !== 'active') {
    throw new ValidationFailedError({ reason: 'escrow not active' });
  }
  if (secondsUsed < 0) {
    throw new ValidationFailedError({ reason: 'secondsUsed must be >= 0' });
  }
  const r = computeSettlement(secondsUsed, row.price_per_minute_cents);
  await runInTransaction(async (client) => {
    await client.query(
      `UPDATE paid_call_escrow
         SET status = 'settled', settled_cents = $1, ended_at = now()
       WHERE call_id = $2::uuid`,
      [r.gross, callId],
    );
    if (r.net > 0) {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
        [row.payee_user_id, r.net],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'tip', 'paid_call', $3, $4)`,
        [row.payee_user_id, r.net, callId, `paid-call-creator:${callId}`],
      );
    }
    if (r.fee > 0) {
      // Fee is a separate ledger row; the recipient is the
      // treasury user_id (the system itself). We model it as a
      // 'fee' reason ledger row; the balance upsert uses a
      // sentinel treasury user that the operator provisions.
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'fee', 'paid_call', $3, $4)`,
        [row.payer_user_id, -r.fee, callId, `paid-call-fee:${callId}`],
      );
    }
    await client.query(
      `UPDATE voice_rooms SET status = 'ended', ended_at = now()
       WHERE room_id = $1`,
      [`paid_call:${callId}`],
    );
    await client.query(
      `UPDATE voice_speakers SET left_at = now()
       WHERE room_id = $1 AND left_at IS NULL`,
      [`paid_call:${callId}`],
    );
  });
  try {
    await ctx.livekit.endRoom(ctx, { kind: 'paid_call', id: callId });
  } catch {
    /* best-effort */
  }
  return loadPaidCall(ctx, callId);
}

/**
 *
 */
export async function loadPaidCall(ctx: AppContext, callId: string): Promise<PaidCallRow> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      call_id: string;
      payer_user_id: string;
      payee_user_id: string;
      total_cents: number;
      settled_cents: number;
      status: string;
      settlement_tx_signature: string | null;
      started_at: Date;
      ended_at: Date | null;
      price_per_minute_cents: number;
    }>(
      `SELECT ec.call_id, ec.payer_user_id, ec.payee_user_id, ec.total_cents,
              ec.settled_cents, ec.status, ec.settlement_tx_signature,
              ec.started_at, ec.ended_at, vr.price_per_minute_cents
       FROM paid_call_escrow ec
       JOIN voice_rooms vr ON vr.room_id = $1
       WHERE ec.call_id = $2::uuid`,
      [`paid_call:${callId}`, callId],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'paid_call', id: callId });
  // Compute minutes from settled_cents: minutes = settled / price.
  const minutes =
    row.price_per_minute_cents > 0 ? row.settled_cents / row.price_per_minute_cents : 0;
  const settlement = computeSettlement(minutes * 60, row.price_per_minute_cents);
  const status: PaidCallStatus = mapStatus(row.status);
  return {
    callId: row.call_id,
    payerUserId: row.payer_user_id,
    payeeUserId: row.payee_user_id,
    pricePerMinuteCents: row.price_per_minute_cents,
    totalCents: row.total_cents,
    settledCents: row.settled_cents,
    status,
    settlementTxSignature: row.settlement_tx_signature,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    minutesUsed: settlement.minutes,
    creatorAmount: settlement.net,
    refundAmount: status === 'refunded' ? row.total_cents : row.total_cents - row.settled_cents,
  };
}

function mapStatus(s: string): PaidCallStatus {
  switch (s) {
    case 'pending':
      return 'awaiting_payment';
    case 'active':
      return 'live';
    case 'settled':
      return 'settled';
    case 'refunded':
      return 'refunded';
    default:
      return 'live';
  }
}

// Exported for tests.
export const __test = { computeSettlement };
