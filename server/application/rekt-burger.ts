/**
 * Rekt Burger: the "blew my port" fallback job.
 *
 *   GET  /v1/jobs/rekt-burger                 unlocked?, why, my shift state, pay and caps
 *   POST /v1/jobs/rekt-burger/shift/start     clock in (near the counter)
 *   POST /v1/jobs/rekt-burger/shift/end       clock out: pay by server time
 *   GET  /v1/jobs/rekt-burger/shift/current   restore after a relaunch
 *   POST /v1/jobs/rekt-burger/leave           hang up the apron (pays an open shift)
 *
 * "Rekt Burger" is our own parody brand (no real chain's name, logo or likeness).
 *
 * Unlock. Trenchers have it from the start (their safety net). Everyone else unlocks it
 * for good when broke (Cash at or below 0 while in debt, checked whenever the job is read
 * or started) or when a perp liquidation leaves their Cash under a floor (checked right
 * after the liquidation). Thresholds are in `contract/config/careers.json` `rektBurger`.
 *
 * Pay is a humble faucet and is decided only by the server. It is a SIMPLE CLOCK-IN, like
 * The Sims: the player taps Clock in at the counter (their server-known position must be
 * within `counter.radiusM` of it and fresh), the avatar works in 3D (client-side animation
 * only), pay builds by real server time (`ratePerMinuteCents`, floor of elapsed seconds),
 * and Clock out pays. The player may leave the app: the shift runs on, and the server closes
 * it at `maxDurationSec` (a per-minute sweep, or on the next read) and pays up to there.
 * Pay is clamped to the UTC-day cap. The client sends no amount, no time and no position
 * that is trusted. The old per-ticket minigame endpoint (`/shift/finish`) answers 410.
 *
 * Timeline. Starting work after being out (the first shift of a stint) writes a "Back to
 * the trenches" post; leaving after a stint that began below the glow-up net worth and
 * ended above it writes a "Glow-up" post. Both are server-templated, one per cooldown.
 *
 * A shift of at least `minCountedSec` counts for the quests (`shift_complete`, and through
 * them Season XP) and earns career XP (`xpPerMinute`, under the shared daily action cap, and
 * only for a player who is on a ladder); a shorter one is paid but counts for neither, so
 * clocking in and out cannot farm them.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  JobDailyCapError,
  JobLockedError,
  CounterTooFarError,
  NotFoundError,
  PositionUnknownError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { nextUtcMidnight } from './daily-streak.js';
import { decodePos, POS_FRESH_MS, POS_HASH } from '../realtime/movement.js';
import { awardActionXpInTx, publishPromotion, type PromotionInfo } from './ladders.js';
import { publishToUser, refreshOutfit } from './realtime-bus.js';
import { recordOnboardingEvent } from './onboarding.js';
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
  /** Where the counter is (island metres) and how close a clock-in must be. */
  readonly counter: {
    readonly x: number;
    readonly z: number;
    readonly radiusM: number;
    readonly source: string;
  };
  readonly pay: {
    /** Cents per minute on the clock (pay = floor(seconds * rate / 60)). */
    readonly ratePerMinuteCents: number;
    readonly dailyCapCents: number;
  };
  readonly shift: {
    /** A shift never pays past this; the server closes it here. */
    readonly maxDurationSec: number;
    /** A shift shorter than this is paid but counts for no quest, XP or uniform. */
    readonly minCountedSec: number;
    /** Career XP per minute on the clock (floored). */
    readonly xpPerMinute: number;
  };
  readonly uniformCosmeticId: string;
}

/** The Rekt Burger config (cached by the context). */
export function rektConfig(ctx: AppContext): RektBurgerConfig {
  return ctx.configCache.load<{ rektBurger: RektBurgerConfig }>('careers').rektBurger;
}

/** The most one shift can pay, before the daily cap. */
export function maxShiftPayCents(cfg: RektBurgerConfig): number {
  return Math.floor((cfg.shift.maxDurationSec * cfg.pay.ratePerMinuteCents) / 60);
}

/** Pay for `seconds` on the clock, capped at the maximum shift. Integer cents. */
export function clockPayCents(cfg: RektBurgerConfig, seconds: number): number {
  const sec = Math.min(Math.max(0, Math.floor(seconds)), cfg.shift.maxDurationSec);
  return Math.floor((sec * cfg.pay.ratePerMinuteCents) / 60);
}

/** Career XP for `seconds` on the clock. */
export function clockXp(cfg: RektBurgerConfig, seconds: number): number {
  if (seconds < cfg.shift.minCountedSec) return 0;
  const sec = Math.min(Math.max(0, Math.floor(seconds)), cfg.shift.maxDurationSec);
  return Math.floor((sec * cfg.shift.xpPerMinute) / 60);
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

export type EndReason = 'clock_out' | 'auto' | 'left';

/** The moment an open shift started at `startedAt` is closed by the server. */
export function maxEndsAt(cfg: RektBurgerConfig, startedAt: Date): Date {
  return new Date(startedAt.getTime() + cfg.shift.maxDurationSec * 1000);
}

export interface ShiftView {
  readonly shiftId: string;
  readonly startedAt: string;
  readonly ratePerMinuteCents: number;
  /** What is left of today's cap (before this shift is paid). */
  readonly capRemainingCents: number;
  /** The server closes the shift here and pays up to it. */
  readonly maxEndsAt: string;
  /** What the shift would pay if it ended at `serverNow` (after the daily cap). */
  readonly accruedCents: number;
  readonly serverNow: string;
}

function shiftView(
  cfg: RektBurgerConfig,
  shiftId: string,
  startedAt: Date,
  capRemaining: number,
  now: Date,
): ShiftView {
  const seconds = Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
  return {
    shiftId,
    startedAt: startedAt.toISOString(),
    ratePerMinuteCents: cfg.pay.ratePerMinuteCents,
    capRemainingCents: capRemaining,
    maxEndsAt: maxEndsAt(cfg, startedAt).toISOString(),
    accruedCents: Math.min(clockPayCents(cfg, seconds), capRemaining),
    serverNow: now.toISOString(),
  };
}

export interface ShiftEndResult {
  readonly shiftId: string;
  /** What was paid, after the daily cap. */
  readonly paidCents: number;
  /** Whole minutes on the clock (capped at the maximum shift). */
  /** Total time on the clock in seconds (at most the maximum shift). */
  readonly durationSec: number;
  /** Whole minutes: floor(durationSec / 60). Not a remainder; do not add it to seconds. */
  readonly minutes: number;
  /** Career XP added (0 without a ladder, under the minimum, or past the daily action cap). */
  readonly careerXp: number;
  /** What the daily cap withheld from this shift. */
  readonly cappedCents: number;
  readonly capRemainingCents: number;
  /** First counted shift only: the Rekt Burger Uniform cosmetic. */
  readonly uniformGranted: boolean;
  readonly endReason: EndReason;
}

interface Settled {
  readonly result: ShiftEndResult;
  readonly promotion: PromotionInfo | null;
  readonly counted: boolean;
  readonly endedAt: Date;
}

/**
 * Close one OPEN shift (the row must already be locked by the caller) and pay it, inside
 * the caller's transaction. Pay is `floor(seconds * rate / 60)` of the time on the clock,
 * capped at the maximum shift and trimmed to what the UTC-day cap leaves. The shift's end
 * is `min(now, maxEndsAt)`, so a late sweep pays only up to the maximum, on the day worked.
 */
async function settleOpenShift(
  client: PoolClient,
  ctx: AppContext,
  cfg: RektBurgerConfig,
  userId: string,
  shift: ShiftRow,
  reason: EndReason,
  now: Date,
): Promise<Settled> {
  const limit = maxEndsAt(cfg, shift.started_at);
  const endedAt = now.getTime() > limit.getTime() ? limit : now;
  const seconds = Math.min(
    cfg.shift.maxDurationSec,
    Math.max(0, Math.floor((endedAt.getTime() - shift.started_at.getTime()) / 1000)),
  );
  const earned = await paidToday(client, userId, endedAt);
  const remaining = Math.max(0, cfg.pay.dailyCapCents - earned);
  const full = clockPayCents(cfg, seconds);
  const pay = Math.min(full, remaining);
  const counted = seconds >= cfg.shift.minCountedSec;
  const xp = clockXp(cfg, seconds);
  let careerXp = 0;
  let promotion: PromotionInfo | null = null;
  if (xp > 0) {
    const r = await awardActionXpInTx(
      client,
      ctx,
      userId,
      xp,
      `rekt_burger:${shift.shift_id}`,
      endedAt,
    );
    careerXp = r.added;
    promotion = r.promotion;
  }
  await client.query(
    `UPDATE rekt_burger_shifts
        SET status = 'done', finished_at = $2, pay_cents = $3, seconds = $4,
            end_reason = $5, career_xp = $6
      WHERE shift_id = $1`,
    [shift.shift_id, endedAt, pay, seconds, reason, careerXp],
  );
  if (pay > 0) {
    await creditCash(
      client,
      userId,
      pay,
      'job_rekt_burger',
      'rekt_burger_shift',
      shift.shift_id,
      `rekt-burger:${shift.shift_id}`,
    );
    await client.query(
      `UPDATE rekt_burger_state SET stint_shifts = stint_shifts + 1, updated_at = $2 WHERE user_id = $1`,
      [userId, endedAt],
    );
  }
  // Same as a career shift: the clock for need decay restarts at completion.
  await client.query(`UPDATE needs SET last_action_at = $2 WHERE user_id = $1`, [userId, endedAt]);
  const uniformGranted = counted
    ? await grantCosmetic(client, userId, cfg.uniformCosmeticId)
    : false;
  return {
    result: {
      shiftId: shift.shift_id,
      paidCents: pay,
      durationSec: seconds,
      minutes: Math.floor(seconds / 60),
      careerXp,
      cappedCents: full - pay,
      capRemainingCents: remaining - pay,
      uniformGranted,
      endReason: reason,
    },
    promotion,
    counted,
    endedAt,
  };
}

/** What happens after a shift settles and commits: the promotion notice and the quest. */
async function afterSettle(
  ctx: AppContext,
  userId: string,
  settled: Settled,
  now: Date,
): Promise<void> {
  // The shift is over: viewers see the player out of the crew outfit again.
  await refreshOutfit(ctx, userId);
  if (settled.promotion) await publishPromotion(ctx, userId, settled.promotion, now);
  if (settled.counted) {
    await recordQuestEvent(ctx, userId, 'shift_complete', `rb:${settled.result.shiftId}`, now);
  }
}

/** The caller's open shift row, locked, or null. */
async function lockOpenShift(client: PoolClient, userId: string): Promise<ShiftRow | null> {
  const r = await client.query<ShiftRow>(
    `SELECT shift_id, status, started_at FROM rekt_burger_shifts
      WHERE user_id = $1 AND status = 'open' FOR UPDATE`,
    [userId],
  );
  return r.rows[0] ?? null;
}

export interface LastShift {
  readonly shiftId: string;
  readonly endedAt: string;
  readonly paidCents: number;
  /** Total time on the clock in seconds. */
  readonly durationSec: number;
  /** floor(durationSec / 60). */
  readonly minutes: number;
  readonly careerXp: number;
  readonly endReason: EndReason | null;
}

async function lastShift(
  client: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<LastShift | null> {
  const r = await client.query<{
    shift_id: string;
    finished_at: Date;
    pay_cents: string;
    seconds: number | null;
    career_xp: number | null;
    end_reason: EndReason | null;
  }>(
    `SELECT shift_id, finished_at, pay_cents, seconds, career_xp, end_reason
       FROM rekt_burger_shifts WHERE user_id = $1 AND status = 'done'
      ORDER BY finished_at DESC LIMIT 1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    shiftId: row.shift_id,
    endedAt: row.finished_at.toISOString(),
    paidCents: Number(row.pay_cents),
    durationSec: row.seconds ?? 0,
    minutes: Math.floor((row.seconds ?? 0) / 60),
    careerXp: row.career_xp ?? 0,
    endReason: row.end_reason,
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
    readonly ratePerMinuteCents: number;
    readonly maxShiftCents: number;
    readonly maxShiftSec: number;
    readonly dailyCapCents: number;
    readonly earnedTodayCents: number;
    readonly remainingTodayCents: number;
    readonly resetsAt: string;
  };
  /** Where to stand to clock in (island metres). */
  readonly counter: { readonly x: number; readonly z: number; readonly radiusM: number };
  readonly shift: ShiftView | null;
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
  await closeExpiredFor(ctx, userId, now);
  const v = await runInTransaction(async (client) => {
    const unlock = await ensureUnlocked(client, cfg, userId, now);
    const state = unlock ? await readState(client, userId, false) : null;
    const bal = await readBalances(client, userId);
    const earned = await paidToday(client, userId, now);
    const open = unlock ? await lockOpenShift(client, userId) : null;
    const uniform = await client.query(
      `SELECT 1 FROM cosmetic_inventory ci JOIN cosmetic_items it ON it.item_id = ci.item_id
        WHERE ci.user_id = $1 AND it.item_key = $2`,
      [userId, cfg.uniformCosmeticId],
    );
    return { unlock, state, bal, earned, open, hasUniform: (uniform.rowCount ?? 0) > 0 };
  });
  if (v.unlock?.newly) await announceUnlock(ctx, userId, v.unlock.reason, now);
  const remaining = Math.max(0, cfg.pay.dailyCapCents - v.earned);
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
      ratePerMinuteCents: cfg.pay.ratePerMinuteCents,
      maxShiftCents: maxShiftPayCents(cfg),
      maxShiftSec: cfg.shift.maxDurationSec,
      dailyCapCents: cfg.pay.dailyCapCents,
      earnedTodayCents: v.earned,
      remainingTodayCents: remaining,
      resetsAt: nextUtcMidnight(now).toISOString(),
    },
    counter: { x: cfg.counter.x, z: cfg.counter.z, radiusM: cfg.counter.radiusM },
    shift: v.open ? shiftView(cfg, v.open.shift_id, v.open.started_at, remaining, now) : null,
    uniformCosmeticId: cfg.uniformCosmeticId,
    hasUniform: v.hasUniform,
  };
}

/** Close (and pay) the caller's open shift if it ran to its maximum. Never throws. */
async function closeExpiredFor(ctx: AppContext, userId: string, now: Date): Promise<void> {
  try {
    const cfg = rektConfig(ctx);
    await ensureRewardCatalog(ctx.db);
    const settled = await runInTransaction(async (client) => {
      const open = await lockOpenShift(client, userId);
      if (!open || now.getTime() < maxEndsAt(cfg, open.started_at).getTime()) return null;
      return settleOpenShift(client, ctx, cfg, userId, open, 'auto', now);
    });
    if (settled) await afterSettle(ctx, userId, settled, now);
  } catch (e) {
    console.error('[rekt-burger] auto-close failed:', (e as Error).message);
  }
}

/**
 * Close every open shift that ran to its maximum (the per-minute worker). Each is paid
 * up to the maximum, on the day it was worked.
 * @returns How many shifts were closed.
 */
export async function sweepRektShifts(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const cfg = rektConfig(ctx);
  const due = await ctx.db.withConnection((c) =>
    c.query<{ user_id: string }>(
      `SELECT user_id FROM rekt_burger_shifts
        WHERE status = 'open' AND started_at <= $1 ORDER BY started_at ASC LIMIT 200`,
      [new Date(now.getTime() - cfg.shift.maxDurationSec * 1000)],
    ),
  );
  let closed = 0;
  for (const { user_id } of due.rows) {
    const before = closed;
    await closeExpiredFor(ctx, user_id, now);
    const still = await ctx.db.withConnection((c) =>
      c.query(`SELECT 1 FROM rekt_burger_shifts WHERE user_id = $1 AND status = 'open'`, [user_id]),
    );
    if ((still.rowCount ?? 0) === 0) closed = before + 1;
  }
  return closed;
}

/**
 * Clock in. Idempotent while a shift is open (returns it with `resumed: true`, no position
 * needed). A new shift needs the server's own fresh position for the player (street room,
 * at most 30 s old) within `counter.radiusM` of the counter. The first shift of a stint
 * starts the employment and writes the "Back to the trenches" post.
 * @throws JobLockedError when the job is not unlocked.
 * @throws JobDailyCapError when today's pay cap is already reached.
 * @throws PositionUnknownError when the server has no fresh position.
 * @throws CounterTooFarError when the position is outside the counter radius.
 */
export async function startShift(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<ShiftView & { resumed: boolean; postId: string | null }> {
  const cfg = rektConfig(ctx);
  await closeExpiredFor(ctx, userId, now);
  const pos = decodePos(await ctx.redis.main.hget(POS_HASH, userId));
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
    const earned = await paidToday(client, userId, now);
    const remaining = Math.max(0, cfg.pay.dailyCapCents - earned);
    const open = await lockOpenShift(client, userId);
    if (open) {
      return {
        view: shiftView(cfg, open.shift_id, open.started_at, remaining, now),
        resumed: true,
        postId: null,
        unlock,
      };
    }
    if (remaining <= 0) {
      throw new JobDailyCapError({
        dailyCapCents: cfg.pay.dailyCapCents,
        resetsAt: nextUtcMidnight(now).toISOString(),
      });
    }
    if (!pos || now.getTime() - pos.at > POS_FRESH_MS) {
      throw new PositionUnknownError({ reason: 'no fresh position' });
    }
    const distance = Math.hypot(pos.x - cfg.counter.x, pos.z - cfg.counter.z);
    if (distance > cfg.counter.radiusM) {
      throw new CounterTooFarError({
        radiusM: cfg.counter.radiusM,
        distanceM: Math.round(distance),
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
    return {
      view: shiftView(cfg, shiftId, now, remaining, now),
      resumed: false,
      postId,
      unlock,
    };
  });
  if (out.unlock.newly) await announceUnlock(ctx, userId, out.unlock.reason, now);
  // A new shift puts the player in the crew outfit for everyone who can see them.
  if (!out.resumed) {
    await recordOnboardingEvent(ctx, userId, 'shift_start', `rb:${out.view.shiftId}`, now);
    await refreshOutfit(ctx, userId);
  }
  return { ...out.view, resumed: out.resumed, postId: out.postId };
}

/**
 * Clock out: close the caller's open shift and pay by server time. Two ends racing pay once
 * (the shift row is locked; the loser finds no open shift).
 * @throws NotFoundError when there is no open shift (never started, or already ended).
 */
export async function endShift(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<ShiftEndResult> {
  const cfg = rektConfig(ctx);
  await ensureRewardCatalog(ctx.db);
  const settled = await runInTransaction(async (client) => {
    const open = await lockOpenShift(client, userId);
    if (!open) throw new NotFoundError({ kind: 'shift', reason: 'no_open_shift' });
    const reason: EndReason =
      now.getTime() >= maxEndsAt(cfg, open.started_at).getTime() ? 'auto' : 'clock_out';
    return settleOpenShift(client, ctx, cfg, userId, open, reason, now);
  });
  await afterSettle(ctx, userId, settled, now);
  return settled.result;
}

export interface CurrentShift {
  readonly shift: ShiftView | null;
  /** The most recent finished shift, so a relaunch learns an auto-close paid. */
  readonly lastShift: LastShift | null;
}

/** The caller's open shift (closing it first if it ran to its maximum) and the last paid one. */
export async function getCurrentShift(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<CurrentShift> {
  const cfg = rektConfig(ctx);
  await closeExpiredFor(ctx, userId, now);
  return ctx.db.withConnection(async (client) => {
    const open = await client.query<ShiftRow>(
      `SELECT shift_id, status, started_at FROM rekt_burger_shifts
        WHERE user_id = $1 AND status = 'open'`,
      [userId],
    );
    const earned = await client.query<{ n: string }>(
      `SELECT COALESCE(SUM(pay_cents), 0) AS n FROM rekt_burger_shifts
        WHERE user_id = $1 AND status = 'done' AND finished_at >= $2 AND finished_at < $3`,
      [
        userId,
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
        nextUtcMidnight(now),
      ],
    );
    const remaining = Math.max(0, cfg.pay.dailyCapCents - Number(earned.rows[0]?.n ?? 0));
    const row = open.rows[0];
    return {
      shift: row ? shiftView(cfg, row.shift_id, row.started_at, remaining, now) : null,
      lastShift: await lastShift(client, userId),
    };
  });
}

export interface LeaveResult {
  readonly employed: false;
  readonly wasEmployed: boolean;
  /** True when a Glow-up post was written. */
  readonly glowUp: boolean;
  readonly postId: string | null;
  readonly netWorthCents: number;
  /** The open shift this paid on the way out, if there was one. */
  readonly endedShift: ShiftEndResult | null;
}

/**
 * Leave the job. A shift still open is clocked out and paid first. Leaving after a stint that
 * began below the glow-up net worth and ended at or above it, with at least one paid shift,
 * writes the "Glow-up" post.
 */
export async function leaveJob(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<LeaveResult> {
  const cfg = rektConfig(ctx);
  await ensureRewardCatalog(ctx.db);
  const out = await runInTransaction(async (client) => {
    const state = await readState(client, userId, true);
    const open = state ? await lockOpenShift(client, userId) : null;
    const settled = open
      ? await settleOpenShift(client, ctx, cfg, userId, open, 'left', now)
      : null;
    const fresh = settled ? await readState(client, userId, true) : state;
    const bal = await readBalances(client, userId);
    const netWorth = bal.cash - bal.debt;
    if (!fresh || !fresh.employed) {
      return {
        settled,
        res: {
          employed: false as const,
          wasEmployed: false,
          glowUp: false,
          postId: null,
          netWorthCents: netWorth,
          endedShift: settled?.result ?? null,
        },
      };
    }
    const started = Number(fresh.stint_networth_cents ?? '0');
    const recovered =
      fresh.stint_shifts >= 1 &&
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
      settled,
      res: {
        employed: false as const,
        wasEmployed: true,
        glowUp: postId !== null,
        postId,
        netWorthCents: netWorth,
        endedShift: settled?.result ?? null,
      },
    };
  });
  if (out.settled) await afterSettle(ctx, userId, out.settled, now);
  return out.res;
}
