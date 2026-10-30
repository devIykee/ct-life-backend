/**
 * Project events: the server-written lifecycle and risk log behind
 * `GET /projects/{id}/events`, `recentEvents` in the project detail, and the
 * `project_event` realtime message every member receives.
 *
 * Writes happen inside the caller's transaction (`recordProjectEvent`);
 * the push happens after commit (`publishProjectEvent`), fire and forget.
 */
import type { PoolClient } from 'pg';
import { uuidv7 } from '../shared/domain/uuid.js';
import { publishToUser } from './realtime-bus.js';
import type { AppContext } from './context.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import type { ProjectsConfig } from '../shared/domain/projects.js';

/** `ProjectEvent` in the contract. */
export interface ProjectEventRow {
  readonly eventId: string;
  readonly projectId: string;
  readonly cashDeltaCents: number;
  readonly params: Record<string, string>;
  readonly at: string;
}

interface EventDbRow {
  id: string;
  project_id: string;
  event_id: string;
  cash_delta_cents: string;
  params: Record<string, string>;
  at: Date;
}

function toEvent(r: EventDbRow): ProjectEventRow {
  return {
    eventId: r.event_id,
    projectId: r.project_id,
    cashDeltaCents: Number(r.cash_delta_cents),
    params: r.params ?? {},
    at: r.at.toISOString(),
  };
}

/** @returns projects.json, hot-cached by the config cache. */
export function projectsConfig(ctx: AppContext): ProjectsConfig {
  return ctx.configCache.load<ProjectsConfig>('projects');
}

/**
 * Write one event in the caller's transaction.
 * @param client - The open transaction.
 * @param e - The event; `dedupeKey` makes a retried write a no-op.
 * @returns The event, or null when `dedupeKey` was already written.
 */
export async function recordProjectEvent(
  client: PoolClient,
  e: {
    projectId: string;
    eventId: string;
    cashDeltaCents?: number;
    params?: Record<string, string>;
    at: Date;
    dedupeKey?: string;
  },
): Promise<ProjectEventRow | null> {
  const r = await client.query<EventDbRow>(
    `INSERT INTO project_events (id, project_id, event_id, cash_delta_cents, params, dedupe_key, at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id, project_id, event_id, cash_delta_cents, params, at`,
    [
      uuidv7(),
      e.projectId,
      e.eventId,
      e.cashDeltaCents ?? 0,
      JSON.stringify(e.params ?? {}),
      e.dedupeKey ?? null,
      e.at,
    ],
  );
  return r.rows[0] ? toEvent(r.rows[0]) : null;
}

/**
 * Push `project_event` to every member (and to `extra`, e.g. a member who
 * was just removed). Never fails the caller.
 * @param ctx - The application context.
 * @param event - The committed event.
 * @param extra - More user ids to notify.
 */
export async function publishProjectEvent(
  ctx: AppContext,
  event: ProjectEventRow,
  extra: readonly string[] = [],
): Promise<void> {
  try {
    const r = await ctx.db.withConnection((c) =>
      c.query<{ user_id: string }>(`SELECT user_id FROM project_members WHERE project_id = $1`, [
        event.projectId,
      ]),
    );
    const to = new Set([...r.rows.map((x) => x.user_id), ...extra]);
    for (const userId of to) {
      await publishToUser(ctx, userId, 'project_event', { ...event });
    }
  } catch {
    // A missed push is caught up by the next GET.
  }
}

/**
 * Newest first, keyset-paged on the uuidv7 id (time-ordered).
 * @param ctx - The application context.
 * @param projectId - The project.
 * @param cursor - The last id of the previous page, or null.
 * @param limit - Page size.
 * @returns Events and the next cursor.
 */
export async function listProjectEvents(
  ctx: AppContext,
  projectId: string,
  cursor: string | null,
  limit: number,
): Promise<{ events: ProjectEventRow[]; nextCursor: string | null }> {
  if (cursor !== null && !/^[0-9a-f-]{36}$/i.test(cursor)) {
    throw new ValidationFailedError({ reason: 'bad_cursor' });
  }
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new NotFoundError({ kind: 'project' });
  const r = await ctx.db.withConnection(async (c) => {
    const p = await c.query(`SELECT 1 FROM projects WHERE project_id = $1`, [projectId]);
    if ((p.rowCount ?? 0) === 0) throw new NotFoundError({ kind: 'project' });
    return c.query<EventDbRow>(
      `SELECT id, project_id, event_id, cash_delta_cents, params, at
         FROM project_events
        WHERE project_id = $1 AND ($2::uuid IS NULL OR id < $2::uuid)
        ORDER BY id DESC
        LIMIT $3`,
      [projectId, cursor, limit + 1],
    );
  });
  const rows = r.rows.slice(0, limit);
  const nextCursor = r.rows.length > limit ? (rows[rows.length - 1]?.id ?? null) : null;
  return { events: rows.map(toEvent), nextCursor };
}
