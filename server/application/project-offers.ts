/**
 * Role offers (Builder). Replaces direct hiring, which added a player and
 * paid them from the founder without their consent.
 *
 *   POST /v1/projects/{id}/offers              founder offers a role (wage in band)
 *   POST /v1/project-offers/{offerId}/accept   invitee joins the project
 *   POST /v1/project-offers/{offerId}/decline  invitee says no
 *
 * No Cash moves on any of these. The wage is a fixed band from
 * contract/config/projects.json and is paid weekly by the game
 * (project-payroll.ts), so a founder cannot push arbitrary Cash to a friend.
 * A player holds at most `membership.maxRolesPerPlayer` roles across
 * projects, which caps what one account can earn.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  BlockedError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { salaryOutOfBand, type HireRole } from '../shared/domain/projects.js';
import { publishToUser } from './realtime-bus.js';
import { assertOwner, lockProject } from './projects.js';
import { projectsConfig, publishProjectEvent, recordProjectEvent } from './project-events.js';
import type { AppContext } from './context.js';

export interface HireOfferRow {
  readonly offerId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly role: HireRole;
  readonly salaryCentsPerWeek: number;
  readonly status: 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface OfferDbRow {
  offer_id: string;
  project_id: string;
  project_name: string | null;
  from_user_id: string;
  to_user_id: string;
  role: HireRole;
  salary_cents_per_week: string;
  status: HireOfferRow['status'];
  expires_at: Date;
  created_at: Date;
}

/**
 * Shape an offer row. A pending offer past its expiry reads as `expired`
 * (the worker also flips it; this keeps reads right between sweeps).
 * @param r - The joined row.
 * @param nowMs - The current time.
 * @returns The contract `HireOffer`.
 */
export function toOffer(r: OfferDbRow, nowMs: number): HireOfferRow {
  const expired = r.status === 'pending' && r.expires_at.getTime() <= nowMs;
  return {
    offerId: r.offer_id,
    projectId: r.project_id,
    projectName: r.project_name ?? 'Project',
    fromUserId: r.from_user_id,
    toUserId: r.to_user_id,
    role: r.role,
    salaryCentsPerWeek: Number(r.salary_cents_per_week),
    status: expired ? 'expired' : r.status,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
  };
}

export const OFFER_SELECT = `
  SELECT o.offer_id, o.project_id, p.name AS project_name, o.from_user_id, o.to_user_id,
         o.role, o.salary_cents_per_week, o.status, o.expires_at, o.created_at
    FROM project_offers o
    JOIN projects p ON p.project_id = o.project_id`;

/**
 * Role offers sent to me, newest first.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @param status - Optional status filter (applied after lazy expiry).
 * @param limit - Page size.
 * @returns Offers.
 */
export async function listMyProjectOffers(
  ctx: AppContext,
  userId: string,
  status: string | null,
  limit: number,
): Promise<HireOfferRow[]> {
  const now = new Date();
  const r = await ctx.db.withConnection((c) =>
    c.query<OfferDbRow>(
      `${OFFER_SELECT}
        WHERE o.to_user_id = $1
          AND ($2::text IS NULL
               OR (CASE WHEN o.status = 'pending' AND o.expires_at <= $3 THEN 'expired'
                        ELSE o.status END) = $2)
        ORDER BY o.created_at DESC
        LIMIT $4`,
      [userId, status, now, limit],
    ),
  );
  return r.rows.map((row) => toOffer(row, now.getTime()));
}

const RC = { isolation: 'read committed' } as const;
const UUID = /^[0-9a-f-]{36}$/i;

async function blockedBetween(c: PoolClient, a: string, b: string): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM blocks
      WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
         OR (blocker_user_id = $2 AND blocked_user_id = $1)
      LIMIT 1`,
    [a, b],
  );
  return (r.rowCount ?? 0) > 0;
}

async function readOffer(c: PoolClient, offerId: string, lock: boolean): Promise<OfferDbRow> {
  if (!UUID.test(offerId)) throw new NotFoundError({ kind: 'offer' });
  const r = await c.query<OfferDbRow>(
    `${OFFER_SELECT} WHERE o.offer_id = $1${lock ? ' FOR UPDATE OF o' : ''}`,
    [offerId],
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ kind: 'offer' });
  return row;
}

/**
 * Offer a role. Founder only.
 * @param ctx - The application context.
 * @param founderId - The caller.
 * @param projectId - The project.
 * @param args - Invitee, role and weekly wage (must be inside the role's band).
 * @returns The pending offer; the invitee gets `hire_offer`.
 */
export async function createOffer(
  ctx: AppContext,
  founderId: string,
  projectId: string,
  args: { userId: string; role: HireRole; salaryCentsPerWeek: number },
): Promise<HireOfferRow> {
  const cfg = projectsConfig(ctx);
  const band = salaryOutOfBand(cfg, args.role, args.salaryCentsPerWeek);
  if (band) {
    throw new ValidationFailedError({
      reason: 'salary_out_of_band',
      min: band.minCentsPerWeek,
      max: band.maxCentsPerWeek,
    });
  }
  if (args.userId === founderId) throw new ValidationFailedError({ reason: 'self' });
  const now = new Date();
  const offer = await runInTransaction(async (client) => {
    const p = await lockProject(client, projectId);
    assertOwner(p, founderId);
    if (p.status === 'rugged')
      throw new ConflictError({ reason: 'wrong_status', status: p.status });
    const u = await client.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [
      args.userId,
    ]);
    if ((u.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'user' });
    if (await blockedBetween(client, founderId, args.userId)) throw new BlockedError();
    const members = await client.query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM project_members WHERE project_id = $1`,
      [projectId],
    );
    if (members.rows.some((m) => m.user_id === args.userId))
      throw new ConflictError({ reason: 'already_member' });
    if (members.rows.some((m) => m.role === args.role))
      throw new ConflictError({ reason: 'role_filled', role: args.role });
    const pending = await client.query<{ to_user_id: string }>(
      `SELECT to_user_id FROM project_offers
        WHERE project_id = $1 AND status = 'pending' AND expires_at > $2`,
      [projectId, now],
    );
    if (pending.rows.some((o) => o.to_user_id === args.userId))
      throw new ConflictError({ reason: 'offer_pending' });
    if (pending.rows.length >= cfg.offers.maxPendingPerProject)
      throw new ConflictError({ reason: 'too_many_offers', max: cfg.offers.maxPendingPerProject });
    // A stale pending row (past expiry, not swept yet) would trip the
    // one-pending index; retire it first.
    await client.query(
      `UPDATE project_offers SET status = 'expired'
        WHERE project_id = $1 AND to_user_id = $2 AND status = 'pending' AND expires_at <= $3`,
      [projectId, args.userId, now],
    );
    const offerId = uuidv7();
    await client.query(
      `INSERT INTO project_offers
         (offer_id, project_id, from_user_id, to_user_id, role, salary_cents_per_week, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [
        offerId,
        projectId,
        founderId,
        args.userId,
        args.role,
        args.salaryCentsPerWeek,
        new Date(now.getTime() + cfg.offers.ttlHours * 3_600_000),
        now,
      ],
    );
    return toOffer(await readOffer(client, offerId, false), now.getTime());
  }, RC);
  await publishToUser(ctx, offer.toUserId, 'hire_offer', { ...offer });
  return offer;
}

function assertInvitee(o: OfferDbRow, userId: string, nowMs: number): void {
  if (o.to_user_id !== userId) throw new ForbiddenError({ reason: 'not_invitee' });
  if (o.status !== 'pending') throw new ConflictError({ reason: 'not_pending', status: o.status });
  if (o.expires_at.getTime() <= nowMs) throw new ConflictError({ reason: 'expired' });
}

/**
 * Accept a role offer: join the project. No Cash moves.
 * @param ctx - The application context.
 * @param userId - The caller (must be the invitee).
 * @param offerId - The offer.
 * @returns The offer, now `accepted`.
 */
export async function acceptOffer(
  ctx: AppContext,
  userId: string,
  offerId: string,
): Promise<HireOfferRow> {
  const cfg = projectsConfig(ctx);
  const now = new Date();
  const { offer, event } = await runInTransaction(async (client) => {
    const o0 = await readOffer(client, offerId, false);
    // Lock order everywhere: project, then offer.
    const p = await lockProject(client, o0.project_id);
    const o = await readOffer(client, offerId, true);
    assertInvitee(o, userId, now.getTime());
    if (p.status === 'rugged')
      throw new ConflictError({ reason: 'wrong_status', status: p.status });
    // Two accepts by one player on two projects must not both pass the
    // role cap: serialize per player.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`proj-member:${userId}`]);
    const mine = await client.query<{ project_id: string; role: string }>(
      `SELECT project_id, role FROM project_members WHERE user_id = $1`,
      [userId],
    );
    if (mine.rows.some((m) => m.project_id === o.project_id))
      throw new ConflictError({ reason: 'already_member' });
    const roles = mine.rows.filter((m) => m.role !== 'founder').length;
    if (roles >= cfg.membership.maxRolesPerPlayer)
      throw new ConflictError({
        reason: 'membership_limit',
        max: cfg.membership.maxRolesPerPlayer,
      });
    const taken = await client.query(
      `SELECT 1 FROM project_members WHERE project_id = $1 AND role = $2`,
      [o.project_id, o.role],
    );
    if ((taken.rowCount ?? 0) > 0) throw new ConflictError({ reason: 'role_filled', role: o.role });
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role, salary_cents_per_week, offer_id, joined_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [o.project_id, userId, o.role, o.salary_cents_per_week, o.offer_id, now],
    );
    await client.query(`UPDATE project_offers SET status = 'accepted' WHERE offer_id = $1`, [
      offerId,
    ]);
    const ev = await recordProjectEvent(client, {
      projectId: o.project_id,
      eventId: 'proj_member_joined',
      params: { userId, role: o.role },
      at: now,
    });
    return {
      offer: toOffer({ ...o, status: 'accepted' }, now.getTime()),
      event: ev,
    };
  }, RC);
  if (event) await publishProjectEvent(ctx, event);
  return offer;
}

/**
 * Decline a role offer.
 * @param ctx - The application context.
 * @param userId - The caller (must be the invitee).
 * @param offerId - The offer.
 * @returns The offer, now `declined`.
 */
export async function declineOffer(
  _ctx: AppContext,
  userId: string,
  offerId: string,
): Promise<HireOfferRow> {
  const now = new Date();
  return runInTransaction(async (client) => {
    const o = await readOffer(client, offerId, true);
    assertInvitee(o, userId, now.getTime());
    await client.query(`UPDATE project_offers SET status = 'declined' WHERE offer_id = $1`, [
      offerId,
    ]);
    return toOffer({ ...o, status: 'declined' }, now.getTime());
  }, RC);
}

/**
 * Worker sweep: flip pending offers past their expiry to `expired`.
 * @param ctx - The application context.
 * @param now - The current time.
 * @returns How many offers expired.
 */
export async function expireOffers(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE project_offers SET status = 'expired' WHERE status = 'pending' AND expires_at <= $1`,
      [now],
    ),
  );
  return r.rowCount ?? 0;
}
