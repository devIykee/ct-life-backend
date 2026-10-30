/**
 * Project HQ (Builder, unlock WP-B B3).
 *
 *   POST /v1/projects/{id}/hq/visit  -> a ticket for the project's `project_hq` room
 *
 * One `project_hq` Colyseus room per project (server/realtime/rooms/project-hq.ts,
 * a VenueRoom with the `hackathon_house` layout, roomId `hq_<projectId>`).
 * Members may always enter. Anyone else may enter only while a member is
 * inside (P46 B7 default); the room keeps the members present in Redis so
 * this API can answer `403 FORBIDDEN {reason:'members_only'}` up front, and it
 * shows visitors out when the last member leaves.
 *
 * The HQ shift: a non-founder member who stays `hq.shiftMinutes` in one visit
 * logs the week as worked for this project (`project_work_log`, source
 * `hq_shift`), the same as a finished project task (project-tasks.ts).
 */
import { ConflictError, ForbiddenError, NotFoundError } from '../shared/domain/errors.js';
import { isoDate, weekStartUtc, type MemberRole } from '../shared/domain/projects.js';
import { projectsConfig } from './project-events.js';
import type { AppContext } from './context.js';

const UUID = /^[0-9a-f-]{36}$/i;

/** Redis set of the members inside a project's HQ right now. */
export function hqPresenceKey(projectId: string): string {
  return `projects:hq:members:${projectId}`;
}

/** How long a presence set lives without a refresh from the room. */
export const HQ_PRESENCE_TTL_SEC = 90;

/** @returns The fixed Colyseus roomId of a project's HQ. */
export function hqRoomId(projectId: string): string {
  return `hq_${projectId}`;
}

export interface HqTicket {
  readonly roomName: 'project_hq';
  readonly roomId: string;
  readonly venueId: 'hackathon_house';
  readonly projectId: string;
  readonly expiresAt: string;
}

/**
 * The caller's role in a project, and the project's status.
 * @param ctx - The application context.
 * @param projectId - The project.
 * @param userId - The player.
 * @returns `{status, role}`; `role` null for a non-member. 404 when missing.
 */
export async function hqAccess(
  ctx: AppContext,
  projectId: string,
  userId: string,
): Promise<{ status: string; role: MemberRole | null }> {
  if (!UUID.test(projectId)) throw new NotFoundError({ kind: 'project' });
  const r = await ctx.db.withConnection((c) =>
    c.query<{ status: string; role: MemberRole | null }>(
      `SELECT p.status, pm.role
         FROM projects p
         LEFT JOIN project_members pm ON pm.project_id = p.project_id AND pm.user_id = $2
        WHERE p.project_id = $1`,
      [projectId, UUID.test(userId) ? userId : null],
    ),
  );
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ kind: 'project' });
  return { status: row.status, role: row.role ?? null };
}

/**
 * A ticket to the project's HQ room.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param projectId - The project.
 * @returns The ticket; 403 `members_only` when a non-member comes and no member is in.
 */
export async function hqVisitTicket(
  ctx: AppContext,
  userId: string,
  projectId: string,
): Promise<HqTicket> {
  const a = await hqAccess(ctx, projectId, userId);
  if (a.status === 'rugged') throw new ConflictError({ reason: 'wrong_status', status: a.status });
  if (a.role === null) {
    const inside = await ctx.redis.main.scard(hqPresenceKey(projectId));
    if (inside === 0) throw new ForbiddenError({ reason: 'members_only' });
  }
  const ttl = projectsConfig(ctx).hq.ticketTtlSeconds;
  return {
    roomName: 'project_hq',
    roomId: hqRoomId(projectId),
    venueId: 'hackathon_house',
    projectId,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

/**
 * The room's view of who is inside: replace the presence set.
 * @param ctx - The application context.
 * @param projectId - The project.
 * @param memberIds - The members in the room now.
 */
export async function setHqMembersPresent(
  ctx: AppContext,
  projectId: string,
  memberIds: readonly string[],
): Promise<void> {
  const key = hqPresenceKey(projectId);
  const m = ctx.redis.main.multi().del(key);
  if (memberIds.length > 0) m.sadd(key, ...memberIds).expire(key, HQ_PRESENCE_TTL_SEC);
  await m.exec();
}

/**
 * Log an HQ shift: the week counts as worked for a non-founder member.
 * @param ctx - The application context.
 * @param projectId - The project.
 * @param userId - The member.
 * @param at - When the shift completed.
 * @returns True when a new week was logged.
 */
export async function recordHqShift(
  ctx: AppContext,
  projectId: string,
  userId: string,
  at: Date,
): Promise<boolean> {
  const week = isoDate(weekStartUtc(at.getTime()));
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `INSERT INTO project_work_log (project_id, user_id, week_start, source, at)
       SELECT pm.project_id, pm.user_id, $3::date, 'hq_shift', $4
         FROM project_members pm
        WHERE pm.project_id = $1 AND pm.user_id = $2 AND pm.role <> 'founder'
       ON CONFLICT DO NOTHING`,
      [projectId, userId, week, at],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}
