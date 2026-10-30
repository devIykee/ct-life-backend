/**
 * Knock on a home's door (unlock D5). Gated with the visitor features
 * (capability `visitorPolicy`): knocking is how a player asks to be let in
 * past a locked door or a followers-only policy.
 *
 *   POST /v1/homes/{ownerId}/knock -> 204, and the owner gets
 *   `home_knock {fromUserId, alias, homeId, at}` (city room, if online).
 *
 *   POST /v1/units/{unitId}/knock  -> 204, the same `home_knock` to whoever
 *   holds the flat behind that door. The owner is resolved server-side and is
 *   never shown to the knocker (GET /units/{unitId}/access never names them).
 *
 * Refused: your own home (400 self_knock), no live home (404), a block in
 * either direction (403 BLOCKED, and the owner is not told), a `closed` home
 * (403 HOME_CLOSED: the owner asked for no visitors). Rate limits: one knock
 * per door per minute, 10 knocks an hour per player (429 RATE_LIMITED
 * {reason: knock_cooldown | knock_limit}); the hourly budget is shared by
 * both routes.
 *
 * A flat door differs in two places, both so the door never reveals who
 * lives there:
 *   - a block is silent: the knocker gets the same 204 (and spends the same
 *     rate limit) as anyone else, and the owner is not told. A 403 BLOCKED
 *     would tell the knocker the occupant is someone they blocked or who
 *     blocked them.
 *   - the per-door cooldown is keyed by the unit, not the owner, so a
 *     cooldown left over from a profile knock cannot link a door to a name.
 */
import type { PoolClient } from 'pg';
import {
  BlockedError,
  HomeClosedError,
  NotFoundError,
  RateLimitedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { loadVisitorPolicy, type VisitorPolicy } from './home-settings.js';
import { publishToUser } from './realtime-bus.js';

const DOOR_COOLDOWN_SEC = 60;
const HOURLY_LIMIT = 10;

/** What a knock needs to know about the knocker and the owner. */
interface KnockFacts {
  readonly blocked: boolean;
  readonly alias: string;
  readonly policy: VisitorPolicy;
}

async function knockFacts(
  c: Pick<PoolClient, 'query'>,
  fromUserId: string,
  ownerId: string,
): Promise<KnockFacts> {
  const blocked = await c.query(
    `SELECT 1 FROM blocks
      WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
         OR (blocker_user_id = $2 AND blocked_user_id = $1) LIMIT 1`,
    [ownerId, fromUserId],
  );
  const alias = await c.query<{ alias: string }>(
    `SELECT alias FROM characters WHERE user_id = $1`,
    [fromUserId],
  );
  return {
    blocked: (blocked.rowCount ?? 0) > 0,
    alias: alias.rows[0]?.alias || 'Anon',
    policy: await loadVisitorPolicy(c, ownerId),
  };
}

/**
 * Spend the knocker's per-door cooldown and hourly budget.
 * @param ctx - The app context.
 * @param fromUserId - The player knocking.
 * @param doorKey - The cooldown key for this door.
 */
async function spendKnock(ctx: AppContext, fromUserId: string, doorKey: string): Promise<void> {
  const door = await ctx.redis.main.set(doorKey, '1', 'EX', DOOR_COOLDOWN_SEC, 'NX');
  if (door !== 'OK') {
    const ttl = await ctx.redis.main.pttl(doorKey);
    throw new RateLimitedError(Math.max(ttl, 1000), { reason: 'knock_cooldown' });
  }
  const hourKey = `knock:hour:${fromUserId}:${Math.floor(Date.now() / 3_600_000)}`;
  const n = await ctx.redis.main.incr(hourKey);
  if (n === 1) await ctx.redis.main.expire(hourKey, 3600);
  if (n > HOURLY_LIMIT) {
    throw new RateLimitedError(3_600_000 - (Date.now() % 3_600_000), { reason: 'knock_limit' });
  }
}

async function ring(
  ctx: AppContext,
  fromUserId: string,
  ownerId: string,
  homeId: string,
  alias: string,
): Promise<void> {
  await publishToUser(ctx, ownerId, 'home_knock', { fromUserId, alias, homeId, at: Date.now() });
}

/**
 * Knock on `ownerId`'s home.
 * @param ctx - The app context.
 * @param fromUserId - The player knocking.
 * @param ownerId - The home owner.
 */
export async function knock(ctx: AppContext, fromUserId: string, ownerId: string): Promise<void> {
  if (ownerId === fromUserId) throw new ValidationFailedError({ reason: 'self_knock' });
  const facts = await ctx.db.withConnection(async (c) => {
    const home = await c.query<{ home_id: string }>(
      `SELECT home_id FROM homes WHERE owner_user_id = $1 AND status IN ('active', 'overdue')
        ORDER BY created_at DESC LIMIT 1`,
      [ownerId],
    );
    const homeId = home.rows[0]?.home_id;
    return homeId ? { homeId, ...(await knockFacts(c, fromUserId, ownerId)) } : null;
  });
  if (!facts) throw new NotFoundError({ resource: 'home', id: ownerId });
  if (facts.blocked) throw new BlockedError();
  if (facts.policy === 'closed') throw new HomeClosedError();
  await spendKnock(ctx, fromUserId, `knock:door:${fromUserId}:${ownerId}`);
  await ring(ctx, fromUserId, ownerId, facts.homeId, facts.alias);
}

/**
 * Knock on a flat door (`unitId`) without knowing who lives there.
 * @param ctx - The app context.
 * @param fromUserId - The player knocking.
 * @param unitId - The door id (`contract/ids/home_units.json`).
 */
export async function knockUnit(
  ctx: AppContext,
  fromUserId: string,
  unitId: string,
): Promise<void> {
  const found = await ctx.db.withConnection(async (c) => {
    const u = await c.query(`SELECT 1 FROM home_units WHERE unit_id = $1`, [unitId]);
    if (u.rowCount === 0) return { unit: false as const };
    const live = await c.query<{ home_id: string; owner_user_id: string }>(
      `SELECT home_id, owner_user_id FROM homes
        WHERE unit_id = $1 AND status IN ('active', 'overdue')`,
      [unitId],
    );
    const h = live.rows[0];
    if (!h) return { unit: true as const, home: null };
    const facts =
      h.owner_user_id === fromUserId ? null : await knockFacts(c, fromUserId, h.owner_user_id);
    return { unit: true as const, home: { homeId: h.home_id, ownerId: h.owner_user_id, facts } };
  });
  if (!found.unit) throw new NotFoundError({ resource: 'unit', id: unitId });
  // Vacant: GET /units/{unitId}/access already says `vacant`.
  if (!found.home) throw new NotFoundError({ resource: 'home', id: unitId });
  const { homeId, ownerId, facts } = found.home;
  // The owner's own door: /access already tells them `owner`.
  if (!facts) throw new ValidationFailedError({ reason: 'self_knock' });
  // The owner's choice, not who they are; checked before the block so a blocked
  // knocker sees exactly what any stranger sees.
  if (facts.policy === 'closed') throw new HomeClosedError();
  await spendKnock(ctx, fromUserId, `knock:unit:${fromUserId}:${unitId}`);
  if (facts.blocked) return; // silent: the same 204, and the owner is not told
  await ring(ctx, fromUserId, ownerId, homeId, facts.alias);
}
