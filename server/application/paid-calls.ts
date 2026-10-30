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
  CapabilityOffError,
  ConflictError,
  RateLimitedError,
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
  | 'expired'
  | 'closed_unknown'
  | 'stuck';

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
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  authority_rent_lamports: string;
  fan_rent_lamports: string;
  creator_rent_lamports: string;
  stuck_from: PaidCallStatus | null;
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

/** The violated unique constraint's name, or null for any other error. */
function uniqueViolation(e: unknown): string | null {
  const err = e as { code?: string; constraint?: string };
  return err.code === '23505' ? (err.constraint ?? 'unknown') : null;
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

/** Bookings a fan may make per hour and per day, and calls a creator may take per day. */
export const FAN_BOOKINGS_PER_HOUR = 6;
export const FAN_BOOKINGS_PER_DAY = 30;
export const CREATOR_CALLS_PER_DAY = 40;
/** Bookings one fan may make to the same creator per day (any status). */
export const PAIR_CALLS_PER_DAY = 4;
/** Calls in 24 h where the requester's own account made the settle authority pay rent. */
export const RENT_CALLS_PER_DAY = 2;
/** Below this the API stops booking (the authority could not settle or refund). */
export const AUTHORITY_FLOOR_LAMPORTS = 20_000_000n; // 0.02 SOL
/** Below this the worker logs an ALERT every pass. */
export const AUTHORITY_ALARM_LAMPORTS = 100_000_000n; // 0.1 SOL

let balanceCache: { at: number; lamports: bigint } | null = null;

/** The settle authority's balance, read at most once a minute. */
export async function authorityBalance(ctx: AppContext, now = Date.now()): Promise<bigint> {
  if (balanceCache && now - balanceCache.at < 60_000) return balanceCache.lamports;
  const lamports = await escrowChain().authorityLamports(ctx);
  balanceCache = { at: now, lamports };
  return lamports;
}

/** Test-only: forget the cached authority balance. */
export function _resetAuthorityBalanceForTests(): void {
  balanceCache = null;
}

/**
 * Per-user rate limits, the rent cap, and the authority's balance floor (review M4).
 * Only the requesting fan is limited by what they did; a creator is never locked out by
 * other people's unpaid bookings or by rent other fans forced.
 */
async function bookingGuards(ctx: AppContext, fanUserId: string, creatorId: string): Promise<void> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      fan_hour: string;
      fan_day: string;
      pair_day: string;
      creator_day: string;
      rent_calls: string;
    }>(
      `SELECT
         (SELECT count(*) FROM paid_calls WHERE fan_user_id = $1
            AND created_at > now() - interval '1 hour')::text AS fan_hour,
         (SELECT count(*) FROM paid_calls WHERE fan_user_id = $1
            AND created_at > now() - interval '1 day')::text AS fan_day,
         (SELECT count(*) FROM paid_calls WHERE fan_user_id = $1 AND creator_user_id = $2
            AND created_at > now() - interval '1 day')::text AS pair_day,
         -- Only funded calls (signature verified on chain) count against a creator.
         (SELECT count(*) FROM paid_calls WHERE creator_user_id = $2
            AND open_signature IS NOT NULL
            AND created_at > now() - interval '1 day')::text AS creator_day,
         -- Rent the requester forced with their own account, as fan or as creator.
         (SELECT count(*) FROM paid_calls
           WHERE ((fan_user_id = $1 AND fan_rent_lamports > 0)
               OR (creator_user_id = $1 AND creator_rent_lamports > 0))
             AND created_at > now() - interval '1 day')::text AS rent_calls`,
      [fanUserId, creatorId],
    ),
  );
  const n = r.rows[0]!;
  const day = 24 * 60 * 60_000;
  if (Number(n.pair_day) >= PAIR_CALLS_PER_DAY) {
    throw new RateLimitedError(day, { reason: 'pair_call_rate' });
  }
  if (Number(n.fan_hour) >= FAN_BOOKINGS_PER_HOUR) {
    throw new RateLimitedError(60 * 60_000, { reason: 'paid_call_rate', window: 'hour' });
  }
  if (Number(n.fan_day) >= FAN_BOOKINGS_PER_DAY) {
    throw new RateLimitedError(day, { reason: 'paid_call_rate', window: 'day' });
  }
  if (Number(n.creator_day) >= CREATOR_CALLS_PER_DAY) {
    throw new RateLimitedError(day, { reason: 'creator_call_rate' });
  }
  if (Number(n.rent_calls) >= RENT_CALLS_PER_DAY) {
    throw new RateLimitedError(day, { reason: 'account_recreations' });
  }
  if ((await authorityBalance(ctx)) < AUTHORITY_FLOOR_LAMPORTS) {
    throw new CapabilityOffError({ capability: 'paidCalls', reason: 'authority_low' });
  }
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
    // The creator is on (or being rung for) another call: nobody pays for a call that
    // could not ring.
    const busy = await c.query(
      `SELECT 1 FROM paid_calls WHERE creator_user_id = $1
          AND status IN ('ringing', 'live', 'settling') LIMIT 1`,
      [args.creatorId],
    );
    if ((busy.rowCount ?? 0) > 0)
      throw new ConflictError({ reason: 'call_in_progress', who: 'creator' });
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
  await bookingGuards(ctx, fanUserId, args.creatorId);
  const cfg = await escrowChain().config(ctx);
  // Both payout accounts must already exist and be usable, paid for by their owners: the
  // settle authority never pays rent for a normal call (security review M4).
  const accounts = await escrowChain().usdcAccounts(ctx, [fan, terms.payoutWallet]);
  if (accounts[fan] !== 'ok') {
    throw new ValidationFailedError({ reason: 'usdc_account_missing', state: accounts[fan] });
  }
  if (accounts[terms.payoutWallet] !== 'ok') {
    throw new CreatorUnavailableError({
      creatorId: args.creatorId,
      reason: 'creator_usdc_account_missing',
    });
  }
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
    if (uniqueViolation(e) === 'paid_calls_one_open_per_fan') {
      throw new ConflictError({ reason: 'call_in_progress', who: 'fan' });
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
 * and match this call exactly (fan, creator, session id, rate, minutes, deposit, Open),
 * and the reported signature itself must be a confirmed, successful open_session of this
 * call's Session PDA signed by the fan's wallet (nothing unverified is stored). Then the
 * creator is rung. Idempotent for the same call.
 *
 * @throws ConflictError `not_found_yet` (retry in a second or two), or `call_in_progress`
 *   when the creator got busy meanwhile (this call is then refunded).
 * @throws ValidationFailedError `tx_mismatch` when the Session or the signature differs.
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
  const check = await escrowChain().verifyOpen(ctx, ref(row), signature);
  if (check === 'not_found') throw new ConflictError({ reason: 'not_found_yet' });
  if (check !== 'ok') throw new ValidationFailedError({ reason: 'tx_mismatch', signature: check });
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
    const constraint = uniqueViolation(e);
    if (constraint === 'paid_calls_one_open_per_creator') {
      // Funded, but the creator is on another call: refund this one (after the window).
      await transition(
        ctx,
        `UPDATE paid_calls SET status = 'refunding', end_reason = 'creator_busy', opened_at = $2,
                accept_by = $3, ended_at = now()
          WHERE call_id = $1 AND status = 'awaiting_payment' RETURNING *`,
        [callId, openedAt, acceptBy],
      );
      throw new ConflictError({ reason: 'call_in_progress', who: 'creator' });
    }
    if (constraint === 'paid_calls_open_signature_key') {
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
async function sendSettle(ctx: AppContext, row: DbRow, rethrow = false): Promise<DbRow> {
  try {
    const sent = await escrowChain().settle(ctx, {
      ...ref(row),
      secondsUsed: BigInt(row.seconds_used ?? 0),
    });
    return (await markSettled(ctx, row.call_id, sent.signature, sent)) ?? row;
  } catch (e) {
    // The API request leaves it to the worker, which retries with backoff (and notices
    // a session already closed); the worker itself rethrows to count the failure.
    if (rethrow) throw e;
    return row;
  }
}

/** Only ever called with a real settle signature (ours, or found on chain). */
async function markSettled(
  ctx: AppContext,
  callId: string,
  signature: string,
  rent: RentSplit = NO_RENT,
): Promise<DbRow | null> {
  return transition(
    ctx,
    `UPDATE paid_calls SET status = 'settled', settle_signature = $2, ${RENT_SQL}
      WHERE call_id = $1 AND status = 'settling' RETURNING *`,
    [callId, signature, ...rentParams(rent)],
  );
}

interface RentSplit {
  rentLamports: bigint;
  fanRentLamports: bigint;
  creatorRentLamports: bigint;
}
const NO_RENT: RentSplit = { rentLamports: 0n, fanRentLamports: 0n, creatorRentLamports: 0n };
/** Adds a send's rent to the row ($3 total, $4 forced by the fan, $5 by the creator). */
const RENT_SQL = `authority_rent_lamports = authority_rent_lamports + $3,
            fan_rent_lamports = fan_rent_lamports + $4,
            creator_rent_lamports = creator_rent_lamports + $5`;
function rentParams(r: RentSplit): string[] {
  return [r.rentLamports, r.fanRentLamports, r.creatorRentLamports].map(String);
}

/**
 * The Session account is gone: find the transaction that closed it and record what it
 * really did. SessionSettled -> settled with the on-chain split; SessionRefunded ->
 * refunded (nothing to the creator); not found -> `closed_unknown` with the creator and
 * fee amounts zeroed. Never assumes a settle.
 */
async function reconcileClosed(
  ctx: AppContext,
  row: DbRow,
  from: 'settling' | 'refunding' | 'stuck',
): Promise<DbRow | null> {
  const c = await escrowChain().closure(ctx, ref(row));
  if (c?.kind === 'settled') {
    return transition(
      ctx,
      `UPDATE paid_calls SET status = 'settled', settle_signature = $3, creator_amount = $4,
              fee_amount = $5, refund_amount = $6, minutes_used = $7
        WHERE call_id = $1 AND status = $2 RETURNING *`,
      [
        row.call_id,
        from,
        c.signature,
        c.creatorAmount.toString(),
        c.fee.toString(),
        c.refund.toString(),
        Number(c.minutes),
      ],
    );
  }
  if (c?.kind === 'refunded') {
    if (from === 'settling') {
      console.error(
        `[paid-calls] ALERT ${row.call_id}: settle never landed and the fan refunded on chain (${c.signature})`,
      );
    }
    return transition(
      ctx,
      `UPDATE paid_calls SET status = 'refunded', refund_signature = $3, refund_amount = $4,
              creator_amount = 0, fee_amount = 0, minutes_used = 0
        WHERE call_id = $1 AND status = $2 RETURNING *`,
      [row.call_id, from, c.signature, c.refundAmount.toString()],
    );
  }
  console.error(
    `[paid-calls] ALERT ${row.call_id}: session closed but no settle/refund found; closed_unknown`,
  );
  return transition(
    ctx,
    `UPDATE paid_calls SET status = 'closed_unknown', creator_amount = 0, fee_amount = 0
      WHERE call_id = $1 AND status = $2 RETURNING *`,
    [row.call_id, from],
  );
}

/** Seconds before the program lets the fan refund an accepted call that was never settled. */
function refundDeadline(row: DbRow): number {
  return (row.opened_at?.getTime() ?? 0) + (Number(row.max_minutes) * 60 + 600) * 1000;
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
  failed: number;
  stuck: number;
  recovered: number;
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
  const counts: SweepCounts = {
    expired: 0,
    notAnswered: 0,
    refunded: 0,
    autoEnded: 0,
    settled: 0,
    failed: 0,
    stuck: 0,
    recovered: 0,
  };
  await balanceAlarm(ctx, now);
  // One batch per status, so failing rows of one status cannot starve another (security
  // review M3). Live and settling rows come first, nearest refund deadline first, and are
  // tried EVERY pass with no backoff: a settle must land before the fan's refund window
  // opens. The other statuses take due rows first and back off on failure.
  for (const status of SWEEP_STATUSES) {
    const urgent = status === 'live' || status === 'settling';
    const rows = await ctx.db.withConnection((c) =>
      c.query<DbRow>(
        urgent
          ? `SELECT * FROM paid_calls WHERE status = $1
              ORDER BY opened_at + make_interval(mins => max_minutes) ASC NULLS FIRST, created_at ASC
              LIMIT $2`
          : `SELECT * FROM paid_calls
              WHERE status = $1 AND (next_attempt_at IS NULL OR next_attempt_at <= $3)
              ORDER BY next_attempt_at ASC NULLS FIRST, created_at ASC LIMIT $2`,
        urgent ? [status, URGENT_BATCH] : [status, SWEEP_BATCH, now],
      ),
    );
    for (const row of rows.rows) {
      try {
        await sweepOne(ctx, row, now, counts);
      } catch (e) {
        await recordFailure(ctx, row, e as Error, now, counts);
      }
    }
  }
  await recheckStuck(ctx, now, counts);
  return counts;
}

/** How often a parked row is re-checked for a session that closed meanwhile. */
const STUCK_RECHECK_MS = 10 * 60_000;

/**
 * Recovery for parked rows: a session that closed meanwhile (the fan refunded, or a
 * manual settle) is reconciled from its closing transaction; the rest wait for the next
 * check or for `requeueStuckCalls`.
 */
async function recheckStuck(ctx: AppContext, now: Date, counts: SweepCounts): Promise<void> {
  const rows = await ctx.db.withConnection((c) =>
    c.query<DbRow>(
      `SELECT * FROM paid_calls
        WHERE status = 'stuck' AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
        ORDER BY next_attempt_at ASC NULLS FIRST LIMIT 20`,
      [now],
    ),
  );
  for (const row of rows.rows) {
    try {
      if ((await escrowChain().session(ctx, ref(row))) === null) {
        if (await reconcileClosed(ctx, row, 'stuck')) counts.recovered += 1;
        continue;
      }
    } catch (e) {
      console.error(`[paid-calls] stuck recheck ${row.call_id}:`, (e as Error).message);
    }
    await transition(
      ctx,
      `UPDATE paid_calls SET next_attempt_at = $2 WHERE call_id = $1 AND status = 'stuck' RETURNING *`,
      [row.call_id, new Date(now.getTime() + STUCK_RECHECK_MS)],
    );
  }
}

/**
 * Ops: put parked calls back into the status they were parked from (attempts reset), for
 * the worker to retry. All `stuck` rows when `callIds` is omitted. A row whose return
 * would clash with an open call (one-open-call indexes) is skipped and reported.
 */
export async function requeueStuckCalls(
  ctx: AppContext,
  callIds?: readonly string[],
): Promise<{ requeued: string[]; skipped: string[] }> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ call_id: string }>(
      `SELECT call_id FROM paid_calls
        WHERE status = 'stuck' AND stuck_from IS NOT NULL
          AND ($1::uuid[] IS NULL OR call_id = ANY($1::uuid[]))`,
      [callIds ? [...callIds] : null],
    ),
  );
  const out = { requeued: [] as string[], skipped: [] as string[] };
  for (const { call_id } of r.rows) {
    try {
      const done = await transition(
        ctx,
        `UPDATE paid_calls SET status = stuck_from, stuck_from = NULL, attempts = 0,
                next_attempt_at = NULL
          WHERE call_id = $1 AND status = 'stuck' RETURNING *`,
        [call_id],
      );
      (done ? out.requeued : out.skipped).push(call_id);
    } catch (e) {
      if ((e as { code?: string }).code !== '23505') throw e;
      out.skipped.push(call_id);
    }
  }
  return out;
}

const SWEEP_STATUSES: readonly PaidCallStatus[] = [
  'live',
  'settling',
  'ringing',
  'refunding',
  'awaiting_payment',
];
const SWEEP_BATCH = 50;
const URGENT_BATCH = 200;
/** After this many failed chain attempts a row is parked as `stuck`. */
export const MAX_SWEEP_ATTEMPTS = 8;

/**
 * Record a failed pass. Live / settling: retried every pass, never parked (an ALERT past
 * the cap). Other statuses: back off (15 s x 2^n, at most 30 min) and park as `stuck`
 * past the cap.
 */
async function recordFailure(
  ctx: AppContext,
  row: DbRow,
  e: Error,
  now: Date,
  counts: SweepCounts,
): Promise<void> {
  const attempts = Number(row.attempts) + 1;
  const message = e.message.slice(0, 500);
  if (row.status === 'live' || row.status === 'settling') {
    // Never backed off or parked: retried next pass, until it lands or the session closes.
    if (attempts >= MAX_SWEEP_ATTEMPTS) {
      console.error(
        `[paid-calls] ALERT ${row.call_id} ${row.status} failed ${attempts} times; fan refund possible from ` +
          `${new Date(refundDeadline(row)).toISOString()}: ${message}`,
      );
    }
    await transition(
      ctx,
      `UPDATE paid_calls SET attempts = $3, last_error = $4, next_attempt_at = NULL
        WHERE call_id = $1 AND status = $2 RETURNING *`,
      [row.call_id, row.status, attempts, message],
    );
    counts.failed += 1;
    return;
  }
  if (attempts >= MAX_SWEEP_ATTEMPTS) {
    console.error(
      `[paid-calls] ALERT ${row.call_id} parked as stuck after ${attempts} failures in ${row.status}: ${message}`,
    );
    await transition(
      ctx,
      `UPDATE paid_calls SET status = 'stuck', stuck_from = $2, attempts = $3, last_error = $4,
              next_attempt_at = $5
        WHERE call_id = $1 AND status = $2 RETURNING *`,
      [
        row.call_id,
        row.status,
        attempts,
        `${row.status}: ${message}`,
        new Date(now.getTime() + STUCK_RECHECK_MS),
      ],
    );
    counts.stuck += 1;
    return;
  }
  const delayMs = Math.min(15_000 * 2 ** attempts, 30 * 60_000);
  console.error(`[paid-calls] ${row.call_id} ${row.status} attempt ${attempts} failed: ${message}`);
  await transition(
    ctx,
    `UPDATE paid_calls SET attempts = $3, last_error = $4, next_attempt_at = $5
      WHERE call_id = $1 AND status = $2 RETURNING *`,
    [row.call_id, row.status, attempts, message, new Date(now.getTime() + delayMs)],
  );
  counts.failed += 1;
}

/** Log an ALERT while the settle authority's SOL is low (security review M4). */
async function balanceAlarm(ctx: AppContext, now: Date): Promise<void> {
  try {
    const lamports = await authorityBalance(ctx, now.getTime());
    if (lamports < AUTHORITY_ALARM_LAMPORTS) {
      console.error(
        `[paid-calls] ALERT settle authority balance ${lamports} lamports is under ` +
          `${AUTHORITY_ALARM_LAMPORTS}; booking stops under ${AUTHORITY_FLOOR_LAMPORTS}. Refill it.`,
      );
    }
  } catch (e) {
    console.error(
      '[paid-calls] could not read the settle authority balance:',
      (e as Error).message,
    );
  }
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
    case 'settling': {
      // Retry promptly (a fresh claim gets 20 s to finish its own send): the fan may
      // refund the whole deposit on chain once the refund deadline passes.
      const ended = row.ended_at?.getTime() ?? 0;
      if (ended + 20_000 >= t) return;
      if (ended + 5 * 60_000 < t || refundDeadline(row) - 120_000 < t) {
        console.error(
          `[paid-calls] ALERT ${row.call_id} stuck in settling since ${row.ended_at?.toISOString()}; ` +
            `fan refund possible from ${new Date(refundDeadline(row)).toISOString()}`,
        );
      }
      const s = await escrowChain().session(ctx, ref(row));
      const done =
        s === null ? await reconcileClosed(ctx, row, 'settling') : await sendSettle(ctx, row, true);
      if (done && done.status === 'settled') counts.settled += 1;
      return;
    }
    default:
      return;
  }
}

/**
 * Refund once the accept window has passed on chain. A session that is already gone is
 * reconciled from its closing transaction, never assumed refunded.
 */
async function refundIfAllowed(ctx: AppContext, row: DbRow, t: number): Promise<boolean> {
  const cfg = await escrowChain().config(ctx);
  const opened = row.opened_at?.getTime() ?? 0;
  if (opened + (cfg.acceptWindowSecs + 2) * 1000 > t) return false;
  const s = await escrowChain().session(ctx, ref(row));
  if (s === null) {
    const done = await reconcileClosed(ctx, row, 'refunding');
    return done?.status === 'refunded';
  }
  const sent = await escrowChain().refund(ctx, ref(row));
  const done = await transition(
    ctx,
    `UPDATE paid_calls SET status = 'refunded', refund_signature = $2, refund_amount = deposit,
            creator_amount = 0, fee_amount = 0, minutes_used = 0, ${RENT_SQL}
      WHERE call_id = $1 AND status = 'refunding' RETURNING *`,
    [row.call_id, sent.signature, ...rentParams(sent)],
  );
  return done !== null;
}
