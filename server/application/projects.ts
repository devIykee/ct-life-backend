/**
 * Player projects (Builder): found, read, fund, and members.
 *
 *   POST   /v1/projects                         found (seed Cash -> treasury)
 *   GET    /v1/projects?scope=mine|hiring|all   boards
 *   GET    /v1/projects/{id}                    detail (members, payroll, events)
 *   POST   /v1/projects/{id}/fund               founder's own Cash -> own treasury
 *   DELETE /v1/projects/{id}/members/{userId}   fire (founder) or quit (self)
 *   GET    /v1/me/project-offers                role offers sent to me
 *
 * Role offers live in project-offers.ts, launch in project-launch.ts, the
 * weekly payroll and the daily risk roll in project-payroll.ts.
 *
 * Economy rule (docs/ECONOMY.md): Cash never moves between players. The
 * treasury (`projects.cash_cents`, `treasuryCents` on the wire) is filled
 * only from the founder's own Cash (and, in B2, NPC VC money) and is spent
 * only on sinks. It is never withdrawable. Members' wages are paid by the
 * game (see project-payroll.ts); POST /projects/{id}/hire, which debited the
 * founder and credited the hire, answers 410 GONE.
 *
 * Over the 300-line soft limit on purpose: every read and write here shares
 * the summary SELECT and the locked-row helper that hold the treasury rule.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import {
  ConflictError,
  ForbiddenError,
  InsufficientCashError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  HIRE_ROLES,
  isoDate,
  nextPayrollAt,
  weekStartUtc,
  payableWage,
  type HireRole,
  type MemberRole,
  type ProjectKind,
  type ProjectStatus,
} from '../shared/domain/projects.js';
import { recordCareerAction } from './ladders.js';
import {
  projectsConfig,
  publishProjectEvent,
  recordProjectEvent,
  type ProjectEventRow,
} from './project-events.js';
import type { AppContext } from './context.js';

export type { ProjectKind, ProjectStatus } from '../shared/domain/projects.js';
export type ProjectRole = HireRole;

const SEED_COST_BY_KIND: Record<ProjectKind, number> = {
  memecoin: 50_000,
  dex: 250_000,
  nft_studio: 200_000,
  perps_venue: 400_000,
  l2: 1_000_000,
};

const RC = { isolation: 'read committed' } as const;

/** `ProjectSummary` in the contract (plus the legacy `cashCents` = treasury). */
export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly ticker: string | null;
  readonly kind: ProjectKind;
  readonly status: ProjectStatus;
  readonly ownerUserId: string;
  readonly ownerAlias: string;
  readonly memberCount: number;
  readonly treasuryCents: number;
  /** Same value as `treasuryCents`; kept for clients of the first shape. */
  readonly cashCents: number;
  readonly coinId: string | null;
  readonly openRoles: HireRole[];
  readonly createdAt: string;
}

export interface ProjectMemberRow {
  readonly userId: string;
  readonly alias: string;
  readonly role: MemberRole;
  readonly salaryCentsPerWeek: number;
  readonly joinedAt: string;
}

/** The first `GET /projects/{id}` shape, still sent as `hires`. */
export interface ProjectHireRow {
  readonly hireId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly role: HireRole;
  readonly salaryCentsPerWeek: number;
  readonly hiredAt: string;
}

export interface ProjectDetail {
  readonly project: ProjectSummary;
  readonly members: ProjectMemberRow[];
  readonly hires: ProjectHireRow[];
  readonly payrollCentsPerWeek: number;
  readonly nextPayrollAt: string | null;
  readonly vcStakes: unknown[];
  readonly recentEvents: ProjectEventRow[];
  /** The caller's open project task, or null (not a member, or none open). */
  readonly myTask: { taskId: string; startedAt: string; endsAt: string } | null;
  /** Whether the caller's week (Monday 00:00 UTC) already counts as worked here. */
  readonly workedThisWeek: boolean;
}

interface SummaryDbRow {
  project_id: string;
  owner_user_id: string;
  kind: ProjectKind;
  status: ProjectStatus;
  cash_cents: string;
  created_at: Date;
  name: string | null;
  ticker: string | null;
  coin_id: string | null;
  owner_alias: string | null;
  member_count: number;
  roles: string[] | null;
}

const SUMMARY_SELECT = `
  SELECT p.project_id, p.owner_user_id, p.kind, p.status, p.cash_cents, p.created_at,
         p.name, p.ticker, p.coin_id, ch.alias AS owner_alias,
         COALESCE(m.cnt, 0)::int AS member_count, m.roles
    FROM projects p
    LEFT JOIN characters ch ON ch.user_id = p.owner_user_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS cnt, array_agg(pm.role) AS roles
        FROM project_members pm WHERE pm.project_id = p.project_id
    ) m ON true`;

function kindLabel(kind: string): string {
  return kind.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function toSummary(r: SummaryDbRow): ProjectSummary {
  const filled = new Set(r.roles ?? []);
  const open =
    r.status === 'rugged' ? [] : HIRE_ROLES.filter((role) => !filled.has(role)).map((x) => x);
  const treasury = Number(r.cash_cents);
  return {
    projectId: r.project_id,
    name: r.name ?? kindLabel(r.kind),
    ticker: r.ticker,
    kind: r.kind,
    status: r.status,
    ownerUserId: r.owner_user_id,
    ownerAlias: r.owner_alias ?? 'anon',
    memberCount: r.member_count,
    treasuryCents: treasury,
    cashCents: treasury,
    coinId: r.coin_id,
    openRoles: open,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * @param c - A connection or open transaction.
 * @param projectId - The project.
 * @returns The summary, or null when there is no such project.
 */
export async function loadSummary(
  c: PoolClient,
  projectId: string,
): Promise<ProjectSummary | null> {
  const r = await c.query<SummaryDbRow>(`${SUMMARY_SELECT} WHERE p.project_id = $1`, [projectId]);
  return r.rows[0] ? toSummary(r.rows[0]) : null;
}

/** The locked project row the write paths need. */
export interface LockedProject {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly kind: ProjectKind;
  readonly status: ProjectStatus;
  readonly treasuryCents: number;
  readonly name: string;
  readonly coinId: string | null;
  readonly createdAt: Date;
}

/**
 * Lock a project row (FOR UPDATE) in the caller's transaction.
 * @param client - The open transaction.
 * @param projectId - The project.
 * @returns The row; throws 404 when missing.
 */
export async function lockProject(client: PoolClient, projectId: string): Promise<LockedProject> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new NotFoundError({ kind: 'project' });
  const r = await client.query<{
    project_id: string;
    owner_user_id: string;
    kind: ProjectKind;
    status: ProjectStatus;
    cash_cents: string;
    name: string | null;
    coin_id: string | null;
    created_at: Date;
  }>(
    `SELECT project_id, owner_user_id, kind, status, cash_cents, name, coin_id, created_at
       FROM projects WHERE project_id = $1 FOR UPDATE`,
    [projectId],
  );
  const p = r.rows[0];
  if (!p) throw new NotFoundError({ kind: 'project' });
  return {
    projectId: p.project_id,
    ownerUserId: p.owner_user_id,
    kind: p.kind,
    status: p.status,
    treasuryCents: Number(p.cash_cents),
    name: p.name ?? kindLabel(p.kind),
    coinId: p.coin_id,
    createdAt: p.created_at,
  };
}

/**
 * Projects a player is in (any role, founder included) that are not rugged.
 * @param c - A connection or open transaction.
 * @param userId - The player.
 * @returns The count.
 */
export async function countActiveMemberships(c: PoolClient, userId: string): Promise<number> {
  const r = await c.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM project_members pm
       JOIN projects p ON p.project_id = pm.project_id
      WHERE pm.user_id = $1 AND p.status <> 'rugged'`,
    [userId],
  );
  return r.rows[0]?.n ?? 0;
}

/** Throw `403 FORBIDDEN {reason:'not_owner'}` unless `userId` founded the project. */
export function assertOwner(p: LockedProject, userId: string): void {
  if (p.ownerUserId !== userId) throw new ForbiddenError({ reason: 'not_owner' });
}

/**
 * Found a project. Debits the seed from the founder's Cash into the new
 * treasury and makes the founder its first member.
 * @param ctx - The application context.
 * @param ownerUserId - The founder.
 * @param kind - The project kind.
 * @param name - Optional display name (defaults to the kind).
 * @param ticker - Optional ticker label.
 * @returns The new project.
 */
export async function foundProject(
  ctx: AppContext,
  ownerUserId: string,
  kind: ProjectKind,
  name?: string,
  ticker?: string,
): Promise<ProjectSummary> {
  const seedCost = SEED_COST_BY_KIND[kind];
  if (seedCost === undefined) {
    throw new ValidationFailedError({ reason: `unknown project kind ${kind}` });
  }
  const projectId = uuidv7();
  const now = new Date();
  const maxProjects = projectsConfig(ctx).membership.maxProjectsPerPlayer;
  const { summary, event } = await runInTransaction(async (client) => {
    // Founder roles count toward the per-account project limit (with member
    // roles), so one account cannot spin up projects to stack payrolls.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `proj-member:${ownerUserId}`,
    ]);
    if ((await countActiveMemberships(client, ownerUserId)) >= maxProjects) {
      throw new ConflictError({ reason: 'project_limit', max: maxProjects });
    }
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
    if (cash < BigInt(seedCost)) {
      throw new ValidationFailedError({
        reason: 'insufficient cash for project seed',
        have: cash.toString(),
        need: seedCost.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [seedCost, ownerUserId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'project_seed', 'project', $3, $4)`,
      [ownerUserId, -seedCost, projectId, `proj-seed:${projectId}:${uuidv7()}`],
    );
    await client.query(
      `INSERT INTO projects (project_id, owner_user_id, kind, status, cash_cents, name, ticker, created_at)
       VALUES ($1, $2, $3, 'founded', $4, $5, $6, $7)`,
      [projectId, ownerUserId, kind, seedCost, name ?? kindLabel(kind), ticker ?? null, now],
    );
    await client.query(
      `INSERT INTO project_members (project_id, user_id, role, salary_cents_per_week, joined_at)
       VALUES ($1, $2, 'founder', 0, $3)`,
      [projectId, ownerUserId, now],
    );
    const ev = await recordProjectEvent(client, {
      projectId,
      eventId: 'proj_founded',
      cashDeltaCents: seedCost,
      at: now,
    });
    return { summary: (await loadSummary(client, projectId))!, event: ev };
  });
  await recordCareerAction(ctx, ownerUserId, 'project_found', projectId);
  if (event) await publishProjectEvent(ctx, event);
  return summary;
}

/**
 * Project detail: summary, members, payroll, VC stakes, recent events.
 * @param ctx - The application context.
 * @param projectId - The project.
 * @returns The detail; 404 when missing.
 */
export async function getProject(
  ctx: AppContext,
  projectId: string,
  callerId: string | null = null,
): Promise<ProjectDetail> {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new NotFoundError({ kind: 'project' });
  const cfg = projectsConfig(ctx);
  return ctx.db.withConnection(async (c) => {
    const project = await loadSummary(c, projectId);
    if (!project) throw new NotFoundError({ kind: 'project' });
    const m = await c.query<{
      user_id: string;
      alias: string | null;
      role: MemberRole;
      salary_cents_per_week: string;
      joined_at: Date;
    }>(
      `SELECT pm.user_id, ch.alias, pm.role, pm.salary_cents_per_week, pm.joined_at
         FROM project_members pm
         LEFT JOIN characters ch ON ch.user_id = pm.user_id
        WHERE pm.project_id = $1
        ORDER BY (pm.role = 'founder') DESC, pm.joined_at ASC`,
      [projectId],
    );
    const members: ProjectMemberRow[] = m.rows.map((r) => ({
      userId: r.user_id,
      alias: r.alias ?? 'anon',
      role: r.role,
      salaryCentsPerWeek: payableWage(cfg, r.role, Number(r.salary_cents_per_week)),
      joinedAt: r.joined_at.toISOString(),
    }));
    const hires: ProjectHireRow[] = members
      .filter((x): x is ProjectMemberRow & { role: HireRole } => x.role !== 'founder')
      .map((x) => ({
        hireId: `${projectId}:${x.userId}`,
        projectId,
        userId: x.userId,
        role: x.role,
        salaryCentsPerWeek: x.salaryCentsPerWeek,
        hiredAt: x.joinedAt,
      }));
    const ev = await c.query<{
      project_id: string;
      event_id: string;
      cash_delta_cents: string;
      params: Record<string, string>;
      at: Date;
    }>(
      `SELECT project_id, event_id, cash_delta_cents, params, at FROM project_events
        WHERE project_id = $1 ORDER BY id DESC LIMIT 10`,
      [projectId],
    );
    const caller = callerId !== null && /^[0-9a-f-]{36}$/i.test(callerId) ? callerId : null;
    const mine = await c.query<{
      task_id: string | null;
      started_at: Date | null;
      ends_at: Date | null;
      worked: boolean;
    }>(
      `SELECT t.task_id, t.started_at, t.ends_at,
              EXISTS (SELECT 1 FROM project_work_log w
                       WHERE w.project_id = $1 AND w.user_id = $2 AND w.week_start = $3::date) AS worked
         FROM (SELECT 1) one
         LEFT JOIN project_tasks t
           ON t.project_id = $1 AND t.user_id = $2 AND t.completed_at IS NULL`,
      [projectId, caller, isoDate(weekStartUtc(Date.now()))],
    );
    const me = mine.rows[0];
    const payroll = hires.reduce((s, h) => s + h.salaryCentsPerWeek, 0);
    const paying = project.status !== 'rugged' && project.status !== 'launching';
    return {
      project,
      members,
      hires,
      payrollCentsPerWeek: payroll,
      nextPayrollAt: paying ? new Date(nextPayrollAt(Date.now())).toISOString() : null,
      vcStakes: [],
      myTask:
        me?.task_id && me.started_at && me.ends_at
          ? {
              taskId: me.task_id,
              startedAt: me.started_at.toISOString(),
              endsAt: me.ends_at.toISOString(),
            }
          : null,
      workedThisWeek: me?.worked === true,
      recentEvents: ev.rows.map((r) => ({
        eventId: r.event_id,
        projectId: r.project_id,
        cashDeltaCents: Number(r.cash_delta_cents),
        params: r.params ?? {},
        at: r.at.toISOString(),
      })),
    };
  });
}

/**
 * Move the founder's own Cash into their project's treasury (a one-way
 * sink: treasury Cash is never withdrawable). Funding a paused project
 * resumes it.
 * @param ctx - The application context.
 * @param userId - The caller (must be the founder).
 * @param projectId - The project.
 * @param cents - Amount to move.
 * @returns `{project}` after the move.
 */
export async function fundProject(
  ctx: AppContext,
  userId: string,
  projectId: string,
  cents: number,
): Promise<{ project: ProjectSummary }> {
  const cfg = projectsConfig(ctx);
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > cfg.fund.maxCentsPerCall) {
    throw new ValidationFailedError({
      reason: 'amount_out_of_range',
      min: 1,
      max: cfg.fund.maxCentsPerCall,
    });
  }
  const now = new Date();
  const { project, events } = await runInTransaction(async (client) => {
    const p = await lockProject(client, projectId);
    assertOwner(p, userId);
    if (p.status === 'rugged')
      throw new ConflictError({ reason: 'wrong_status', status: p.status });
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    const bal = await client.query<{ cash_cents: string }>(
      `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const have = Number(bal.rows[0]?.cash_cents ?? '0');
    if (have < cents) throw new InsufficientCashError({ have, need: cents });
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [cents, userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'project_seed', 'project', $3, $4)`,
      [userId, -cents, projectId, `proj-fund:${projectId}:${uuidv7()}`],
    );
    const resume = p.status === 'paused';
    await client.query(
      `UPDATE projects
          SET cash_cents = cash_cents + $2,
              status = CASE WHEN $3::boolean THEN (CASE WHEN coin_id IS NULL THEN 'founded' ELSE 'live' END)
                            ELSE status END,
              paused_at = CASE WHEN $3::boolean THEN NULL ELSE paused_at END
        WHERE project_id = $1`,
      [projectId, cents, resume],
    );
    const evs: ProjectEventRow[] = [];
    const funded = await recordProjectEvent(client, {
      projectId,
      eventId: 'proj_funded',
      cashDeltaCents: cents,
      at: now,
    });
    if (funded) evs.push(funded);
    if (resume) {
      const r = await recordProjectEvent(client, { projectId, eventId: 'proj_resumed', at: now });
      if (r) evs.push(r);
    }
    return { project: (await loadSummary(client, projectId))!, events: evs };
  }, RC);
  for (const e of events) await publishProjectEvent(ctx, e);
  return { project };
}

/**
 * Remove a member: the founder fires anyone but themself, a member may quit.
 * @param ctx - The application context.
 * @param callerId - Who is asking.
 * @param projectId - The project.
 * @param targetUserId - The member to remove.
 */
export async function removeMember(
  ctx: AppContext,
  callerId: string,
  projectId: string,
  targetUserId: string,
): Promise<void> {
  const now = new Date();
  const event = await runInTransaction(async (client) => {
    const p = await lockProject(client, projectId);
    const m = await client.query<{ role: MemberRole }>(
      `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, targetUserId],
    );
    const role = m.rows[0]?.role;
    const self = callerId === targetUserId;
    if (!self && p.ownerUserId !== callerId) throw new ForbiddenError({ reason: 'not_owner' });
    if (role === undefined) throw new NotFoundError({ kind: 'member', reason: 'not_member' });
    if (role === 'founder') throw new ConflictError({ reason: 'cannot_remove_founder' });
    await client.query(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [
      projectId,
      targetUserId,
    ]);
    return recordProjectEvent(client, {
      projectId,
      eventId: 'proj_member_left',
      params: { userId: targetUserId, role, by: self ? 'self' : 'founder' },
      at: now,
    });
  }, RC);
  if (event) await publishProjectEvent(ctx, event, [targetUserId]);
}

/**
 * List projects for the Builder Hills boards.
 *
 * `mine` is what I founded or work for (newest first); `hiring` is every
 * founded or live project with an open role; `all` is every project that is
 * not rugged. `hiring` and `all` order by treasury.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @param scope - mine, hiring or all.
 * @param limit - Page size, capped by the caller.
 * @returns The projects.
 */
export async function listProjects(
  ctx: AppContext,
  userId: string,
  scope: 'mine' | 'hiring' | 'all',
  limit: number,
): Promise<ProjectSummary[]> {
  const where =
    scope === 'mine'
      ? `EXISTS (SELECT 1 FROM project_members x WHERE x.project_id = p.project_id AND x.user_id = $1)
           OR p.owner_user_id = $1`
      : scope === 'hiring'
        ? `p.status IN ('founded', 'live')
           AND (SELECT COUNT(*) FROM project_members x
                 WHERE x.project_id = p.project_id AND x.role <> 'founder') < ${HIRE_ROLES.length}`
        : `p.status <> 'rugged'`;
  const order = scope === 'mine' ? 'p.created_at DESC' : 'p.cash_cents DESC, p.created_at DESC';
  const r = await ctx.db.withConnection((c) =>
    c.query<SummaryDbRow>(
      `${SUMMARY_SELECT} WHERE ($1::uuid IS NOT NULL) AND (${where}) ORDER BY ${order} LIMIT $2`,
      [userId, limit],
    ),
  );
  return r.rows.map(toSummary);
}

export interface VcDealRow {
  readonly projectId: string;
  readonly projectName: string | null;
  readonly vcArchetypeId: string;
  readonly investCents: number;
  readonly equityBps: number;
  readonly status: string;
  readonly at: string;
}

/**
 * Recent VC deals for the VC Row venue board.
 * @param ctx - The application context.
 * @param limit - Page size.
 * @returns Deals, newest first.
 */
export async function listVcDeals(ctx: AppContext, limit: number): Promise<VcDealRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      project_id: string;
      project_name: string | null;
      vc_archetype_id: string;
      invest_cents: string;
      equity_bps: number;
      status: string;
      created_at: Date;
    }>(
      `SELECT d.project_id, p.name AS project_name, d.vc_archetype_id,
              d.invest_cents, d.equity_bps, d.status, d.created_at
         FROM vc_deals d
         JOIN projects p ON p.project_id = d.project_id
        ORDER BY d.created_at DESC
        LIMIT $1`,
      [limit],
    );
  });
  return r.rows.map((row) => ({
    projectId: row.project_id,
    projectName: row.project_name,
    vcArchetypeId: row.vc_archetype_id,
    investCents: Number(row.invest_cents),
    equityBps: row.equity_bps,
    status: row.status,
    at: row.created_at.toISOString(),
  }));
}
