/**
 * Player businesses service (M5 #62).
 *
 * Endpoints:
 *
 *   POST /v1/businesses                  — found a business (kind +
 *                                          initial rent debit; rent
 *                                          uses the M4 homes rent
 *                                          model but keyed off
 *                                          businesses.kind).
 *   GET  /v1/businesses/{id}             — get a business + recent days.
 *   POST /v1/businesses/{id}/run         — daily 'open' that returns
 *                                          today's pay (normal,
 *                                          bad_day, or great_day).
 *                                          Inserts a business_days
 *                                          row and credits the owner's
 *                                          cash via a 'business_pay'
 *                                          ledger row.
 *
 * The bad-day table lives in `contract/config/businesses.json`
 * (per-kind probability). The dev path uses the in-memory
 * BAD_DAY_TABLE below; production reads from the config
 * file. Either way, the application is the only writer of
 * business_days.kind, and the row's pay_cents matches the
 * outcome:
 *
 *   bad_day    -> 0
 *   normal     -> random in [income_min, income_max]
 *   great_day  -> income_max
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type BusinessKind = 'lemonade_stand' | 'laundromat' | 'cafe' | 'shop' | 'arcade';

export type DayKind = 'normal' | 'bad_day' | 'great_day';

export interface BusinessRow {
  readonly businessId: string;
  readonly ownerUserId: string;
  readonly kind: BusinessKind;
  readonly rentCentsPerWeek: number;
  readonly incomeMinCents: number;
  readonly incomeMaxCents: number;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export interface BusinessDayRow {
  readonly dayId: string;
  readonly businessId: string;
  readonly dayDate: string;
  readonly payCents: number;
  readonly kind: DayKind;
  readonly description: string;
}

const KIND_CONFIG: Record<
  BusinessKind,
  {
    rentCentsPerWeek: number;
    incomeMinCents: number;
    incomeMaxCents: number;
    badDayPct: number;
    greatDayPct: number;
  }
> = {
  lemonade_stand: {
    rentCentsPerWeek: 2_000,
    incomeMinCents: 500,
    incomeMaxCents: 4_000,
    badDayPct: 30,
    greatDayPct: 10,
  },
  laundromat: {
    rentCentsPerWeek: 8_000,
    incomeMinCents: 3_000,
    incomeMaxCents: 12_000,
    badDayPct: 20,
    greatDayPct: 15,
  },
  cafe: {
    rentCentsPerWeek: 20_000,
    incomeMinCents: 8_000,
    incomeMaxCents: 30_000,
    badDayPct: 15,
    greatDayPct: 20,
  },
  shop: {
    rentCentsPerWeek: 15_000,
    incomeMinCents: 5_000,
    incomeMaxCents: 22_000,
    badDayPct: 20,
    greatDayPct: 15,
  },
  arcade: {
    rentCentsPerWeek: 25_000,
    incomeMinCents: 10_000,
    incomeMaxCents: 40_000,
    badDayPct: 18,
    greatDayPct: 18,
  },
};

const BAD_DAY_LINES = [
  'Power outage — closed early.',
  'No customers showed up.',
  'Equipment broke down.',
  'Health inspector shut us down for the day.',
];
const GREAT_DAY_LINES = [
  'Sold out before noon.',
  'Viral on CT — line around the block.',
  'Big-spending whale came through.',
  'Local KOL dropped in for a photo.',
];

interface BusinessDbRow {
  business_id: string;
  owner_user_id: string;
  kind: BusinessKind;
  rent_cents_per_week: string;
  income_min_cents: string;
  income_max_cents: string;
  created_at: Date;
  closed_at: Date | null;
}

interface BusinessDayDbRow {
  day_id: string;
  business_id: string;
  day_date: Date;
  pay_cents: string;
  kind: DayKind;
  description: string;
}

function rowToBiz(r: BusinessDbRow): BusinessRow {
  return {
    businessId: r.business_id,
    ownerUserId: r.owner_user_id,
    kind: r.kind,
    rentCentsPerWeek: Number(r.rent_cents_per_week),
    incomeMinCents: Number(r.income_min_cents),
    incomeMaxCents: Number(r.income_max_cents),
    createdAt: r.created_at.toISOString(),
    closedAt: r.closed_at ? r.closed_at.toISOString() : null,
  };
}

function rowToDay(r: BusinessDayDbRow): BusinessDayRow {
  const d = r.day_date;
  const dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return {
    dayId: r.day_id,
    businessId: r.business_id,
    dayDate: dateStr,
    payCents: Number(r.pay_cents),
    kind: r.kind,
    description: r.description,
  };
}

function todayUtc(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Found a business; debits the first week's rent. */
export async function createBusiness(
  _ctx: AppContext,
  ownerUserId: string,
  kind: BusinessKind,
): Promise<BusinessRow> {
  const cfg = KIND_CONFIG[kind];
  if (!cfg) {
    throw new ValidationFailedError({ reason: `unknown business kind ${kind}` });
  }
  const businessId = uuidv7();
  const result = await runInTransaction(async (client) => {
    // Lock + check the owner's balance for the first week rent.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [ownerUserId],
    );
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [ownerUserId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(cfg.rentCentsPerWeek)) {
      throw new ValidationFailedError({
        reason: 'insufficient cash for first week rent',
        have: cash.toString(),
        need: cfg.rentCentsPerWeek.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [cfg.rentCentsPerWeek, ownerUserId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'business_rent', 'business', $3, $4)`,
      [ownerUserId, -cfg.rentCentsPerWeek, businessId, `biz-rent:${businessId}:${uuidv7()}`],
    );
    const r = await client.query<BusinessDbRow>(
      `INSERT INTO businesses (business_id, owner_user_id, kind, rent_cents_per_week, income_min_cents, income_max_cents)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING business_id, owner_user_id, kind, rent_cents_per_week, income_min_cents, income_max_cents, created_at, closed_at`,
      [businessId, ownerUserId, kind, cfg.rentCentsPerWeek, cfg.incomeMinCents, cfg.incomeMaxCents],
    );
    return r.rows[0]!;
  });
  return rowToBiz(result);
}

/** Read a business + its last 30 days. */
export async function getBusiness(
  ctx: AppContext,
  businessId: string,
): Promise<{
  business: BusinessRow;
  recentDays: BusinessDayRow[];
}> {
  const biz = await ctx.db.withConnection(async (c) => {
    const r = await c.query<BusinessDbRow>(
      `SELECT business_id, owner_user_id, kind, rent_cents_per_week, income_min_cents, income_max_cents, created_at, closed_at
       FROM businesses WHERE business_id = $1`,
      [businessId],
    );
    return r.rows[0];
  });
  if (!biz) throw new NotFoundError({ reason: 'business not found', businessId });
  const days = await ctx.db.withConnection(async (c) => {
    const r = await c.query<BusinessDayDbRow>(
      `SELECT day_id, business_id, day_date, pay_cents, kind, description
       FROM business_days WHERE business_id = $1
       ORDER BY day_date DESC LIMIT 30`,
      [businessId],
    );
    return r.rows.map(rowToDay);
  });
  return { business: rowToBiz(biz), recentDays: days };
}

/** Run today's business. Idempotent on (business_id, day_date). */
export async function runBusiness(
  _ctx: AppContext,
  businessId: string,
  ownerUserId: string,
  rng: () => number = Math.random,
): Promise<BusinessDayRow> {
  const dayId = uuidv7();
  const result = await runInTransaction(async (client) => {
    // Lock + read the business.
    const bizR = await client.query<BusinessDbRow>(
      `SELECT business_id, owner_user_id, kind, rent_cents_per_week, income_min_cents, income_max_cents, created_at, closed_at
       FROM businesses WHERE business_id = $1 FOR UPDATE`,
      [businessId],
    );
    const biz = bizR.rows[0];
    if (!biz) throw new NotFoundError({ reason: 'business not found', businessId });
    if (biz.owner_user_id !== ownerUserId) {
      throw new ForbiddenError({ reason: 'not the owner' });
    }
    if (biz.closed_at) {
      throw new ValidationFailedError({ reason: 'business is closed' });
    }
    const cfg = KIND_CONFIG[biz.kind];
    const dayDate = todayUtc();
    // Idempotency: if today's row already exists, return it
    // without crediting again.
    const existingR = await client.query<BusinessDayDbRow>(
      `SELECT day_id, business_id, day_date, pay_cents, kind, description
       FROM business_days WHERE business_id = $1 AND day_date = $2`,
      [businessId, dayDate],
    );
    if (existingR.rows[0]) {
      return existingR.rows[0];
    }
    // Roll the day.
    const r = rng() * 100;
    let kind: DayKind;
    let payCents: number;
    let description: string;
    if (r < cfg.badDayPct) {
      kind = 'bad_day';
      payCents = 0;
      description = BAD_DAY_LINES[Math.floor(rng() * BAD_DAY_LINES.length)]!;
    } else if (r < cfg.badDayPct + cfg.greatDayPct) {
      kind = 'great_day';
      payCents = cfg.incomeMaxCents;
      description = GREAT_DAY_LINES[Math.floor(rng() * GREAT_DAY_LINES.length)]!;
    } else {
      kind = 'normal';
      const span = cfg.incomeMaxCents - cfg.incomeMinCents;
      payCents = cfg.incomeMinCents + Math.floor(rng() * (span + 1));
      description = 'A regular day at the shop.';
    }
    if (payCents > 0) {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [ownerUserId],
      );
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
        [payCents, ownerUserId],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'business_pay', 'business', $3, $4)`,
        [ownerUserId, payCents, businessId, `biz-pay:${businessId}:${dayDate}:${uuidv7()}`],
      );
    }
    await client.query(
      `INSERT INTO business_days (day_id, business_id, day_date, pay_cents, kind, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [dayId, businessId, dayDate, payCents, kind, description],
    );
    return {
      day_id: dayId,
      business_id: businessId,
      day_date: new Date(`${dayDate}T00:00:00Z`),
      pay_cents: payCents.toString(),
      kind,
      description,
    };
  });
  return rowToDay(result);
}

void NotFoundError;
