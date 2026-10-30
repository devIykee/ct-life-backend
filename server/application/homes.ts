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
 *   POST /v1/homes/{homeId}/move-out     — give the home up; frees its unit
 *   POST|DELETE /v1/homes/{homeId}/guests/{userId}
 *                                        — owner lets someone through the door
 *
 * A lease also takes a free unit (a door) of its tier, see home-units.ts.
 * A visit to a home that has a door needs access to it: the owner or a
 * guest, else 403 FORBIDDEN.
 *
 * Weekly rent is debited by `server/workers/rent.ts` (the rent
 * worker) at Monday 00:00 UTC. When the owner has insufficient
 * cash the worker leaves last_rent_paid_at unchanged and credits
 * `debt_cents` on the balances table by `rent_cents_per_week`
 * (the exit-liquidity-baby semantics from the spec).
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  ForbiddenError,
  NoFreeUnitError,
  NotFoundError,
  NotHomeOwnerError,
  UnitFullError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { notifyHomeVisit } from './push-delivery.js';
import { HOME_VISIT_COOLDOWN_DAYS, recordQuestEvent } from './quests.js';
import type { AppContext } from './context.js';
import {
  accessToHome,
  ensureUnitsSynced,
  publishHomeAccess,
  takeFreeUnit,
  type HomeStatus,
  type HomeTier,
} from './home-units.js';

export type HomeKind =
  'parents_basement' | 'hacker_house' | 'studio' | 'penthouse' | 'marina_villa';

export interface HomeRow {
  readonly homeId: string;
  readonly ownerUserId: string;
  readonly kind: HomeKind;
  /** The door this lease holds; null for a tier without doors, or once given up. */
  readonly unitId: string | null;
  readonly tier: HomeTier;
  readonly roomType: string | null;
  readonly status: HomeStatus;
  readonly missedWeeks: number;
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

/** A visit plus the door the visitor may open (null for a home without one). */
export interface VisitResult extends VisitRow {
  readonly unitId: string | null;
  readonly roomType: string | null;
}

/** The player's current home, as `GET /me` reports it. */
export interface MeHome {
  readonly homeId: string;
  /** The home kind (`studio`, ...) of this lease. */
  readonly kind: HomeKind;
  readonly unitId: string | null;
  readonly tier: HomeTier;
  readonly roomType: string | null;
  readonly status: HomeStatus;
  readonly missedWeeks: number;
}

/** Which door tier each home kind lives in. */
export const TIER_BY_KIND: Record<HomeKind, HomeTier> = {
  parents_basement: 'basement',
  hacker_house: 'flat',
  studio: 'flat',
  penthouse: 'penthouse',
  marina_villa: 'penthouse',
};

/** Weekly rent misses before the rent worker evicts. [Inference: tuning value] */
export const EVICT_AFTER_MISSED_WEEKS = 4;

const HOME_COLUMNS = `h.home_id, h.owner_user_id, h.kind, h.rent_cents_per_week, h.decorated_at,
       h.last_rent_paid_at, h.created_at, h.unit_id, h.status, h.missed_weeks, u.room_type`;
const HOME_FROM = `FROM homes h LEFT JOIN home_units u ON u.unit_id = h.unit_id`;

interface HomeDbRow {
  home_id: string;
  owner_user_id: string;
  kind: HomeKind;
  rent_cents_per_week: string;
  decorated_at: Date | null;
  last_rent_paid_at: Date | null;
  created_at: Date;
  unit_id: string | null;
  status: HomeStatus;
  missed_weeks: number;
  room_type: string | null;
}

/** A home holds its unit only while active or overdue. */
function isLive(status: HomeStatus): boolean {
  return status === 'active' || status === 'overdue';
}

function toHomeRow(row: HomeDbRow): HomeRow {
  const live = isLive(row.status);
  return {
    homeId: row.home_id,
    ownerUserId: row.owner_user_id,
    kind: row.kind,
    unitId: live ? row.unit_id : null,
    tier: TIER_BY_KIND[row.kind],
    roomType: live ? row.room_type : null,
    status: row.status,
    missedWeeks: row.missed_weeks,
    rentCentsPerWeek: Number(row.rent_cents_per_week),
    decoratedAt: row.decorated_at ? row.decorated_at.toISOString() : null,
    lastRentPaidAt: row.last_rent_paid_at ? row.last_rent_paid_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** Weekly rent per home kind, in cents (the first week is paid on lease or move). */
export const RENT_BY_KIND: Record<HomeKind, number> = {
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
export async function listHomeTypes(
  _ctx: AppContext,
): Promise<Array<{ id: HomeKind; name: string; rentCentsPerWeek: number }>> {
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
    const r = await c.query<HomeDbRow>(`SELECT ${HOME_COLUMNS} ${HOME_FROM} WHERE h.home_id = $1`, [
      homeId,
    ]);
    const row = r.rows[0];
    return row ? toHomeRow(row) : null;
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
  await ensureUnitsSynced(ctx.db);
  let ok = false;
  try {
    await runInTransaction(async (client) => {
      // A free door of the home's tier; a tier with no doors leases without one.
      const unitId = await takeFreeUnit(client, TIER_BY_KIND[kind]);
      if (unitId === 'full') throw new NoFreeUnitError({ tier: TIER_BY_KIND[kind] });
      await client.query(
        `INSERT INTO homes (home_id, owner_user_id, kind, rent_cents_per_week, last_rent_paid_at, unit_id)
         VALUES ($1, $2, $3, $4, now(), $5)`,
        [homeId, ownerUserId, kind, rent, unitId],
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
    // existing home. Look it up and return it. Only a live home counts:
    // a moved-out or evicted one is history and the player leases anew.
    if ((e as { code?: string }).code === '23505' || !ok) {
      const existing = await ctx.db.withConnection(async (c) => {
        return c.query<{ home_id: string }>(
          `SELECT home_id FROM homes
            WHERE owner_user_id = $1 AND kind = $2 AND status IN ('active', 'overdue')
            ORDER BY created_at DESC LIMIT 1`,
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

/**
 * One home by instance id, as its owner sees it.
 * @param ctx - The app context.
 * @param homeId - The instance id (`home:<uuid>`).
 * @returns The home row.
 * @throws NotFoundError when there is no such home.
 */
export async function getHomeRow(ctx: AppContext, homeId: string): Promise<HomeRow> {
  return selectHomeRequired(ctx, homeId);
}

/** Owner pays rent manually (e.g. mid-week). */
export async function payRent(
  ctx: AppContext,
  homeId: string,
  callerUserId: string,
): Promise<HomeRow> {
  await ensureUnitsSynced(ctx.db);
  let result: HomeRow | null = null;
  await runInTransaction(async (client) => {
    // home_id is an instance id ('home:<uuid>'), but clients hold the home
    // *kind* ('studio'), which 404'd. Match the instance id first, then fall
    // back to the caller's own home of that kind (a live one before history).
    const r = await client.query<{
      home_id: string;
      owner_user_id: string;
      kind: HomeKind;
      status: HomeStatus;
      unit_id: string | null;
      rent_cents_per_week: string;
      last_rent_paid_at: Date | null;
    }>(
      `SELECT home_id, owner_user_id, kind, status, unit_id, rent_cents_per_week, last_rent_paid_at
         FROM homes
        WHERE home_id = $1
           OR (kind = $1 AND owner_user_id = $2)
        ORDER BY (home_id = $1) DESC, (status IN ('active', 'overdue')) DESC, created_at DESC
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
    if (!isLive(row.status)) {
      throw new ValidationFailedError({ reason: 'home is not active', status: row.status });
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
    // A paid week clears the overdue state. A lease from before doors
    // existed takes a free one now if there is one; if not it stays door-less.
    const unitId =
      row.unit_id ?? (await takeFreeUnit(client, TIER_BY_KIND[row.kind]).then(noneIfFull));
    await client.query(
      `UPDATE homes
          SET last_rent_paid_at = now(), status = 'active', missed_weeks = 0, unit_id = $2
        WHERE home_id = $1`,
      [resolvedHomeId, unitId],
    );
    const after = await client.query<HomeDbRow>(
      `SELECT ${HOME_COLUMNS} ${HOME_FROM} WHERE h.home_id = $1`,
      [resolvedHomeId],
    );
    const r2 = after.rows[0];
    if (!r2) throw new NotFoundError({ resource: 'home', id: resolvedHomeId });
    result = toHomeRow(r2);
  });
  if (!result) throw new NotFoundError({ resource: 'home', id: homeId });
  return result;
}

/** A full tier is not an error when paying rent on an existing lease. */
function noneIfFull(unitId: string | null | 'full'): string | null {
  return unitId === 'full' ? null : unitId;
}

/**
 * Load a home for an owner-only action and lock it.
 * @throws NotFoundError for no such home, NotHomeOwnerError for someone else's.
 */
async function lockOwnedHome(
  client: PoolClient,
  homeId: string,
  callerUserId: string,
): Promise<{ homeId: string; unitId: string | null; status: HomeStatus }> {
  const r = await client.query<{
    home_id: string;
    owner_user_id: string;
    unit_id: string | null;
    status: HomeStatus;
  }>(`SELECT home_id, owner_user_id, unit_id, status FROM homes WHERE home_id = $1 FOR UPDATE`, [
    homeId,
  ]);
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'home', id: homeId });
  if (row.owner_user_id !== callerUserId) throw new NotHomeOwnerError({ homeId });
  return { homeId: row.home_id, unitId: row.unit_id, status: row.status };
}

/**
 * Give a home up. The unit is free for the next lease and the guests are
 * sent away. Moving out of a home that is already over is a no-op.
 */
export async function moveOut(
  ctx: AppContext,
  homeId: string,
  callerUserId: string,
): Promise<HomeRow> {
  await runInTransaction(async (client) => {
    const home = await lockOwnedHome(client, homeId, callerUserId);
    if (!isLive(home.status)) return;
    await client.query(
      `UPDATE homes SET status = 'moved_out', ended_at = now() WHERE home_id = $1`,
      [home.homeId],
    );
    await client.query(`DELETE FROM home_guests WHERE home_id = $1`, [home.homeId]);
  });
  await publishHomeAccess(ctx.redis.main, homeId);
  return selectHomeRequired(ctx, homeId);
}

/** Owner lets a user through the door. Idempotent. Returns the guest list. */
export async function addGuest(
  ctx: AppContext,
  homeId: string,
  callerUserId: string,
  guestUserId: string,
): Promise<{ homeId: string; guests: string[] }> {
  await runInTransaction(async (client) => {
    const home = await lockOwnedHome(client, homeId, callerUserId);
    if (guestUserId === callerUserId) {
      throw new ValidationFailedError({ reason: 'owner is already allowed in' });
    }
    if (!isLive(home.status)) {
      throw new ValidationFailedError({ reason: 'home is not active', status: home.status });
    }
    const user = await client.query(`SELECT 1 FROM users WHERE id = $1`, [guestUserId]);
    if (user.rowCount === 0) throw new NotFoundError({ resource: 'user', id: guestUserId });
    if (home.unitId !== null) {
      const cap = await client.query<{ capacity: number; used: string; already: boolean }>(
        `SELECT u.capacity,
                (SELECT count(*) FROM home_guests WHERE home_id = $1) AS used,
                EXISTS (SELECT 1 FROM home_guests WHERE home_id = $1 AND user_id = $3) AS already
           FROM home_units u WHERE u.unit_id = $2`,
        [home.homeId, home.unitId, guestUserId],
      );
      const c = cap.rows[0];
      // The owner takes one place; the rest are guests.
      if (c && !c.already && Number(c.used) + 1 >= c.capacity) {
        throw new UnitFullError({ unitId: home.unitId, capacity: c.capacity });
      }
    }
    await client.query(
      `INSERT INTO home_guests (home_id, user_id) VALUES ($1, $2)
       ON CONFLICT (home_id, user_id) DO NOTHING`,
      [home.homeId, guestUserId],
    );
  });
  return listGuests(ctx, homeId);
}

/** Owner takes a user off the guest list. Idempotent. Returns the guest list. */
export async function removeGuest(
  ctx: AppContext,
  homeId: string,
  callerUserId: string,
  guestUserId: string,
): Promise<{ homeId: string; guests: string[] }> {
  await runInTransaction(async (client) => {
    const home = await lockOwnedHome(client, homeId, callerUserId);
    await client.query(`DELETE FROM home_guests WHERE home_id = $1 AND user_id = $2`, [
      home.homeId,
      guestUserId,
    ]);
  });
  // The removed guest may be standing in the room right now.
  await publishHomeAccess(ctx.redis.main, homeId);
  return listGuests(ctx, homeId);
}

async function listGuests(
  ctx: AppContext,
  homeId: string,
): Promise<{ homeId: string; guests: string[] }> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ user_id: string }>(
      `SELECT user_id FROM home_guests WHERE home_id = $1 ORDER BY added_at, user_id`,
      [homeId],
    );
  });
  return { homeId, guests: r.rows.map((row) => row.user_id) };
}

/**
 * The player's current home for `GET /me`: the newest active or overdue
 * lease; failing that the newest evicted one, so the client can say why
 * the door is shut. Null for a player with no home (street).
 */
export async function loadMeHome(
  c: Pick<PoolClient, 'query'>,
  userId: string,
): Promise<MeHome | null> {
  const r = await c.query<HomeDbRow>(
    `SELECT ${HOME_COLUMNS} ${HOME_FROM}
      WHERE h.owner_user_id = $1 AND h.status IN ('active', 'overdue', 'evicted')
      ORDER BY (h.status IN ('active', 'overdue')) DESC, h.created_at DESC
      LIMIT 1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const h = toHomeRow(row);
  return {
    homeId: h.homeId,
    kind: h.kind,
    unitId: h.unitId,
    tier: h.tier,
    roomType: h.roomType,
    status: h.status,
    missedWeeks: h.missedWeeks,
  };
}

/**
 * Whether a user may enter a home (by instance id). A home without a door
 * is open, as it always was. Used by the home room on join.
 */
export async function canEnterHome(
  ctx: AppContext,
  homeId: string,
  userId: string,
): Promise<boolean> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{ owner_user_id: string; status: HomeStatus; unit_id: string | null }>(
      `SELECT owner_user_id, status, unit_id FROM homes WHERE home_id = $1`,
      [homeId],
    );
    const h = r.rows[0];
    if (!h) return false;
    if (h.unit_id === null) return isLive(h.status);
    const a = await accessToHome(
      c,
      { homeId, ownerUserId: h.owner_user_id, status: h.status },
      userId,
    );
    return a.canEnter;
  });
}

/** Record a visit. */
export async function recordVisit(
  ctx: AppContext,
  homeId: string,
  visitorUserId: string,
): Promise<VisitResult> {
  // The route passes the path param of POST /v1/homes/{ownerId}/visit, so
  // this is an owner's user id, not a home id. Resolving it as home_id
  // meant every visit 404'd. Owner first, then an instance id or kind so a
  // caller holding either still works. Only a live home can be visited.
  const found = await ctx.db.withConnection(async (c) => {
    return c.query<{
      home_id: string;
      owner_user_id: string;
      status: HomeStatus;
      unit_id: string | null;
      room_type: string | null;
    }>(
      `SELECT h.home_id, h.owner_user_id, h.status, h.unit_id, u.room_type
         FROM homes h LEFT JOIN home_units u ON u.unit_id = h.unit_id
        WHERE (h.owner_user_id::text = $1 OR h.home_id = $1 OR h.kind = $1)
          AND h.status IN ('active', 'overdue')
        ORDER BY (h.owner_user_id::text = $1) DESC, h.created_at ASC
        LIMIT 1`,
      [homeId],
    );
  });
  const home = found.rows[0];
  if (home === undefined) throw new NotFoundError({ resource: 'home', id: homeId });
  const resolvedHomeId = home.home_id;
  // A home with a door is only open to its owner and guests. Checked before
  // anything is logged, so a refused visit leaves no row.
  if (home.unit_id !== null) {
    const access = await ctx.db.withConnection((c) =>
      accessToHome(
        c,
        { homeId: resolvedHomeId, ownerUserId: home.owner_user_id, status: home.status },
        visitorUserId,
      ),
    );
    if (!access.canEnter) throw new ForbiddenError({ reason: access.reason });
  }
  const visitId = uuidv7();
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO home_visits (visit_id, home_id, visitor_user_id) VALUES ($1, $2, $3)`,
      [visitId, resolvedHomeId, visitorUserId],
    );
  });
  // After the commit, and only for someone else's home: visiting your own earns nothing.
  if (home.owner_user_id !== visitorUserId) {
    const day = new Date().toISOString().slice(0, 10);
    // Two accounts visiting each other do not both earn: no credit when the owner visited
    // one of the visitor's homes within the window, and a home counts once per window.
    const reciprocal = await ctx.db.withConnection((c) =>
      c.query(
        `SELECT 1 FROM home_visits v JOIN homes h ON h.home_id = v.home_id
          WHERE v.visitor_user_id = $1 AND h.owner_user_id = $2
            AND v.visited_at > now() - make_interval(days => $3::int) LIMIT 1`,
        [home.owner_user_id, visitorUserId, HOME_VISIT_COOLDOWN_DAYS],
      ),
    );
    if (reciprocal.rows.length === 0) {
      await recordQuestEvent(
        ctx,
        visitorUserId,
        'home_visit',
        `${resolvedHomeId}:${day}`,
        new Date(),
        { key: `home:${resolvedHomeId}`, cooldownDays: HOME_VISIT_COOLDOWN_DAYS },
      );
    }
    await notifyHomeVisit(ctx, home.owner_user_id, resolvedHomeId);
  }
  return {
    visitId,
    homeId: resolvedHomeId,
    visitorUserId,
    visitedAt: new Date().toISOString(),
    unitId: home.unit_id,
    roomType: home.room_type,
  };
}

/** What a non-owner may see of a home. */
export interface PublicHomeView {
  readonly homeId: string;
  readonly kind: HomeKind;
  readonly tier: HomeTier;
  readonly decoratedAt: string | null;
  /** Only set for a guest, who can open the door. */
  readonly unitId?: string | null;
  readonly roomType?: string | null;
}

/**
 * Get a home. The owner sees everything and the recent visits. A guest
 * sees the public fields plus the door; anyone else sees the public
 * fields only, with no owner, status, rent, unit or visit list.
 */
export async function getHome(
  ctx: AppContext,
  homeId: string,
  callerUserId: string,
): Promise<{
  view: 'owner' | 'guest' | 'public';
  home: HomeRow | PublicHomeView;
  visits: VisitRow[];
}> {
  const home = await selectHomeRequired(ctx, homeId);
  const pub: PublicHomeView = {
    homeId: home.homeId,
    kind: home.kind,
    tier: home.tier,
    decoratedAt: home.decoratedAt,
  };
  if (home.ownerUserId !== callerUserId) {
    const guest = await ctx.db.withConnection((c) =>
      c.query(`SELECT 1 FROM home_guests WHERE home_id = $1 AND user_id = $2`, [
        homeId,
        callerUserId,
      ]),
    );
    if (guest.rowCount && isLive(home.status)) {
      return {
        view: 'guest',
        home: { ...pub, unitId: home.unitId, roomType: home.roomType },
        visits: [],
      };
    }
    return { view: 'public', home: pub, visits: [] };
  }
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
    view: 'owner',
    home,
    visits: visits.rows.map((row) => ({
      visitId: row.visit_id,
      homeId: row.home_id,
      visitorUserId: row.visitor_user_id,
      visitedAt: row.visited_at.toISOString(),
    })),
  };
}
