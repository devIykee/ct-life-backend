/**
 * Rekt Burger: the "blew my port" fallback job.
 *
 *   GET  /v1/jobs/rekt-burger                 unlocked?, why, my shift state, pay and caps
 *   POST /v1/jobs/rekt-burger/shift/start     open a server-held shift
 *   POST /v1/jobs/rekt-burger/shift/finish    {result: {orders: [...]}}: validate, pay
 *   POST /v1/jobs/rekt-burger/leave           hang up the apron
 *
 * "Rekt Burger" is our own parody brand (no real chain's name, logo or likeness).
 *
 * Unlock. Trenchers have it from the start (their safety net). Everyone else unlocks it
 * for good when broke (Cash at or below 0 while in debt, checked whenever the job is read
 * or started) or when a perp liquidation leaves their Cash under a floor (checked right
 * after the liquidation). Thresholds are in `contract/config/careers.json` `rektBurger`.
 *
 * Pay is a humble faucet and is decided only by the server. The client plays a short
 * minigame and reports the timing of each ticket; the server checks the report is
 * humanly possible for a shift it opened itself (see `validateOrders`), then pays
 * `baseCents + perCorrectOrderCents * correct orders`, in integer cents, capped per shift
 * and per UTC day. The client never sends an amount. A report that fails the plausibility
 * check burns the shift (it cannot be retried with tuned numbers) and answers 422.
 *
 * Timeline. Starting work after being out (the first shift of a stint) writes a "Back to
 * the trenches" post; leaving after a stint that began below the glow-up net worth and
 * ended above it writes a "Glow-up" post. Both are server-templated, one per cooldown.
 *
 * Shift completion also counts for the quests (`shift_complete`), and through them the
 * Season XP that quests pay when claimed.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  ConflictError,
  JobDailyCapError,
  JobLockedError,
  NotFoundError,
  ShiftNotFinishedError,
  ShiftResultImplausibleError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { nextUtcMidnight } from './daily-streak.js';
import { publishToUser } from './realtime-bus.js';
import { recordQuestEvent } from './quests.js';
import { creditCash, ensureRewardCatalog, grantCosmetic } from './rewards.js';
import type { AppContext } from './context.js';

export const REKT_BURGER_ID = 'rekt-burger';

export type UnlockReason = 'trencher' | 'broke' | 'liquidated';

export interface RektBurgerConfig {
  readonly id: string;
  readonly name: string;
  readonly venueId: string;
  readonly propId: string;
  readonly preUnlockTribeIds: readonly string[];
  readonly unlock: {
    readonly brokeCashCentsAtMost: number;
    readonly requiresDebt: boolean;
    readonly liquidationCashBelowCents: number;
  };
  readonly glowUpNetWorthCents: number;
  readonly postCooldownHours: number;
  readonly pay: {
    readonly baseCents: number;
    readonly perCorrectOrderCents: number;
    readonly maxCorrectOrdersPaid: number;
    readonly dailyCapCents: number;
  };
  readonly shift: {
    readonly minDurationSec: number;
    readonly maxDurationSec: number;
    readonly minOrders: number;
    readonly maxOrders: number;
    readonly minServeMs: number;
    readonly minGapMs: number;
    readonly maxServeMs: number;
    readonly toleranceMs: number;
    readonly minServeJitterMs: number;
  };
  readonly uniformCosmeticId: string;
}

/** One served ticket, as the client reports it. All times are ms since the shift started. */
export interface OrderReport {
  readonly i: number;
  readonly startedMs: number;
  readonly servedMs: number;
  readonly correct: boolean;
}

/** The Rekt Burger config (cached by the context). */
export function rektConfig(ctx: AppContext): RektBurgerConfig {
  return ctx.configCache.load<{ rektBurger: RektBurgerConfig }>('careers').rektBurger;
}

/** The most a single shift can pay (the per-order cap reached). */
export function maxShiftPayCents(cfg: RektBurgerConfig): number {
  return cfg.pay.baseCents + cfg.pay.perCorrectOrderCents * cfg.pay.maxCorrectOrdersPaid;
}

/** Pay for a validated shift, before the daily cap. Integer cents. */
export function shiftPayCents(cfg: RektBurgerConfig, correctOrders: number): number {
  const paid = Math.min(Math.max(0, correctOrders), cfg.pay.maxCorrectOrdersPaid);
  return cfg.pay.baseCents + cfg.pay.perCorrectOrderCents * paid;
}

function stddev(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

export type OrdersCheck =
  | { readonly ok: true; readonly count: number; readonly correct: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Is this report something a person could have produced in a shift the server timed?
 * Pure. `elapsedMs` is the server's own clock (finish minus start), never the client's.
 *
 * Checks: the order count is within bounds; tickets are numbered 0..n-1 in order; each
 * ticket was served after it appeared, no faster than a human can and not absurdly slow;
 * no ticket is served after the shift ended (plus a small network tolerance); consecutive
 * serves are at least `minGapMs` apart; and the timings are not machine-regular.
 */
export function validateOrders(
  orders: readonly OrderReport[],
  elapsedMs: number,
  cfg: RektBurgerConfig['shift'],
): OrdersCheck {
  const n = orders.length;
  if (n < cfg.minOrders || n > cfg.maxOrders) return { ok: false, reason: 'order_count' };
  let prevServed = -Infinity;
  let correct = 0;
  const serves: number[] = [];
  const gaps: number[] = [];
  for (let k = 0; k < n; k++) {
    const o = orders[k]!;
    if (o.i !== k) return { ok: false, reason: 'order_index' };
    if (o.startedMs < 0 || o.servedMs < o.startedMs) return { ok: false, reason: 'order_times' };
    const serve = o.servedMs - o.startedMs;
    if (serve < cfg.minServeMs || serve > cfg.maxServeMs) {
      return { ok: false, reason: 'serve_time' };
    }
    if (o.servedMs > elapsedMs + cfg.toleranceMs) {
      return { ok: false, reason: 'served_after_finish' };
    }
    if (k > 0 && o.servedMs - prevServed < cfg.minGapMs) return { ok: false, reason: 'too_fast' };
    if (k > 0) gaps.push(o.servedMs - prevServed);
    prevServed = o.servedMs;
    serves.push(serve);
    if (o.correct) correct += 1;
  }
  if (n >= 5 && stddev(serves) < cfg.minServeJitterMs && stddev(gaps) < cfg.minServeJitterMs) {
    return { ok: false, reason: 'robotic_timing' };
  }
  return { ok: true, count: n, correct };
}

interface StateRow {
  unlock_reason: UnlockReason;
  employed: boolean;
  stint_started_at: Date | null;
  stint_networth_cents: string | null;
  stint_shifts: number;
}

async function readState(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  forUpdate: boolean,
): Promise<StateRow | null> {
  const r = await client.query<StateRow>(
    `SELECT unlock_reason, employed, stint_started_at, stint_networth_cents, stint_shifts
       FROM rekt_burger_state WHERE user_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return r.rows[0] ?? null;
}

async function readBalances(
  client: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<{ cash: number; debt: number }> {
  const r = await client.query<{ cash_cents: string; debt_cents: string }>(
    `SELECT cash_cents, debt_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return {
    cash: Number(r.rows[0]?.cash_cents ?? '0'),
    debt: Number(r.rows[0]?.debt_cents ?? '0'),
  };
}

async function insertState(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  reason: UnlockReason,
  now: Date,
): Promise<boolean> {
  const r = await client.query(
    `INSERT INTO rekt_burger_state (user_id, unlock_reason, unlocked_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING RETURNING 1`,
    [userId, reason, now],
  );
  return r.rows.length > 0;
}

/**
 * Is the job unlocked for this player? Creates the state row the first time a rule
 * matches (Trencher, or broke). Run inside a transaction.
 * @returns The reason it is unlocked and whether this call unlocked it, or null.
 */
async function ensureUnlocked(
  client: PoolClient,
  cfg: RektBurgerConfig,
  userId: string,
  now: Date,
): Promise<{ reason: UnlockReason; newly: boolean } | null> {
  const existing = await readState(client, userId, true);
  if (existing) return { reason: existing.unlock_reason, newly: false };
  const tribe = await client.query<{ tribe_id: string }>(
    `SELECT tribe_id FROM characters WHERE user_id = $1`,
    [userId],
  );
  const tribeId = tribe.rows[0]?.tribe_id;
  if (tribeId !== undefined && cfg.preUnlockTribeIds.includes(tribeId)) {
    await insertState(client, userId, 'trencher', now);
    return { reason: 'trencher', newly: false };
  }
  const { cash, debt } = await readBalances(client, userId);
  if (cash <= cfg.unlock.brokeCashCentsAtMost && (!cfg.unlock.requiresDebt || debt > 0)) {
    const newly = await insertState(client, userId, 'broke', now);
    return { reason: 'broke', newly };
  }
  return null;
}

async function announceUnlock(
  ctx: AppContext,
  userId: string,
  reason: UnlockReason,
  now: Date,
): Promise<void> {
  const cfg = rektConfig(ctx);
  await publishToUser(ctx, userId, 'job_unlocked', {
    jobId: REKT_BURGER_ID,
    name: cfg.name,
    reason,
    venueId: cfg.venueId,
    at: now.getTime(),
  });
}

/**
 * Called right after a perp liquidation commits: a player left with less Cash than the
 * floor unlocks the job. Never throws; a failure must not touch the liquidation.
 */
export async function onPlayerRekt(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const cfg = rektConfig(ctx);
    const newly = await runInTransaction(async (client) => {
      if (await readState(client, userId, true)) return false;
      const { cash } = await readBalances(client, userId);
      if (cash >= cfg.unlock.liquidationCashBelowCents) return false;
      return insertState(client, userId, 'liquidated', now);
    });
    if (newly) await announceUnlock(ctx, userId, 'liquidated', now);
  } catch (e) {
    console.error('[rekt-burger] unlock after liquidation failed:', (e as Error).message);
  }
}

const POST_TEXT = {
  back_to_trenches:
    'back to the trenches. flipping burgers at Rekt Burger until the bag is back. gm anyway.',
  glow_up: (cents: number): string =>
    `glow-up complete. hung up the Rekt Burger apron with net worth back above $${Math.floor(cents / 100).toLocaleString('en-US')}. see you at the perp pit.`,
} as const;

/**
 * Write one Timeline post about the player's career, at most one of each event per
 * cooldown. The text is fixed server-side.
 * @returns The post id, or null when one was written too recently.
 */
async function careerPost(
  client: PoolClient,
  cfg: RektBurgerConfig,
  userId: string,
  event: 'back_to_trenches' | 'glow_up',
  text: string,
  now: Date,
): Promise<string | null> {
  const since = new Date(now.getTime() - cfg.postCooldownHours * 3_600_000);
  const recent = await client.query(
    `SELECT 1 FROM feed_posts
      WHERE user_id = $1 AND kind = 'career' AND meta ->> 'event' = $2 AND created_at > $3 LIMIT 1`,
    [userId, event, since],
  );
  if ((recent.rowCount ?? 0) > 0) return null;
  const postId = uuidv7();
  await client.query(
    `INSERT INTO feed_posts (post_id, user_id, text, created_at, kind, meta)
     VALUES ($1, $2, $3, $4, 'career', $5)`,
    [
      postId,
      userId,
      text,
      now,
      JSON.stringify({ event, jobId: REKT_BURGER_ID, deepLink: `venue:${cfg.venueId}` }),
    ],
  );
  return postId;
}

async function paidToday(
  client: Pick<PoolClient, 'query'>,
  userId: string,
  now: Date,
): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const r = await client.query<{ n: string }>(
    `SELECT COALESCE(SUM(pay_cents), 0) AS n FROM rekt_burger_shifts
      WHERE user_id = $1 AND status = 'done' AND finished_at >= $2 AND finished_at < $3`,
    [userId, start, nextUtcMidnight(now)],
  );
  return Number(r.rows[0]?.n ?? 0);
}

interface ShiftRow {
  shift_id: string;
  status: 'open' | 'done' | 'expired';
  started_at: Date;
}

/** Expire an open shift that ran past its maximum. Returns the live open shift, if any. */
async function liveOpenShift(
  client: PoolClient,
  cfg: RektBurgerConfig,
  userId: string,
  now: Date,
): Promise<ShiftRow | null> {
  const r = await client.query<ShiftRow>(
    `SELECT shift_id, status, started_at FROM rekt_burger_shifts
      WHERE user_id = $1 AND status = 'open' FOR UPDATE`,
    [userId],
  );
  const open = r.rows[0];
  if (!open) return null;
  const limit = open.started_at.getTime() + cfg.shift.maxDurationSec * 1000 + cfg.shift.toleranceMs;
  if (now.getTime() <= limit) return open;
  await client.query(
    `UPDATE rekt_burger_shifts SET status = 'expired', finished_at = $2 WHERE shift_id = $1`,
    [open.shift_id, now],
  );
  return null;
}

export interface ShiftStartView {
  readonly shiftId: string;
  readonly startedAt: string;
  /** Earliest moment the server accepts a finish. */
  readonly minFinishAt: string;
  /** After this the shift is void. */
  readonly expiresAt: string;
  readonly rules: {
    readonly minOrders: number;
    readonly maxOrders: number;
    readonly minServeMs: number;
    readonly minGapMs: number;
    readonly maxServeMs: number;
    readonly maxCorrectOrdersPaid: number;
  };
}

function shiftView(cfg: RektBurgerConfig, shiftId: string, startedAt: Date): ShiftStartView {
  const t = startedAt.getTime();
  return {
    shiftId,
    startedAt: startedAt.toISOString(),
    minFinishAt: new Date(t + cfg.shift.minDurationSec * 1000).toISOString(),
    expiresAt: new Date(t + cfg.shift.maxDurationSec * 1000).toISOString(),
    rules: {
      minOrders: cfg.shift.minOrders,
      maxOrders: cfg.shift.maxOrders,
      minServeMs: cfg.shift.minServeMs,
      minGapMs: cfg.shift.minGapMs,
      maxServeMs: cfg.shift.maxServeMs,
      maxCorrectOrdersPaid: cfg.pay.maxCorrectOrdersPaid,
    },
  };
}

export interface RektBurgerView {
  readonly jobId: string;
  readonly name: string;
  readonly venueId: string;
  readonly propId: string;
  readonly unlocked: boolean;
  /** Why it is unlocked, or null while locked. */
  readonly reason: UnlockReason | null;
  /** While locked: what would unlock it. */
  readonly lockedHint: {
    readonly cashCents: number;
    readonly debtCents: number;
    readonly brokeCashCentsAtMost: number;
    readonly liquidationCashBelowCents: number;
  } | null;
  readonly employed: boolean;
  readonly stintShifts: number;
  readonly netWorthCents: number;
  readonly glowUpNetWorthCents: number;
  readonly pay: {
    readonly baseCents: number;
    readonly perCorrectOrderCents: number;
    readonly maxShiftCents: number;
    readonly dailyCapCents: number;
    readonly earnedTodayCents: number;
    readonly remainingTodayCents: number;
    readonly resetsAt: string;
  };
  readonly shift: ShiftStartView | null;
  readonly uniformCosmeticId: string;
  readonly hasUniform: boolean;
}

/** The job's state for the caller: unlock, pay, caps and any open shift. */
export async function getRektBurger(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<RektBurgerView> {
  const cfg = rektConfig(ctx);
  const v = await runInTransaction(async (client) => {
    const unlock = await ensureUnlocked(client, cfg, userId, now);
    const state = unlock ? await readState(client, userId, false) : null;
    const bal = await readBalances(client, userId);
    const earned = await paidToday(client, userId, now);
    const open = unlock ? await liveOpenShift(client, cfg, userId, now) : null;
    const uniform = await client.query(
      `SELECT 1 FROM cosmetic_inventory ci JOIN cosmetic_items it ON it.item_id = ci.item_id
        WHERE ci.user_id = $1 AND it.item_key = $2`,
      [userId, cfg.uniformCosmeticId],
    );
    return { unlock, state, bal, earned, open, hasUniform: (uniform.rowCount ?? 0) > 0 };
  });
  if (v.unlock?.newly) await announceUnlock(ctx, userId, v.unlock.reason, now);
  return {
    jobId: REKT_BURGER_ID,
    name: cfg.name,
    venueId: cfg.venueId,
    propId: cfg.propId,
    unlocked: v.unlock !== null,
    reason: v.unlock?.reason ?? null,
    lockedHint: v.unlock
      ? null
      : {
          cashCents: v.bal.cash,
          debtCents: v.bal.debt,
          brokeCashCentsAtMost: cfg.unlock.brokeCashCentsAtMost,
          liquidationCashBelowCents: cfg.unlock.liquidationCashBelowCents,
        },
    employed: v.state?.employed ?? false,
    stintShifts: v.state?.stint_shifts ?? 0,
    netWorthCents: v.bal.cash - v.bal.debt,
    glowUpNetWorthCents: cfg.glowUpNetWorthCents,
    pay: {
      baseCents: cfg.pay.baseCents,
      perCorrectOrderCents: cfg.pay.perCorrectOrderCents,
      maxShiftCents: maxShiftPayCents(cfg),
      dailyCapCents: cfg.pay.dailyCapCents,
      earnedTodayCents: v.earned,
      remainingTodayCents: Math.max(0, cfg.pay.dailyCapCents - v.earned),
      resetsAt: nextUtcMidnight(now).toISOString(),
    },
    shift: v.open ? shiftView(cfg, v.open.shift_id, v.open.started_at) : null,
    uniformCosmeticId: cfg.uniformCosmeticId,
    hasUniform: v.hasUniform,
  };
}

/**
 * Open a shift. Idempotent while one is open (returns it). The first shift of a stint
 * starts the employment and writes the "Back to the trenches" post.
 * @throws JobLockedError when the job is not unlocked.
 * @throws JobDailyCapError when today's pay cap is already reached.
 */
export async function startShift(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<ShiftStartView & { resumed: boolean; postId: string | null }> {
  const cfg = rektConfig(ctx);
  const out = await runInTransaction(async (client) => {
    const unlock = await ensureUnlocked(client, cfg, userId, now);
    if (!unlock) {
      const bal = await readBalances(client, userId);
      throw new JobLockedError({
        jobId: REKT_BURGER_ID,
        cashCents: bal.cash,
        debtCents: bal.debt,
      });
    }
    const open = await liveOpenShift(client, cfg, userId, now);
    if (open) {
      return {
        view: shiftView(cfg, open.shift_id, open.started_at),
        resumed: true,
        postId: null,
        unlock,
      };
    }
    const earned = await paidToday(client, userId, now);
    if (earned >= cfg.pay.dailyCapCents) {
      throw new JobDailyCapError({
        dailyCapCents: cfg.pay.dailyCapCents,
        resetsAt: nextUtcMidnight(now).toISOString(),
      });
    }
    const shiftId = uuidv7();
    await client.query(
      `INSERT INTO rekt_burger_shifts (shift_id, user_id, status, started_at) VALUES ($1, $2, 'open', $3)`,
      [shiftId, userId, now],
    );
    const state = (await readState(client, userId, true))!;
    let postId: string | null = null;
    if (!state.employed) {
      const bal = await readBalances(client, userId);
      await client.query(
        `UPDATE rekt_burger_state
            SET employed = true, stint_started_at = $2, stint_networth_cents = $3,
                stint_shifts = 0, updated_at = $2
          WHERE user_id = $1`,
        [userId, now, bal.cash - bal.debt],
      );
      postId = await careerPost(
        client,
        cfg,
        userId,
        'back_to_trenches',
        POST_TEXT.back_to_trenches,
        now,
      );
    }
    return { view: shiftView(cfg, shiftId, now), resumed: false, postId, unlock };
  });
  if (out.unlock.newly) await announceUnlock(ctx, userId, out.unlock.reason, now);
  return { ...out.view, resumed: out.resumed, postId: out.postId };
}

export interface ShiftFinishResult {
  readonly shiftId: string;
  readonly orders: number;
  readonly correct: number;
  /** What was paid, in cents (after the shift and daily caps). */
  readonly payCents: number;
  /** Pay that the daily cap withheld. */
  readonly cappedCents: number;
  readonly remainingTodayCents: number;
  readonly uniformGranted: boolean;
}

/**
 * Finish a shift: validate the client's order timings against the server's own clock, then
 * pay. The result never carries a client amount.
 * @throws NotFoundError for a shift that is not the caller's (no IDOR).
 * @throws ConflictError for a shift already finished or void.
 * @throws ShiftNotFinishedError before the minimum duration (the shift stays open).
 * @throws ShiftResultImplausibleError for a report no player could produce (the shift is
 * burned).
 */
export async function finishShift(
  ctx: AppContext,
  userId: string,
  shiftIdOrNull: string | null,
  orders: readonly OrderReport[],
  now: Date = new Date(),
): Promise<ShiftFinishResult> {
  const cfg = rektConfig(ctx);
  await ensureRewardCatalog(ctx.db);
  type Outcome =
    | { kind: 'paid'; res: ShiftFinishResult }
    | { kind: 'void'; error: 'expired' | 'implausible'; reason: string; shiftId: string };
  const out: Outcome = await runInTransaction(async (client): Promise<Outcome> => {
    const sr = await client.query<ShiftRow>(
      `SELECT shift_id, status, started_at FROM rekt_burger_shifts
        WHERE user_id = $2 AND (shift_id = $1::uuid OR ($1::uuid IS NULL AND status = 'open'))
        ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [shiftIdOrNull, userId],
    );
    const shift = sr.rows[0];
    if (!shift) throw new NotFoundError({ kind: 'shift', id: shiftIdOrNull ?? 'open' });
    const shiftId = shift.shift_id;
    if (shift.status !== 'open') {
      throw new ConflictError({ shiftId, reason: `shift_${shift.status}` });
    }
    const state = await readState(client, userId, true);
    if (!state) throw new JobLockedError({ jobId: REKT_BURGER_ID });
    const elapsedMs = now.getTime() - shift.started_at.getTime();
    if (elapsedMs < cfg.shift.minDurationSec * 1000) {
      throw new ShiftNotFinishedError({
        shiftId,
        minFinishAt: new Date(
          shift.started_at.getTime() + cfg.shift.minDurationSec * 1000,
        ).toISOString(),
      });
    }
    const burn = async (error: 'expired' | 'implausible', reason: string): Promise<Outcome> => {
      await client.query(
        `UPDATE rekt_burger_shifts SET status = 'expired', finished_at = $2 WHERE shift_id = $1`,
        [shiftId, now],
      );
      return { kind: 'void', error, reason, shiftId };
    };
    if (elapsedMs > cfg.shift.maxDurationSec * 1000 + cfg.shift.toleranceMs) {
      return burn('expired', 'shift_expired');
    }
    const check = validateOrders(orders, elapsedMs, cfg.shift);
    if (!check.ok) return burn('implausible', check.reason);

    const earned = await paidToday(client, userId, now);
    const remaining = Math.max(0, cfg.pay.dailyCapCents - earned);
    const full = shiftPayCents(cfg, check.correct);
    const pay = Math.min(full, remaining);
    await client.query(
      `UPDATE rekt_burger_shifts
          SET status = 'done', finished_at = $2, orders = $3, correct = $4, pay_cents = $5
        WHERE shift_id = $1`,
      [shiftId, now, check.count, check.correct, pay],
    );
    if (pay > 0) {
      await creditCash(
        client,
        userId,
        pay,
        'job_rekt_burger',
        'rekt_burger_shift',
        shiftId,
        `rekt-burger:${shiftId}`,
      );
    }
    await client.query(
      `UPDATE rekt_burger_state SET stint_shifts = stint_shifts + 1, updated_at = $2 WHERE user_id = $1`,
      [userId, now],
    );
    // Same as a career shift: the clock for need decay restarts at completion.
    await client.query(`UPDATE needs SET last_action_at = $2 WHERE user_id = $1`, [userId, now]);
    const uniformGranted = await grantCosmetic(client, userId, cfg.uniformCosmeticId);
    return {
      kind: 'paid',
      res: {
        shiftId,
        orders: check.count,
        correct: check.correct,
        payCents: pay,
        cappedCents: full - pay,
        remainingTodayCents: remaining - pay,
        uniformGranted,
      },
    };
  });
  if (out.kind === 'void') {
    if (out.error === 'expired')
      throw new ConflictError({ shiftId: out.shiftId, reason: out.reason });
    throw new ShiftResultImplausibleError({ shiftId: out.shiftId, reason: out.reason });
  }
  await recordQuestEvent(ctx, userId, 'shift_complete', `rb:${out.res.shiftId}`, now);
  return out.res;
}

export interface LeaveResult {
  readonly employed: false;
  readonly wasEmployed: boolean;
  /** True when a Glow-up post was written. */
  readonly glowUp: boolean;
  readonly postId: string | null;
  readonly netWorthCents: number;
}

/**
 * Leave the job. A shift still open is voided. Leaving after a stint that began below the
 * glow-up net worth and ended at or above it, with at least one paid shift, writes the
 * "Glow-up" post.
 */
export async function leaveJob(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<LeaveResult> {
  const cfg = rektConfig(ctx);
  return runInTransaction(async (client) => {
    const state = await readState(client, userId, true);
    const bal = await readBalances(client, userId);
    const netWorth = bal.cash - bal.debt;
    if (!state || !state.employed) {
      return {
        employed: false,
        wasEmployed: false,
        glowUp: false,
        postId: null,
        netWorthCents: netWorth,
      };
    }
    await client.query(
      `UPDATE rekt_burger_shifts SET status = 'expired', finished_at = $2
        WHERE user_id = $1 AND status = 'open'`,
      [userId, now],
    );
    const started = Number(state.stint_networth_cents ?? '0');
    const recovered =
      state.stint_shifts >= 1 &&
      started < cfg.glowUpNetWorthCents &&
      netWorth >= cfg.glowUpNetWorthCents;
    let postId: string | null = null;
    if (recovered) {
      postId = await careerPost(
        client,
        cfg,
        userId,
        'glow_up',
        POST_TEXT.glow_up(cfg.glowUpNetWorthCents),
        now,
      );
    }
    await client.query(
      `UPDATE rekt_burger_state
          SET employed = false, stint_started_at = NULL, stint_networth_cents = NULL,
              stint_shifts = 0, updated_at = $2
        WHERE user_id = $1`,
      [userId, now],
    );
    return {
      employed: false,
      wasEmployed: true,
      glowUp: postId !== null,
      postId,
      netWorthCents: netWorth,
    };
  });
}
