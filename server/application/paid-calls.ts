/**
 * Paid calls on the ct_escrow program (unlock C2; capability `paidCalls`, devnet only).
 *
 *   POST /v1/paid-calls {creatorId, minutes}  server builds the fan's open_session tx
 *   POST /v1/paid-calls/:id/submitted {sig}   verify the Session account, ring the creator
 *   POST /v1/paid-calls/:id/accept            creator: the settle authority sends accept
 *   POST /v1/paid-calls/:id/decline           creator declines (or the fan cancels)
 *   POST /v1/paid-calls/:id/end               either side; the server times the call
 *   GET  /v1/paid-calls/:id                   either side
 *
 * Money (USDC base units, on chain only; no Cash ever moves, docs/ECONOMY.md):
 *   deposit = rate x minutes x (1 + fee_bps/10000), held in the session's vault.
 *   settle(seconds): creator gets rate x ceil(seconds/60); the treasury fee is on top;
 *   the fan gets the rest back. The server, never the client, decides `seconds`: from
 *   the accept to the end, capped at the booked minutes.
 *
 * Timing: the creator must accept within the escrow's accept window (120 s from the
 * open, read from chain). Unanswered and declined calls are refunded by the worker
 * (server/workers/paid-calls.ts) as soon as the program allows it (after the window).
 * A live call that reaches its booked minutes is ended and settled by the worker.
 *
 * Size: over the 300-line soft limit on purpose; it is one state machine (book, fund,
 * ring, accept, end, refund, sweep) and splitting it would scatter the transitions.
 *
 * State changes are single conditional UPDATEs (`WHERE status = ...`), and a chain
 * transaction is sent only after the row was claimed, so a retry never sends twice.
 */
import type { AppContext } from './context.js';
import { assertCapabilityOn } from './capabilities.js';
import { assertDevnetChain } from './chain-rpc.js';
import { creatorTerms } from './creator.js';
import { escrowChain, type SessionRef } from './paid-call-chain.js';
import { publishToUser } from './realtime-bus.js';
import { PAID_CALL_PAIR_COOLDOWN_DAYS, recordQuestEvent } from './quests.js';
import {
  BlockedError,
  ConflictError,
  CreatorUnavailableError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { computeDeposit, sessionPda, settlementSplit } from '../shared/solana/ct-escrow.js';
import { PublicKey } from '@solana/web3.js';

export type PaidCallStatus =
  | 'awaiting_payment'
  | 'ringing'
  | 'live'
  | 'settling'
  | 'settled'
  | 'refunding'
  | 'refunded'
  | 'expired';

/** Seconds a fan has to sign and send the open_session transaction. */
export const PAY_WINDOW_SEC = 120;
/** Accept this long before the on-chain window closes, so the tx lands in time. */
const ACCEPT_MARGIN_SEC = 5;

export interface PaidCallRow {
  readonly callId: string;
  readonly fanUserId: string;
  readonly creatorUserId: string;
  readonly status: PaidCallStatus;
  readonly ratePerMinUsdc: string;
  readonly maxMinutes: number;
  readonly deposit: string;
  readonly feeBps: number;
  readonly sessionPda: string;
  readonly payBy: string;
  readonly acceptBy: string | null;
  readonly acceptedAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly minutesUsed: number | null;
  readonly creatorAmount: string | null;
  readonly feeAmount: string | null;
  readonly refundAmount: string | null;
  readonly signatures: {
    readonly open: string | null;
    readonly accept: string | null;
    readonly settle: string | null;
    readonly refund: string | null;
  };
}

interface DbRow {
  call_id: string;
  fan_user_id: string;
  creator_user_id: string;
  fan_wallet: string;
  creator_wallet: string;
  session_id: string;
  session_pda: string;
  rate_per_min: string;
  max_minutes: number;
  fee_bps: number;
  deposit: string;
  status: PaidCallStatus;
  end_reason: string | null;
  open_signature: string | null;
  accept_signature: string | null;
  settle_signature: string | null;
  refund_signature: string | null;
  opened_at: Date | null;
  accept_by: Date | null;
  accepted_at: Date | null;
  ended_at: Date | null;
  seconds_used: number | null;
  minutes_used: number | null;
  creator_amount: string | null;
  fee_amount: string | null;
  refund_amount: string | null;
  pay_by: Date;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const str = (v: string | null): string | null => (v === null ? null : String(v));
const realSig = (s: string | null): string | null => (s && !s.startsWith('pending:') ? s : null);

function toRow(r: DbRow): PaidCallRow {
  return {
    callId: r.call_id,
    fanUserId: r.fan_user_id,
    creatorUserId: r.creator_user_id,
    status: r.status,
    ratePerMinUsdc: String(r.rate_per_min),
    maxMinutes: Number(r.max_minutes),
    deposit: String(r.deposit),
    feeBps: Number(r.fee_bps),
    sessionPda: r.session_pda,
    payBy: r.pay_by.toISOString(),
    acceptBy: iso(r.accept_by),
    acceptedAt: iso(r.accepted_at),
    endedAt: iso(r.ended_at),
    endReason: r.end_reason,
    minutesUsed: r.minutes_used === null ? null : Number(r.minutes_used),
    creatorAmount: str(r.creator_amount),
    feeAmount: str(r.fee_amount),
    refundAmount: str(r.refund_amount),
    signatures: {
      open: r.open_signature,
      accept: realSig(r.accept_signature),
      settle: realSig(r.settle_signature),
      refund: realSig(r.refund_signature),
    },
  };
}

function ref(r: DbRow): SessionRef {
  return { fan: r.fan_wallet, creator: r.creator_wallet, sessionId: BigInt(r.session_id) };
}

async function load(ctx: AppContext, callId: string): Promise<DbRow> {
  const r = await ctx.db.withConnection((c) =>
    c.query<DbRow>('SELECT * FROM paid_calls WHERE call_id = $1', [callId]),
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'paid_call', id: callId });
  return row;
}

/** Run one conditional UPDATE; returns the updated row or null when the guard failed. */
async function transition(ctx: AppContext, sql: string, params: unknown[]): Promise<DbRow | null> {
  const r = await ctx.db.withConnection((c) => c.query<DbRow>(sql, params));
  return r.rows[0] ?? null;
}

function guardOn(ctx: AppContext): void {
  assertCapabilityOn(ctx, 'paidCalls');
  assertDevnetChain(ctx, 'paidCalls');
}

/** A session id that is unique per (fan, creator): ms timestamp + 16 random bits. */
function newSessionId(): bigint {
  const hex = uuidv7().replace(/-/g, '').slice(0, 16);
  return BigInt(`0x${hex}`) & 0x7fffffffffffffffn;
}

export interface StartPaidCallResult {
  readonly callId: string;
  readonly sessionPda: string;
  /** Unsigned v0 transaction (fan is the fee payer), base64. */
  readonly tx: string;
  /** The deposit in USDC base units: rate x minutes x (1 + feeBps/10000). */
  readonly amount: string;
  readonly feeBps: number;
  readonly ratePerMinUsdc: string;
  readonly minutes: number;
  /** Sign and send before this, then POST /submitted. */
  readonly expiresAt: string;
}

/**
 * Book a paid call: look up the creator's rate, build the fan's unsigned open_session
 * transaction. Nothing is on chain until the fan's wallet sends it.
 */
export async function startPaidCall(
  ctx: AppContext,
  fanUserId: string,
  args: { creatorId: string; minutes: number },
): Promise<StartPaidCallResult> {
  guardOn(ctx);
  if (args.creatorId === fanUserId) throw new ValidationFailedError({ reason: 'cannot_call_self' });
  const terms = await creatorTerms(ctx, args.creatorId);
  if (terms === null || !terms.enabled) {
    throw new CreatorUnavailableError({ creatorId: args.creatorId });
  }
  if (!Number.isInteger(args.minutes) || args.minutes < 1 || args.minutes > terms.maxMinutes) {
    throw new ValidationFailedError({ reason: 'minutes_over_max', max: terms.maxMinutes });
  }
  const fan = await ctx.db.withConnection(async (c) => {
    const b = await c.query(
      `SELECT 1 FROM blocks WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
          OR (blocker_user_id = $2 AND blocked_user_id = $1) LIMIT 1`,
      [fanUserId, args.creatorId],
    );
    if ((b.rowCount ?? 0) > 0) throw new BlockedError({});
    const u = await c.query<{ wallet: string }>('SELECT wallet FROM users WHERE id = $1', [
      fanUserId,
    ]);
    return u.rows[0]?.wallet;
  });
  if (fan === undefined) throw new NotFoundError({ kind: 'user', id: fanUserId });
  try {
    new PublicKey(fan);
  } catch {
    throw new ValidationFailedError({ reason: 'wallet_not_a_pubkey' });
  }
  const cfg = await escrowChain().config(ctx);
  await expireStaleAwaiting(ctx, fanUserId);

  const callId = uuidv7();
  const sessionId = newSessionId();
  const rate = BigInt(terms.ratePerMinUsdc);
  const deposit = computeDeposit(rate, args.minutes, cfg.feeBps);
  const pda = sessionPda(new PublicKey(fan), new PublicKey(terms.payoutWallet), sessionId);
  const tx = await escrowChain().buildOpen(ctx, {
    fan,
    creator: terms.payoutWallet,
    sessionId,
    ratePerMin: rate,
    maxMinutes: args.minutes,
    usdcMint: cfg.usdcMint,
  });
  const payBy = new Date(Date.now() + PAY_WINDOW_SEC * 1000);
  try {
    await ctx.db.withConnection((c) =>
      c.query(
        `INSERT INTO paid_calls (call_id, fan_user_id, creator_user_id, fan_wallet, creator_wallet,
           session_id, session_pda, rate_per_min, max_minutes, fee_bps, deposit, pay_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          callId,
          fanUserId,
          args.creatorId,
          fan,
          terms.payoutWallet,
          sessionId.toString(),
          pda.toBase58(),
          rate.toString(),
          args.minutes,
          cfg.feeBps,
          deposit.toString(),
          payBy,
        ],
      ),
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new ConflictError({ reason: 'call_in_progress' });
    }
    throw e;
  }
  return {
    callId,
    sessionPda: pda.toBase58(),
    tx,
    amount: deposit.toString(),
    feeBps: cfg.feeBps,
    ratePerMinUsdc: rate.toString(),
    minutes: args.minutes,
    expiresAt: payBy.toISOString(),
  };
}

/** A fan's own unpaid call past its pay window with nothing on chain is dropped. */
async function expireStaleAwaiting(ctx: AppContext, fanUserId: string): Promise<void> {
  const r = await ctx.db.withConnection((c) =>
    c.query<DbRow>(
      `SELECT * FROM paid_calls
        WHERE fan_user_id = $1 AND status = 'awaiting_payment' AND pay_by < now()`,
      [fanUserId],
    ),
  );
  for (const row of r.rows) await resolveUnpaid(ctx, row);
}

/** Unpaid past its window: expired if nothing is on chain, else refunded once allowed. */
async function resolveUnpaid(ctx: AppContext, row: DbRow): Promise<void> {
  const s = await escrowChain().session(ctx, ref(row));
  if (s === null) {
    await transition(
      ctx,
      `UPDATE paid_calls SET status = 'expired', end_reason = 'not_paid', ended_at = now()
        WHERE call_id = $1 AND status = 'awaiting_payment' RETURNING *`,
      [row.call_id],
    );
    return;
  }
  const cfg = await escrowChain().config(ctx);
  const openedAt = new Date(Number(s.openedAt) * 1000);
  await transition(
    ctx,
    `UPDATE paid_calls SET status = 'refunding', end_reason = 'paid_late', opened_at = $2,
            accept_by = $3, ended_at = now()
      WHERE call_id = $1 AND status = 'awaiting_payment' RETURNING *`,
    [row.call_id, openedAt, new Date(openedAt.getTime() + cfg.acceptWindowSecs * 1000)],
  );
}

/**
 * The fan reports the open_session signature. The Session account on chain must exist
 * and match this call exactly (fan, creator, session id, rate, minutes, deposit, Open);
 * then the creator is rung. Idempotent for the same call.
 *
 * @throws ConflictError `not_found_yet` (retry in a second or two).
 * @throws ValidationFailedError `tx_mismatch` when the Session differs.
 */
export async function submitOpenSignature(
  ctx: AppContext,
  callId: string,
  fanUserId: string,
  signature: string,
): Promise<PaidCallRow> {
  guardOn(ctx);
  const row = await load(ctx, callId);
  if (row.fan_user_id !== fanUserId) throw new ForbiddenError({ reason: 'not_fan' });
  if (row.status !== 'awaiting_payment') return toRow(row);
  const s = await escrowChain().session(ctx, ref(row));
  if (s === null) throw new ConflictError({ reason: 'not_found_yet' });
  const matches =
    s.fan === row.fan_wallet &&
    s.creator === row.creator_wallet &&
    s.sessionId === BigInt(row.session_id) &&
    s.ratePerMin === BigInt(row.rate_per_min) &&
    s.maxMinutes === Number(row.max_minutes) &&
    s.deposit === BigInt(row.deposit) &&
    s.status === 0;
  if (!matches) throw new ValidationFailedError({ reason: 'tx_mismatch' });
  const cfg = await escrowChain().config(ctx);
  const openedAt = new Date(Number(s.openedAt) * 1000);
  const acceptBy = new Date(openedAt.getTime() + (cfg.acceptWindowSecs - ACCEPT_MARGIN_SEC) * 1000);
  let updated: DbRow | null;
  try {
    updated = await transition(
      ctx,
      `UPDATE paid_calls SET status = 'ringing', open_signature = $2, opened_at = $3, accept_by = $4
        WHERE call_id = $1 AND status = 'awaiting_payment' RETURNING *`,
      [callId, signature, openedAt, acceptBy],
    );
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw new ValidationFailedError({ reason: 'signature_already_used' });
    }
    throw e;
  }
  if (updated === null) return toRow(await load(ctx, callId));
  await publishToUser(ctx, row.creator_user_id, 'call_invite', {
    callId,
    fromUserId: row.fan_user_id,
    paid: true,
    kind: 'paid',
    ratePerMinUsdc: String(row.rate_per_min),
    maxMinutes: Number(row.max_minutes),
    acceptBy: acceptBy.toISOString(),
  });
  return toRow(updated);
}

/**
 * The creator accepts: the settle authority sends `accept` on chain, then both players
 * can join the LiveKit room (`POST /rtc/token {kind:'paid_call', id: callId}`).
 *
 * @throws ConflictError `not_ringing` or `accept_window_closed`.
 */
export async function acceptPaidCall(
  ctx: AppContext,
  callId: string,
  creatorUserId: string,
): Promise<PaidCallRow> {
  guardOn(ctx);
  const row = await load(ctx, callId);
  if (row.creator_user_id !== creatorUserId) throw new ForbiddenError({ reason: 'not_creator' });
  if (row.status === 'live') return toRow(row);
  if (row.status !== 'ringing') throw new ConflictError({ reason: 'not_ringing' });
  if (row.accept_by && row.accept_by.getTime() < Date.now()) {
    await toRefunding(ctx, callId, 'not_answered');
    throw new ConflictError({ reason: 'accept_window_closed' });
  }
  const claimed = await transition(
    ctx,
    `UPDATE paid_calls SET accept_signature = $2
      WHERE call_id = $1 AND status = 'ringing' AND accept_signature IS NULL RETURNING *`,
    [callId, `pending:${uuidv7()}`],
  );
  if (claimed === null) throw new ConflictError({ reason: 'not_ringing' });
  let sig: string;
  try {
    sig = await escrowChain().accept(ctx, ref(row));
  } catch (e) {
    await transition(
      ctx,
      `UPDATE paid_calls SET accept_signature = NULL WHERE call_id = $1 AND status = 'ringing'
        RETURNING *`,
      [callId],
    );
    throw e;
  }
  const live = await transition(
    ctx,
    `UPDATE paid_calls SET status = 'live', accept_signature = $2, accepted_at = now()
      WHERE call_id = $1 AND status = 'ringing' RETURNING *`,
    [callId, sig],
  );
  await openRoom(ctx, row);
  const now = new Date();
  await recordQuestEvent(ctx, row.fan_user_id, 'paid_call', callId, now, {
    key: `pair:${row.creator_user_id}`,
    cooldownDays: PAID_CALL_PAIR_COOLDOWN_DAYS,
  });
  await recordQuestEvent(ctx, row.creator_user_id, 'paid_call', callId, now, {
    key: `pair:${row.fan_user_id}`,
    cooldownDays: PAID_CALL_PAIR_COOLDOWN_DAYS,
  });
  return toRow(live ?? (await load(ctx, callId)));
}

/** The voice room `POST /rtc/token {kind:'paid_call'}` checks. */
async function openRoom(ctx: AppContext, row: DbRow): Promise<void> {
  const roomId = `paid_call:${row.call_id}`;
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO voice_rooms (room_id, host_user_id, kind, title, max_speakers, requires_payment)
       VALUES ($1, $2, 'paid_call', $3, 2, true) ON CONFLICT (room_id) DO NOTHING`,
      [roomId, row.fan_user_id, `paid call ${row.call_id.slice(0, 8)}`],
    );
    for (const userId of [row.fan_user_id, row.creator_user_id]) {
      await c.query(
        `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
         SELECT $1, $2, $3, 'speaker'
          WHERE NOT EXISTS (SELECT 1 FROM voice_speakers WHERE room_id = $2 AND user_id = $3)`,
        [uuidv7(), roomId, userId],
      );
    }
  });
}

async function closeRoom(ctx: AppContext, callId: string): Promise<void> {
  const roomId = `paid_call:${callId}`;
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `UPDATE voice_rooms SET status = 'ended', ended_at = now()
        WHERE room_id = $1 AND status = 'live'`,
      [roomId],
    );
    await c.query(
      `UPDATE voice_speakers SET left_at = now() WHERE room_id = $1 AND left_at IS NULL`,
      [roomId],
    );
  });
  try {
    await ctx.livekit.endRoom(ctx, { kind: 'paid_call', id: callId });
  } catch {
    // Best effort: the room empties itself once both tokens stop.
  }
}

async function toRefunding(ctx: AppContext, callId: string, reason: string): Promise<DbRow | null> {
  return transition(
    ctx,
    `UPDATE paid_calls SET status = 'refunding', end_reason = $2, ended_at = now()
      WHERE call_id = $1 AND status = 'ringing' AND accept_signature IS NULL RETURNING *`,
    [callId, reason],
  );
}

/**
 * The creator declines a ringing call (or the fan cancels it). The deposit goes back to
 * the fan on chain as soon as the program allows (after the accept window); status
 * `refunding` until then.
 */
export async function declinePaidCall(
  ctx: AppContext,
  callId: string,
  userId: string,
): Promise<PaidCallRow> {
  guardOn(ctx);
  const row = await load(ctx, callId);
  if (row.creator_user_id !== userId && row.fan_user_id !== userId) {
    throw new ForbiddenError({ reason: 'not_participant' });
  }
  if (row.status === 'refunding' || row.status === 'refunded') return toRow(row);
  if (row.status !== 'ringing') throw new ConflictError({ reason: 'not_ringing' });
  const reason = row.creator_user_id === userId ? 'declined' : 'cancelled';
  const updated = await toRefunding(ctx, callId, reason);
  if (updated === null) throw new ConflictError({ reason: 'not_ringing' });
  return toRow(updated);
}

/**
 * End a live call. The server times it (accept to now, capped at the booked minutes)
 * and the settle authority sends `settle`. `settling` if the send failed; the worker
 * retries.
 */
export async function endPaidCall(
  ctx: AppContext,
  callId: string,
  userId: string,
): Promise<PaidCallRow> {
  guardOn(ctx);
  const row = await load(ctx, callId);
  if (row.creator_user_id !== userId && row.fan_user_id !== userId) {
    throw new ForbiddenError({ reason: 'not_participant' });
  }
  if (row.status === 'settling' || row.status === 'settled') return toRow(row);
  if (row.status !== 'live') throw new ConflictError({ reason: 'not_live' });
  return toRow(
    await settleLive(ctx, row, userId === row.fan_user_id ? 'fan_ended' : 'creator_ended'),
  );
}

/** End and settle a live call (API, LiveKit webhook or the worker). */
export async function settleLive(
  ctx: AppContext,
  row: DbRow,
  reason: string,
  now: Date = new Date(),
): Promise<DbRow> {
  const accepted = row.accepted_at ?? new Date();
  const maxSecs = Number(row.max_minutes) * 60;
  const secs = Math.max(
    0,
    Math.min(maxSecs, Math.floor((now.getTime() - accepted.getTime()) / 1000)),
  );
  const split = settlementSplit({
    ratePerMin: BigInt(row.rate_per_min),
    maxMinutes: Number(row.max_minutes),
    feeBps: Number(row.fee_bps),
    deposit: BigInt(row.deposit),
    secondsUsed: BigInt(secs),
  });
  const claimed = await transition(
    ctx,
    `UPDATE paid_calls SET status = 'settling', end_reason = $2, ended_at = now(),
            seconds_used = $3, minutes_used = $4, creator_amount = $5, fee_amount = $6,
            refund_amount = $7
      WHERE call_id = $1 AND status = 'live' RETURNING *`,
    [
      row.call_id,
      reason,
      secs,
      Number(split.minutes),
      split.creatorAmount.toString(),
      split.fee.toString(),
      split.refund.toString(),
    ],
  );
  if (claimed === null) return load(ctx, row.call_id);
  await closeRoom(ctx, row.call_id);
  return sendSettle(ctx, claimed);
}

/** Send settle for a `settling` row; on success the row is `settled`. */
async function sendSettle(ctx: AppContext, row: DbRow): Promise<DbRow> {
  try {
    const sig = await escrowChain().settle(ctx, {
      ...ref(row),
      secondsUsed: BigInt(row.seconds_used ?? 0),
    });
    return (await markSettled(ctx, row.call_id, sig)) ?? row;
  } catch {
    // The worker retries `settling` rows (and notices a session already closed).
    return row;
  }
}

async function markSettled(
  ctx: AppContext,
  callId: string,
  signature: string | null,
): Promise<DbRow | null> {
  return transition(
    ctx,
    `UPDATE paid_calls SET status = 'settled', settle_signature = COALESCE($2, settle_signature)
      WHERE call_id = $1 AND status = 'settling' RETURNING *`,
    [callId, signature],
  );
}

/** GET /paid-calls/:id, for the two participants only. */
export async function getPaidCall(
  ctx: AppContext,
  callId: string,
  userId: string,
): Promise<PaidCallRow> {
  assertCapabilityOn(ctx, 'paidCalls');
  const row = await load(ctx, callId);
  if (row.creator_user_id !== userId && row.fan_user_id !== userId) {
    throw new NotFoundError({ resource: 'paid_call', id: callId });
  }
  return toRow(row);
}

/** A participant left or the room finished (LiveKit webhook): end a live call. */
export async function endPaidCallFromRoom(
  ctx: AppContext,
  callId: string,
  reason: string,
): Promise<void> {
  const r = await ctx.db.withConnection((c) =>
    c.query<DbRow>(`SELECT * FROM paid_calls WHERE call_id = $1 AND status = 'live'`, [callId]),
  );
  const row = r.rows[0];
  if (row) await settleLive(ctx, row, reason);
}

export interface SweepCounts {
  expired: number;
  notAnswered: number;
  refunded: number;
  autoEnded: number;
  settled: number;
}

/**
 * Worker pass (every 15 s): expire or refund unpaid calls, refund unanswered and
 * declined calls once the program allows it, end live calls at their booked minutes,
 * and retry failed settles. Each item is independent; one failure never stops the pass.
 */
export async function sweepPaidCalls(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<SweepCounts> {
  const counts: SweepCounts = { expired: 0, notAnswered: 0, refunded: 0, autoEnded: 0, settled: 0 };
  const rows = await ctx.db.withConnection((c) =>
    c.query<DbRow>(
      `SELECT * FROM paid_calls
        WHERE status IN ('awaiting_payment', 'ringing', 'live', 'settling', 'refunding')
        ORDER BY created_at LIMIT 200`,
    ),
  );
  for (const row of rows.rows) {
    try {
      await sweepOne(ctx, row, now, counts);
    } catch (e) {
      console.error(`[paid-calls] ${row.call_id} ${row.status}:`, (e as Error).message);
    }
  }
  return counts;
}

async function sweepOne(
  ctx: AppContext,
  row: DbRow,
  now: Date,
  counts: SweepCounts,
): Promise<void> {
  const t = now.getTime();
  switch (row.status) {
    case 'awaiting_payment':
      if (row.pay_by.getTime() + 5 * 60_000 < t) {
        await resolveUnpaid(ctx, row);
        counts.expired += 1;
      }
      return;
    case 'ringing':
      if (row.accept_by && row.accept_by.getTime() < t) {
        if (await toRefunding(ctx, row.call_id, 'not_answered')) counts.notAnswered += 1;
      }
      return;
    case 'refunding':
      if (await refundIfAllowed(ctx, row, t)) counts.refunded += 1;
      return;
    case 'live': {
      const end = (row.accepted_at?.getTime() ?? t) + Number(row.max_minutes) * 60_000;
      if (end <= t) {
        await settleLive(ctx, row, 'max_reached', now);
        counts.autoEnded += 1;
      }
      return;
    }
    case 'settling':
      // Leave a fresh claim to the request that made it.
      if ((row.ended_at?.getTime() ?? 0) + 60_000 < t) {
        const s = await escrowChain().session(ctx, ref(row));
        const done =
          s === null ? await markSettled(ctx, row.call_id, null) : await sendSettle(ctx, row);
        if (done && done.status === 'settled') counts.settled += 1;
      }
      return;
    default:
      return;
  }
}

/** Refund once the accept window has passed on chain; a closed session counts as done. */
async function refundIfAllowed(ctx: AppContext, row: DbRow, t: number): Promise<boolean> {
  const cfg = await escrowChain().config(ctx);
  const opened = row.opened_at?.getTime() ?? 0;
  if (opened + (cfg.acceptWindowSecs + 2) * 1000 > t) return false;
  const s = await escrowChain().session(ctx, ref(row));
  let sig: string | null = null;
  if (s !== null) sig = await escrowChain().refund(ctx, ref(row));
  const done = await transition(
    ctx,
    `UPDATE paid_calls SET status = 'refunded', refund_signature = $2, refund_amount = deposit,
            creator_amount = 0, fee_amount = 0, minutes_used = 0
      WHERE call_id = $1 AND status = 'refunding' RETURNING *`,
    [row.call_id, sig],
  );
  return done !== null;
}
