/**
 * Venue voice access.
 *
 * A venue's LiveKit room is `venue:<instanceId>`, where instanceId is the
 * Colyseus room id of that venue instance. Only a user who is in that
 * instance right now may get a token for it: the venue room counts every
 * joined session in `ctl:venue:members:<instanceId>` (server/realtime/
 * venue-presence.ts) and this check reads that count. Without it any
 * signed-in user could mint a token for any venue and listen in.
 *
 * Fails closed: a missing hash, a missing field or a count of zero is
 * "not present". A Redis error propagates (no token).
 */
import { NotInVenueError } from '../shared/domain/errors.js';
import { venueMembersKey } from '../realtime/venue-presence.js';
import type { AppContext } from './context.js';

/**
 * Throw unless `userId` has a session in the venue instance.
 * @param ctx - The application context.
 * @param instanceId - The bare venue instance id (no `venue:` prefix).
 * @param userId - The caller.
 * @throws NotInVenueError when the caller is not in that instance.
 */
export async function assertInVenueInstance(
  ctx: AppContext,
  instanceId: string,
  userId: string,
): Promise<void> {
  const count = Number(await ctx.redis.main.hget(venueMembersKey(instanceId), userId));
  if (!(count > 0)) throw new NotInVenueError({ instanceId });
}
