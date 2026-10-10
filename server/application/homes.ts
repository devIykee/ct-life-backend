/**
 * Homes service (rent, visit, decorate).
 *
 * Endpoints:
 *
 *   POST /v1/homes                       — create (kind + initial rent debit)
 *   POST /v1/homes/{homeId}/rent         — weekly rent; debits rent_cents_per_week
 *                                           from owner's cash via 'rent' ledger row
 *   POST /v1/homes/{ownerId}/visit       — record a visit; appends a home_visits row
 *   GET  /v1/homes/{id}                  — get a home + recent visits
 *
 * Weekly rent is debited by `server/workers/rent.ts` (the rent
 * worker) at Monday 00:00 UTC. When the owner has insufficient
 * cash the worker leaves last_rent_paid_at unchanged and credits
 * `debt_cents` on the balances table by `rent_cents_per_week`
 * (the exit-liquidity-baby semantics from the spec).
 */
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type HomeKind =
  'parents_basement' | 'hacker_house' | 'studio' | 'penthouse' | 'marina_villa';

export interface HomeRow {
  readonly homeId: string;
  readonly ownerUserId: string;
  readonly kind: HomeKind;
  readonly rentCentsPerWeek: number;
  readonly decoratedAt: string | null;
  readonly lastRentPaidAt: string | null;
  readonly createdAt: string;
}

export interface VisitRow {
  readonly visitId: string;
  readonly homeId: string;
  readonly visitorUserId: string;
  readonly visitedAt: string;
}

const RENT_BY_KIND: Record<HomeKind, number> = {
  parents_basement: 2_000, // $20 / week
  hacker_house: 6_000, // $60 / week
  studio: 18_000, // $180 / week
  penthouse: 150_000, // $1500 / week
  marina_villa: 500_000, // $5000 / week
};

const MAX_VISITS_PER_GET = 50;

/**
 * B26: List available home types with their rent prices.
 * Returns the home types catalog for the shop/selection UI.
 */
export async function listHomeTypes(_ctx: AppContext): Promise<
  Array<{ id: HomeKind; name: string; rentCentsPerWeek: number }>
> {
  return [
    { id: 'parents_basement', name: "Parent's Basement", rentCentsPerWeek: 2_000 },
    { id: 'hacker_house', name: 'Hacker House', rentCentsPerWeek: 6_000 },
    { id: 'studio', name: 'Studio', rentCentsPerWeek: 18_000 },
    { id: 'penthouse', name: 'Penthouse', rentCentsPerWeek: 150_000 },
    { id: 'marina_villa', name: 'Marina Villa', rentCentsPerWeek: 500_000 },
  ];
}

/** Resolve a home's row from the DB. */
async function selectHome(ctx: AppContext, homeId: string): Promise<HomeRow | null> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{
      home_id: string;
      owner_user_id: string;
      kind: HomeKind;
      rent_cents_per_week: string;
      decorated_at: Date | null;
      last_rent_paid_at: Date | null;
      created_at: Date;
    }>(
      `SELECT home_id, owner_user_id, kind, rent_cents_per_week, decorated_at, last_rent_paid_at, created_at
       FROM homes WHERE home_id = $1`,
      [homeId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      homeId: row.home_id,
      ownerUserId: row.owner_user_id,
      kind: row.kind,
      rentCentsPerWeek: Number(row.rent_cents_per_week),
      decoratedAt: row.decorated_at ? row.decorated_at.toISOString() : null,
      lastRentPaidAt: row.last_rent_paid_at ? row.last_rent_paid_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    };
  });
}

/** Create a home for a user. Idempotent on (owner, kind). */
export async function createHome(
  ctx: AppContext,
  ownerUserId: string,
  kind: HomeKind,
): Promise<HomeRow> {
  const rent = RENT_BY_KIND[kind];
  if (rent === undefined) {
    throw new ValidationFailedError({ reason: `unknown home kind ${kind}` });
  }
  const homeId = `home:${uuidv7()}`;
  let ok = false;
  try {
    await runInTransaction(async (client) => {
      await client.query(
        `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, last_rent_paid_at)
         VALUES ($1, $2, $3, $4, now())`,
        [homeId, ownerUserId, kind, rent],
      );
      // Initial rent debit; the worker will debit every Monday.
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
      if (cash < BigInt(rent)) {
        throw new ValidationFailedError({
          reason: 'insufficient cash for initial rent',
          have: cash.toString(),
          need: rent.toString(),
        });
      }
      await client.query(
        `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
        [rent, ownerUserId],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'rent', 'home', $3, $4)`,
        [ownerUserId, -rent, homeId, `home-rent-init:${homeId}`],
      );
      ok = true;
    });
  } catch (e) {
    // 23505 = duplicate (owner_user_id, kind) — we keep the
    // existing home. Look it up and return it.
    if ((e as { code?: string }).code === '23505' || !ok) {
      const existing = await ctx.db.withConnection(async (c) => {
        return c.query<{ home_id: string }>(
          `SELECT home_id FROM homes WHERE owner_user_id = $1 AND kind = $2 LIMIT 1`,
          [ownerUserId, kind],
        );
      });
      const row = existing.rows[0];
      if (row) return selectHomeRequired(ctx, row.home_id);
      throw e;
    }
    throw e;
  }
  return selectHomeRequired(ctx, homeId);
}

async function selectHomeRequired(ctx: AppContext, homeId: string): Promise<HomeRow> {
  const row = await selectHome(ctx, homeId);
  if (!row) throw new NotFoundError({ resource: 'home', id: homeId });
  return row;
}

/** Owner pays rent manually (e.g. mid-week). */
export async function payRent(
  _ctx: AppContext,
  homeId: string,
  callerUserId: string,
): Promise<HomeRow> {
  let result: HomeRow | null = null;
  await runInTransaction(async (client) => {
    // home_id is an instance id ('home:<uuid>'), but clients hold the home
    // *kind* ('studio'), which 404'd. Match the instance id first, then fall
    // back to the caller's own home of that kind.
    const r = await client.query<{
      home_id: string;
      owner_user_id: string;
      rent_cents_per_week: string;
      last_rent_paid_at: Date | null;
    }>(
      `SELECT home_id, owner_user_id, rent_cents_per_week, last_rent_paid_at
         FROM homes
        WHERE home_id = $1
           OR (kind = $1 AND owner_user_id = $2)
        ORDER BY (home_id = $1) DESC
        LIMIT 1
          FOR UPDATE`,
      [homeId, callerUserId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError({ resource: 'home', id: homeId });
    // Everything below must use the resolved instance id, never the raw
    // path param, which may be a kind.
    const resolvedHomeId = row.home_id;
    if (row.owner_user_id !== callerUserId) {
      throw new ValidationFailedError({ reason: 'only owner can pay rent' });
    }
    const rent = Number(row.rent_cents_per_week);
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [callerUserId],
    );
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [callerUserId],
    );
    const cash = BigInt(bal.rows[0]?.cash_cents ?? '0');
    if (cash < BigInt(rent)) {
      throw new ValidationFailedError({
        reason: 'insufficient cash',
        have: cash.toString(),
        need: rent.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [rent, callerUserId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'rent', 'home', $3, $4)`,
      [callerUserId, -rent, resolvedHomeId, `home-rent:${uuidv7()}`],
    );
    await client.query(`UPDATE homes SET last_rent_paid_at = now() WHERE home_id = $1`, [
      resolvedHomeId,
    ]);
    const after = await client.query<{
      home_id: string;
      owner_user_id: string;
      kind: HomeKind;
      rent_cents_per_week: string;
      decorated_at: Date | null;
      last_rent_paid_at: Date | null;
      created_at: Date;
    }>(
      `SELECT home_id, owner_user_id, kind, rent_cents_per_week, decorated_at, last_rent_paid_at, created_at
       FROM homes WHERE home_id = $1`,
      [resolvedHomeId],
    );
    const r2 = after.rows[0];
    if (!r2) throw new NotFoundError({ resource: 'home', id: resolvedHomeId });
    result = {
      homeId: r2.home_id,
      ownerUserId: r2.owner_user_id,
      kind: r2.kind,
      rentCentsPerWeek: Number(r2.rent_cents_per_week),
      decoratedAt: r2.decorated_at ? r2.decorated_at.toISOString() : null,
      lastRentPaidAt: r2.last_rent_paid_at ? r2.last_rent_paid_at.toISOString() : null,
      createdAt: r2.created_at.toISOString(),
    };
  });
  if (!result) throw new NotFoundError({ resource: 'home', id: homeId });
  return result;
}

/** Record a visit. */
export async function recordVisit(
  ctx: AppContext,
  homeId: string,
  visitorUserId: string,
): Promise<VisitRow> {
  // The route passes the path param of POST /v1/homes/{ownerId}/visit, so
  // this is an owner's user id, not a home id. Resolving it as home_id
  // meant every visit 404'd. Owner first, then an instance id or kind so a
  // caller holding either still works.
  const found = await ctx.db.withConnection(async (c) => {
    return c.query<{ home_id: string }>(
      `SELECT home_id FROM homes
        WHERE owner_user_id::text = $1 OR home_id = $1 OR kind = $1
        ORDER BY (owner_user_id::text = $1) DESC, created_at ASC
        LIMIT 1`,
      [homeId],
    );
  });
  const resolvedHomeId = found.rows[0]?.home_id;
  if (resolvedHomeId === undefined) throw new NotFoundError({ resource: 'home', id: homeId });
  const visitId = uuidv7();
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO home_visits (visit_id, home_id, visitor_user_id) VALUES ($1, $2, $3)`,
      [visitId, resolvedHomeId, visitorUserId],
    );
  });
  return {
    visitId,
    homeId: resolvedHomeId,
    visitorUserId,
    visitedAt: new Date().toISOString(),
  };
}

/** Get a home + recent visits. */
export async function getHome(
  ctx: AppContext,
  homeId: string,
): Promise<{ home: HomeRow; visits: VisitRow[] }> {
  const home = await selectHomeRequired(ctx, homeId);
  const visits = await ctx.db.withConnection(async (c) => {
    return c.query<{
      visit_id: string;
      home_id: string;
      visitor_user_id: string;
      visited_at: Date;
    }>(
      `SELECT visit_id, home_id, visitor_user_id, visited_at FROM home_visits
       WHERE home_id = $1 ORDER BY visited_at DESC LIMIT $2`,
      [homeId, MAX_VISITS_PER_GET],
    );
  });
  return {
    home,
    visits: visits.rows.map((row) => ({
      visitId: row.visit_id,
      homeId: row.home_id,
      visitorUserId: row.visitor_user_id,
      visitedAt: row.visited_at.toISOString(),
    })),
  };
}
