/**
 * Home visitor policy (unlock D2, capability `visitorPolicy`).
 *
 *   GET /v1/homes/me/settings          -> {visitors}
 *   PUT /v1/homes/me/settings {visitors} -> {visitors}
 *
 * `visitors` is one of:
 *   - `open` (default): the door rules alone decide (home-units.ts).
 *   - `followers`: only players who follow the owner, and the owner's guests.
 *     A refused visitor gets `403 FORBIDDEN {reason:'followers_only'}`.
 *   - `closed`: nobody but the owner. A refused visitor gets `403 HOME_CLOSED`.
 *
 * The policy narrows access; it never widens it. A home with a door still
 * needs the owner or a guest to open it, whatever the policy says.
 *
 * Enforced in `POST /homes/{ownerId}/visit` and when joining the `home`
 * room (homes.ts `homeEntryRefusal`). Changing the policy publishes on the
 * home-access channel so visitors who no longer qualify are shown out.
 *
 * The policy is enforced whether or not the capability is on: only the two
 * settings routes are gated. With the capability off nobody can store a
 * policy, so every home stays `open`, exactly as before.
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ForbiddenError, HomeClosedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { publishHomeAccess } from './home-units.js';

export const VisitorPolicySchema = z.enum(['open', 'followers', 'closed']);
export type VisitorPolicy = z.infer<typeof VisitorPolicySchema>;

export interface HomeSettings {
  readonly visitors: VisitorPolicy;
}

/** Why the policy refuses a visitor; the contract error each maps to. */
export type PolicyRefusal = 'HOME_CLOSED' | 'followers_only';

type Querier = Pick<PoolClient, 'query'>;

/**
 * The owner's policy (`open` when never set).
 * @param c - A client.
 * @param ownerUserId - The home's owner.
 * @returns The policy.
 */
export async function loadVisitorPolicy(c: Querier, ownerUserId: string): Promise<VisitorPolicy> {
  const r = await c.query<{ visitors: VisitorPolicy }>(
    `SELECT visitors FROM home_settings WHERE user_id = $1`,
    [ownerUserId],
  );
  return r.rows[0]?.visitors ?? 'open';
}

/**
 * Whether the owner's policy refuses this visitor.
 * @param c - A client.
 * @param home - The home's id and owner.
 * @param home.homeId - The home's instance id (for the guest list).
 * @param home.ownerUserId - The home's owner.
 * @param visitorUserId - The player trying to come in.
 * @returns The refusal, or null when the policy lets them in.
 */
export async function visitorPolicyRefusal(
  c: Querier,
  home: { homeId: string; ownerUserId: string },
  visitorUserId: string,
): Promise<PolicyRefusal | null> {
  if (visitorUserId === home.ownerUserId) return null;
  const policy = await loadVisitorPolicy(c, home.ownerUserId);
  if (policy === 'open') return null;
  if (policy === 'closed') return 'HOME_CLOSED';
  const ok = await c.query(
    `SELECT 1 FROM follows WHERE follower_user_id = $1 AND followee_user_id = $2
     UNION ALL
     SELECT 1 FROM home_guests WHERE home_id = $3 AND user_id = $1
     LIMIT 1`,
    [visitorUserId, home.ownerUserId, home.homeId],
  );
  return ok.rowCount ? null : 'followers_only';
}

/**
 * The domain error for a refusal.
 * @param refusal - What the policy said.
 * @returns `HOME_CLOSED` (403) or `FORBIDDEN {reason:'followers_only'}` (403).
 */
export function policyRefusalError(refusal: PolicyRefusal): HomeClosedError | ForbiddenError {
  return refusal === 'HOME_CLOSED'
    ? new HomeClosedError()
    : new ForbiddenError({ reason: 'followers_only' });
}

/**
 * GET /homes/me/settings.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @returns The caller's settings.
 */
export async function getHomeSettings(ctx: AppContext, userId: string): Promise<HomeSettings> {
  const visitors = await ctx.db.withConnection((c) => loadVisitorPolicy(c, userId));
  return { visitors };
}

/**
 * PUT /homes/me/settings: store the policy, then have every live home of the
 * caller re-check who is inside.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param visitors - The new policy.
 * @returns The stored settings.
 */
export async function putHomeSettings(
  ctx: AppContext,
  userId: string,
  visitors: VisitorPolicy,
): Promise<HomeSettings> {
  const homes = await ctx.db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO home_settings (user_id, visitors) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET visitors = EXCLUDED.visitors, updated_at = now()`,
      [userId, visitors],
    );
    return c.query<{ home_id: string }>(
      `SELECT home_id FROM homes WHERE owner_user_id = $1 AND status IN ('active', 'overdue')`,
      [userId],
    );
  });
  for (const h of homes.rows) await publishHomeAccess(ctx.redis.main, h.home_id);
  return { visitors };
}
