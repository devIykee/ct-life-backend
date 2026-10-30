/**
 * Project tasks (Builder): the work that earns a member's weekly wage.
 *
 *   POST /v1/projects/{id}/tasks                    start a timed task
 *   POST /v1/projects/{id}/tasks/{taskId}/complete  finish it once the timer ran
 *
 * A finished task writes `project_work_log` for THIS project and the current
 * UTC week. That row (or the HQ shift in B3) is the only thing payroll counts
 * as work: generic career shifts do not, so a founder cannot pay an alt for
 * playing elsewhere. One counted task per member, project and week. The
 * founder earns no wage and has no tasks.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../shared/domain/errors.js';
import { isoDate, weekStartUtc } from '../shared/domain/projects.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { lockProject } from './projects.js';
import { projectsConfig } from './project-events.js';
import type { AppContext } from './context.js';

const RC = { isolation: 'read committed' } as const;
const UUID = /^[0-9a-f-]{36}$/i;

export interface ProjectTask {
  readonly taskId: string;
  readonly projectId: string;
  readonly startedAt: string;
  readonly endsAt: string;
}

export interface ProjectTaskDone {
  readonly taskId: string;
  readonly projectId: string;
  readonly completedAt: string;
  /** Monday (UTC) of the week this task counts for, YYYY-MM-DD. */
  readonly weekStart: string;
  readonly worked: true;
}

/**
 * Start a task. Non-founder members only.
 * @param ctx - The application context.
 * @param userId - The member.
 * @param projectId - The project.
 * @returns The task and when it can be completed.
 */
export async function startProjectTask(
  ctx: AppContext,
  userId: string,
  projectId: string,
): Promise<ProjectTask> {
  const minutes = projectsConfig(ctx).task.durationMinutes;
  const now = new Date();
  const week = isoDate(weekStartUtc(now.getTime()));
  return runInTransaction(async (c) => {
    const p = await lockProject(c, projectId);
    if (p.status === 'rugged')
      throw new ConflictError({ reason: 'wrong_status', status: p.status });
    const m = await c.query<{ role: string }>(
      `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    const role = m.rows[0]?.role;
    if (role === undefined) throw new ForbiddenError({ reason: 'not_member' });
    if (role === 'founder') throw new ForbiddenError({ reason: 'founder_no_wage' });
    const done = await c.query(
      `SELECT 1 FROM project_work_log WHERE project_id = $1 AND user_id = $2 AND week_start = $3::date`,
      [projectId, userId, week],
    );
    if ((done.rowCount ?? 0) > 0)
      throw new ConflictError({ reason: 'already_worked', weekStart: week });
    const open = await c.query<{ task_id: string; ends_at: Date }>(
      `SELECT task_id, ends_at FROM project_tasks
        WHERE project_id = $1 AND user_id = $2 AND completed_at IS NULL`,
      [projectId, userId],
    );
    if (open.rows[0]) {
      throw new ConflictError({
        reason: 'task_in_progress',
        taskId: open.rows[0].task_id,
        endsAt: open.rows[0].ends_at.toISOString(),
      });
    }
    const taskId = uuidv7();
    const endsAt = new Date(now.getTime() + minutes * 60_000);
    await c.query(
      `INSERT INTO project_tasks (task_id, project_id, user_id, started_at, ends_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [taskId, projectId, userId, now, endsAt],
    );
    return { taskId, projectId, startedAt: now.toISOString(), endsAt: endsAt.toISOString() };
  }, RC);
}

/**
 * Complete a task whose timer has run; the week counts as worked.
 * @param ctx - The application context.
 * @param userId - The member.
 * @param projectId - The project.
 * @param taskId - The task.
 * @returns The finished task and the week it counts for.
 */
export async function completeProjectTask(
  _ctx: AppContext,
  userId: string,
  projectId: string,
  taskId: string,
): Promise<ProjectTaskDone> {
  if (!UUID.test(taskId) || !UUID.test(projectId)) throw new NotFoundError({ kind: 'task' });
  const now = new Date();
  const week = isoDate(weekStartUtc(now.getTime()));
  return runInTransaction(async (c) => {
    const t = await c.query<{ ends_at: Date; completed_at: Date | null }>(
      `SELECT ends_at, completed_at FROM project_tasks
        WHERE task_id = $1 AND project_id = $2 AND user_id = $3 FOR UPDATE`,
      [taskId, projectId, userId],
    );
    const task = t.rows[0];
    if (!task) throw new NotFoundError({ kind: 'task' });
    if (task.completed_at !== null) throw new ConflictError({ reason: 'not_open' });
    if (task.ends_at.getTime() > now.getTime()) {
      throw new ConflictError({ reason: 'task_not_finished', endsAt: task.ends_at.toISOString() });
    }
    const m = await c.query(
      `SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role <> 'founder'`,
      [projectId, userId],
    );
    if ((m.rowCount ?? 0) === 0) throw new ForbiddenError({ reason: 'not_member' });
    await c.query(`UPDATE project_tasks SET completed_at = $2 WHERE task_id = $1`, [taskId, now]);
    await c.query(
      `INSERT INTO project_work_log (project_id, user_id, week_start, source, at)
       VALUES ($1, $2, $3::date, 'project_task', $4)
       ON CONFLICT DO NOTHING`,
      [projectId, userId, week, now],
    );
    return { taskId, projectId, completedAt: now.toISOString(), weekStart: week, worked: true };
  }, RC);
}
