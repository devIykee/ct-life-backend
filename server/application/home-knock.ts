/**
 * Knock on a home's door (unlock D5). Gated with the visitor features
 * (capability `visitorPolicy`): knocking is how a player asks to be let in
 * past a locked door or a followers-only policy.
 *
 *   POST /v1/homes/{ownerId}/knock -> 204, and the owner gets
 *   `home_knock {fromUserId, alias, homeId, at}` (city room, if online).
 *
 * Refused: your own home (400 self_knock), no live home (404), a block in
 * either direction (403 BLOCKED, and the owner is not told), a `closed` home
 * (403 HOME_CLOSED: the owner asked for no visitors). Rate limits: one knock
 * per door per minute, 10 knocks an hour per player (429 RATE_LIMITED
 * {reason: knock_cooldown | knock_limit}).
 */
import {
  BlockedError,
  HomeClosedError,
  NotFoundError,
  RateLimitedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { loadVisitorPolicy } from './home-settings.js';
import { publishToUser } from './realtime-bus.js';

const DOOR_COOLDOWN_SEC = 60;
const HOURLY_LIMIT = 10;

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
    const policy = home.rows[0] ? await loadVisitorPolicy(c, ownerId) : 'open';
    return {
      homeId: home.rows[0]?.home_id,
      blocked: (blocked.rowCount ?? 0) > 0,
      alias: alias.rows[0]?.alias || 'Anon',
      policy,
    };
  });
  if (!facts.homeId) throw new NotFoundError({ resource: 'home', id: ownerId });
  if (facts.blocked) throw new BlockedError();
  if (facts.policy === 'closed') throw new HomeClosedError();

  const door = await ctx.redis.main.set(
    `knock:door:${fromUserId}:${ownerId}`,
    '1',
    'EX',
    DOOR_COOLDOWN_SEC,
    'NX',
  );
  if (door !== 'OK') {
    const ttl = await ctx.redis.main.pttl(`knock:door:${fromUserId}:${ownerId}`);
    throw new RateLimitedError(Math.max(ttl, 1000), { reason: 'knock_cooldown' });
  }
  const hourKey = `knock:hour:${fromUserId}:${Math.floor(Date.now() / 3_600_000)}`;
  const n = await ctx.redis.main.incr(hourKey);
  if (n === 1) await ctx.redis.main.expire(hourKey, 3600);
  if (n > HOURLY_LIMIT) {
    throw new RateLimitedError(3_600_000 - (Date.now() % 3_600_000), { reason: 'knock_limit' });
  }
  await publishToUser(ctx, ownerId, 'home_knock', {
    fromUserId,
    alias: facts.alias,
    homeId: facts.homeId,
    at: Date.now(),
  });
}
