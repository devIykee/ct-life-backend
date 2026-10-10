/**
 * Player businesses (build spec #30).
 *
 *   GET  /v1/businesses               - my open businesses
 *   POST /v1/businesses {kindId}      - buy one from the catalog
 *   GET  /v1/businesses/{id}          - one business + recent payouts
 *   POST /v1/businesses/{id}/collect  - move pending payouts to Cash
 *   POST /v1/businesses/{id}/sell     - sell back for `sellBackBps` of cost
 *
 * The catalog is contract/config/businesses.json. A business earns one
 * payout per `payoutPeriodHours` from purchase. Each period is rolled
 * against the bad-day table with a roll derived from (businessId,
 * periodIndex), so GET shows the same `pendingCents` that collect pays.
 * A normal day pays uniformly in `incomeRangeCents`; a bad day pays
 * `floor(min * badDayMultiplier)` and names a `badDays` reason. At most
 * `maxPendingPayouts` periods pile up; older uncollected ones lapse.
 *
 * Every Cash move is a ledger row in the same SERIALIZABLE transaction:
 * business_buy (-cost), business_pay (+payouts), business_sell (+refund).
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  ForbiddenError,
  InsufficientCashError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export interface BusinessKindConfig {
  readonly id: string;
  readonly name: string;
  readonly costCents: number;
  readonly incomeRangeCents: readonly [number, number];
  readonly badDayChanceBps: number;
  readonly badDayMultiplier: number;
  readonly payoutPeriodHours?: number;
  readonly sellBackBps?: number;
  readonly maxOwned?: number;
  readonly badDays?: ReadonlyArray<{ id: string; weight: number }>;
}

interface Catalog {
  readonly businesses: readonly BusinessKindConfig[];
  readonly maxPendingPayouts?: number;
}

export type DayKind = 'normal' | 'bad_day' | 'great_day';

export interface BusinessDay {
  readonly kind: DayKind;
  readonly payCents: number;
  readonly eventId?: string;
  readonly at: string;
}

export interface Business {
  readonly businessId: string;
  readonly kindId: string;
  readonly name: string;
  readonly boughtAt: string;
  readonly pendingCents: number;
  readonly nextPayoutAt: string;
  readonly sellBackCents: number;
  readonly lastDay: BusinessDay | null;
}

const HOUR_MS = 3_600_000;
const DEFAULT_PERIOD_HOURS = 24;
const DEFAULT_SELL_BACK_BPS = 5_000;
const DEFAULT_MAX_PENDING = 7;
const RECENT_DAYS = 30;

function catalog(ctx: AppContext): Catalog {
  return ctx.configCache.load<Catalog>('businesses');
}

function kindOf(ctx: AppContext, kindId: string): BusinessKindConfig | undefined {
  return catalog(ctx).businesses.find((b) => b.id === kindId);
}

const periodMs = (k: BusinessKindConfig): number =>
  (k.payoutPeriodHours ?? DEFAULT_PERIOD_HOURS) * HOUR_MS;

/** Sell-back refund in cents. */
export function sellBackCents(k: BusinessKindConfig): number {
  return Math.floor((k.costCents * (k.sellBackBps ?? DEFAULT_SELL_BACK_BPS)) / 10_000);
}

/** Three uniform [0, 1) draws (day, amount, reason) fixed by (businessId, periodIndex). */
function draws(businessId: string, periodIndex: number): [number, number, number] {
  const h = createHash('sha256').update(`${businessId}:${periodIndex}`).digest();
  return [h.readUInt32BE(0) / 2 ** 32, h.readUInt32BE(4) / 2 ** 32, h.readUInt32BE(8) / 2 ** 32];
}

/** Roll one payout period. Pure: the same inputs always give the same day. */
export function rollPeriod(
  k: BusinessKindConfig,
  businessId: string,
  periodIndex: number,
): { kind: DayKind; payCents: number; reasonId: string | null } {
  const [day, amount, reason] = draws(businessId, periodIndex);
  const [min, max] = k.incomeRangeCents;
  if (day * 10_000 < k.badDayChanceBps) {
    const reasons = k.badDays ?? [];
    const total = reasons.reduce((s, r) => s + r.weight, 0);
    let pick = reason * total;
    const reasonId = reasons.find((r) => (pick -= r.weight) < 0)?.id ?? null;
    return { kind: 'bad_day', payCents: Math.floor(min * k.badDayMultiplier), reasonId };
  }
  return { kind: 'normal', payCents: min + Math.floor(amount * (max - min + 1)), reasonId: null };
}

/**
 * The payout periods owed at `nowMs`: whole periods after
 * `accruedUntil`, only the newest `maxPending` of them.
 */
export function pendingPeriods(
  k: BusinessKindConfig,
  boughtAtMs: number,
  accruedUntilMs: number,
  nowMs: number,
  maxPending: number,
): { first: number; count: number; accruedUntilMs: number } {
  const p = periodMs(k);
  const doneIdx = Math.floor((accruedUntilMs - boughtAtMs) / p);
  const dueIdx = Math.floor((nowMs - boughtAtMs) / p);
  const first = Math.max(doneIdx, dueIdx - maxPending);
  return { first, count: Math.max(0, dueIdx - first), accruedUntilMs: boughtAtMs + dueIdx * p };
}

interface Row {
  business_id: string;
  owner_user_id: string;
  kind: string;
  cost_cents: string;
  created_at: Date;
  accrued_until: Date;
  closed_at: Date | null;
}

const COLS = `business_id, owner_user_id, kind, cost_cents, created_at, accrued_until, closed_at`;

interface DayRow {
  kind: DayKind;
  pay_cents: string;
  reason_id: string | null;
  day_date: Date;
}

function toDay(d: DayRow): BusinessDay {
  return {
    kind: d.kind,
    payCents: Number(d.pay_cents),
    ...(d.reason_id !== null ? { eventId: d.reason_id } : {}),
    at: d.day_date.toISOString(),
  };
}

function toBusiness(ctx: AppContext, r: Row, last: DayRow | undefined, nowMs: number): Business {
  const k = kindOf(ctx, r.kind)!;
  const bought = r.created_at.getTime();
  const due = pendingPeriods(k, bought, r.accrued_until.getTime(), nowMs, maxPending(ctx));
  let pendingCents = 0;
  for (let i = due.first; i < due.first + due.count; i++) {
    pendingCents += rollPeriod(k, r.business_id, i).payCents;
  }
  const nextIdx = Math.floor((nowMs - bought) / periodMs(k)) + 1;
  return {
    businessId: r.business_id,
    kindId: r.kind,
    name: k.name,
    boughtAt: r.created_at.toISOString(),
    pendingCents,
    nextPayoutAt: new Date(bought + nextIdx * periodMs(k)).toISOString(),
    sellBackCents: sellBackCents(k),
    lastDay: last ? toDay(last) : null,
  };
}

const maxPending = (ctx: AppContext): number =>
  catalog(ctx).maxPendingPayouts ?? DEFAULT_MAX_PENDING;

async function lastDays(c: PoolClient, businessId: string, limit: number): Promise<DayRow[]> {
  const r = await c.query<DayRow>(
    `SELECT kind, pay_cents, reason_id, day_date FROM business_days
     WHERE business_id = $1 ORDER BY period_index DESC NULLS LAST, day_date DESC LIMIT $2`,
    [businessId, limit],
  );
  return r.rows;
}

/** Lock an open, catalog business the caller owns. */
async function lockOwned(c: PoolClient, ctx: AppContext, id: string, userId: string): Promise<Row> {
  const r = await c.query<Row>(`SELECT ${COLS} FROM businesses WHERE business_id = $1 FOR UPDATE`, [
    id,
  ]);
  const row = r.rows[0];
  if (!row || row.closed_at !== null || !kindOf(ctx, row.kind)) {
    throw new NotFoundError({ kind: 'business', id });
  }
  if (row.owner_user_id !== userId) throw new ForbiddenError({ reason: 'not_owner' });
  return row;
}

async function moveCash(
  c: PoolClient,
  userId: string,
  deltaCents: number,
  reason: string,
  businessId: string,
): Promise<number> {
  const r = await c.query<{ cash_cents: string }>(
    `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now()
     WHERE user_id = $2 RETURNING cash_cents`,
    [deltaCents, userId],
  );
  await c.query(
    `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
     VALUES ($1, $2, 'cash', $3, 'business', $4, $5)`,
    [userId, deltaCents, reason, businessId, `${reason}:${businessId}:${uuidv7()}`],
  );
  return Number(r.rows[0]!.cash_cents);
}

/** My open businesses, newest first. Rows of retired kinds are not listed. */
export async function listOwned(ctx: AppContext, userId: string): Promise<{ owned: Business[] }> {
  const now = Date.now();
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<Row>(
      `SELECT ${COLS} FROM businesses
       WHERE owner_user_id = $1 AND closed_at IS NULL ORDER BY created_at DESC`,
      [userId],
    );
    const owned: Business[] = [];
    for (const row of r.rows) {
      if (!kindOf(ctx, row.kind)) continue;
      owned.push(toBusiness(ctx, row, (await lastDays(c, row.business_id, 1))[0], now));
    }
    return { owned };
  });
}

/** Buy a catalog business for its `costCents`. */
export async function buyBusiness(
  ctx: AppContext,
  userId: string,
  kindId: string,
): Promise<Business> {
  const k = kindOf(ctx, kindId);
  if (!k) throw new ValidationFailedError({ reason: 'unknown kindId', kindId });
  const row = await runInTransaction(async (c) => {
    const bal = await c.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const cash = Number(bal.rows[0]?.cash_cents ?? 0);
    if (cash < k.costCents) {
      throw new InsufficientCashError({ have: String(cash), need: String(k.costCents) });
    }
    const owned = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM businesses
       WHERE owner_user_id = $1 AND kind = $2 AND closed_at IS NULL`,
      [userId, kindId],
    );
    if (Number(owned.rows[0]!.n) >= (k.maxOwned ?? 1)) {
      throw new ForbiddenError({ reason: 'max_owned', maxOwned: k.maxOwned ?? 1 });
    }
    const id = uuidv7();
    const r = await c.query<Row>(
      `INSERT INTO businesses
         (business_id, owner_user_id, kind, rent_cents_per_week, income_min_cents, income_max_cents, cost_cents)
       VALUES ($1, $2, $3, 0, $4, $5, $6) RETURNING ${COLS}`,
      [id, userId, kindId, k.incomeRangeCents[0], k.incomeRangeCents[1], k.costCents],
    );
    await moveCash(c, userId, -k.costCents, 'business_buy', id);
    return r.rows[0]!;
  });
  return toBusiness(ctx, row, undefined, Date.now());
}

/** One business and its recent payouts. Owner only. */
export async function getBusiness(
  ctx: AppContext,
  userId: string,
  businessId: string,
): Promise<{ business: Business; recentDays: BusinessDay[] }> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<Row>(`SELECT ${COLS} FROM businesses WHERE business_id = $1`, [
      businessId,
    ]);
    const row = r.rows[0];
    if (!row || row.owner_user_id !== userId || !kindOf(ctx, row.kind)) {
      throw new NotFoundError({ kind: 'business', id: businessId });
    }
    const days = await lastDays(c, businessId, RECENT_DAYS);
    return { business: toBusiness(ctx, row, days[0], Date.now()), recentDays: days.map(toDay) };
  });
}

/** Write the owed periods as business_days rows and pay them. */
async function collectLocked(
  c: PoolClient,
  ctx: AppContext,
  row: Row,
  nowMs: number,
): Promise<{ collectedCents: number; cashCents: number | null; days: BusinessDay[] }> {
  const k = kindOf(ctx, row.kind)!;
  const bought = row.created_at.getTime();
  const due = pendingPeriods(k, bought, row.accrued_until.getTime(), nowMs, maxPending(ctx));
  const days: BusinessDay[] = [];
  let collectedCents = 0;
  for (let i = due.first; i < due.first + due.count; i++) {
    const roll = rollPeriod(k, row.business_id, i);
    const at = new Date(bought + (i + 1) * periodMs(k));
    await c.query(
      `INSERT INTO business_days (day_id, business_id, day_date, pay_cents, kind, description, period_index, reason_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        uuidv7(),
        row.business_id,
        at,
        roll.payCents,
        roll.kind,
        roll.reasonId ?? roll.kind,
        i,
        roll.reasonId,
      ],
    );
    collectedCents += roll.payCents;
    days.push({
      kind: roll.kind,
      payCents: roll.payCents,
      ...(roll.reasonId ? { eventId: roll.reasonId } : {}),
      at: at.toISOString(),
    });
  }
  await c.query(`UPDATE businesses SET accrued_until = $1 WHERE business_id = $2`, [
    new Date(due.accruedUntilMs),
    row.business_id,
  ]);
  const cashCents =
    collectedCents > 0
      ? await moveCash(c, row.owner_user_id, collectedCents, 'business_pay', row.business_id)
      : null;
  return { collectedCents, cashCents, days };
}

async function cashOf(c: PoolClient, userId: string): Promise<number> {
  const r = await c.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? 0);
}

/** Move every pending payout to Cash. Nothing pending pays 0. */
export async function collectBusiness(
  ctx: AppContext,
  userId: string,
  businessId: string,
): Promise<{ collectedCents: number; cashCents: number; days: BusinessDay[] }> {
  return runInTransaction(async (c) => {
    const row = await lockOwned(c, ctx, businessId, userId);
    const out = await collectLocked(c, ctx, row, Date.now());
    return { ...out, cashCents: out.cashCents ?? (await cashOf(c, userId)) };
  });
}

/** Sell back: pending payouts are collected first, then the refund is paid. */
export async function sellBusiness(
  ctx: AppContext,
  userId: string,
  businessId: string,
): Promise<{ refundCents: number; collectedCents: number; cashCents: number }> {
  return runInTransaction(async (c) => {
    const row = await lockOwned(c, ctx, businessId, userId);
    const { collectedCents } = await collectLocked(c, ctx, row, Date.now());
    const refundCents = sellBackCents(kindOf(ctx, row.kind)!);
    await c.query(`UPDATE businesses SET closed_at = now() WHERE business_id = $1`, [businessId]);
    const cashCents =
      refundCents > 0
        ? await moveCash(c, userId, refundCents, 'business_sell', businessId)
        : await cashOf(c, userId);
    return { refundCents, collectedCents, cashCents };
  });
}
