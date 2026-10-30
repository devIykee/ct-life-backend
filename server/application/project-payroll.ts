/**
 * Builder: the weekly payroll and the daily risk roll (run by
 * server/workers/projects.ts).
 *
 * Payroll, Monday 00:00 UTC, for the week that just ended:
 *   - a member is paid only for a week they worked: at least one ledger row
 *     with a `payroll.workLedgerReasons` reason (a career or McDonald's
 *     shift) or a `project_work_log` row (the HQ shift, B3);
 *   - the wage is the role's band (projects.json), paid BY THE GAME with a
 *     `project_payroll` ledger row (unique per project, week and member);
 *   - the treasury pays a matching operating cost (`operatingCostBps`, 100%
 *     by default), a sink, so the founder still feels payroll;
 *   - if the treasury cannot cover it, nobody is paid and the project is
 *     `paused` (`proj_payroll_missed`, `proj_paused`). Funding resumes it.
 * Cash never moves from one player to another: the founder's Cash only
 * ever goes into the treasury, and the treasury only into sinks.
 *
 * Risk, daily, for live projects with a coin: at most one event
 * (projects.json `risk.events`), a treasury loss and a launchpad price shock
 * (the market engine starts every tick from the stored price, so the shock
 * holds like trade impact).
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  isoDate,
  planPayroll,
  rollRisk,
  weekStartUtc,
  type MemberRole,
} from '../shared/domain/projects.js';
import type { Rng } from '../shared/domain/rng.js';
import { creditCash } from './rewards.js';
import { publishWorldEvent } from './realtime-bus.js';
import {
  projectsConfig,
  publishProjectEvent,
  recordProjectEvent,
  type ProjectEventRow,
} from './project-events.js';
import type { AppContext } from './context.js';

const RC = { isolation: 'read committed' } as const;
const WEEK_MS = 7 * 86_400_000;

export interface PayrollResult {
  readonly projects: number;
  readonly paid: number;
  readonly paused: number;
  readonly wagesCents: number;
}

/**
 * Run payroll for every founded or live project, for the week before `now`.
 * Idempotent per project and week (project_payroll_runs).
 * @param ctx - The application context.
 * @param now - The run time (Monday 00:00 UTC in production).
 * @returns Counts for the log.
 */
export async function runWeeklyPayroll(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<PayrollResult> {
  const weekStart = weekStartUtc(now.getTime()) - WEEK_MS;
  const ids = await ctx.db.withConnection((c) =>
    c.query<{ project_id: string }>(
      `SELECT project_id FROM projects WHERE status IN ('founded', 'live') ORDER BY project_id`,
    ),
  );
  const out = { projects: 0, paid: 0, paused: 0, wagesCents: 0 };
  for (const { project_id } of ids.rows) {
    try {
      const r = await payProject(ctx, project_id, weekStart, now);
      if (r === null) continue;
      out.projects++;
      if (r.paused) out.paused++;
      else if (r.wagesCents > 0) out.paid++;
      out.wagesCents += r.wagesCents;
    } catch (e) {
      console.error(`[projects] payroll ${project_id} failed:`, (e as Error).message);
    }
  }
  return out;
}

/**
 * One project's payroll for one week (exported for tests; the worker runs
 * every project through `runWeeklyPayroll`).
 * @param ctx - The application context.
 * @param projectId - The project.
 * @param weekStartMs - Monday 00:00 UTC of the week being paid.
 * @param now - The run time.
 * @returns null when the week already ran or the project is not paying.
 */
export async function payProject(
  ctx: AppContext,
  projectId: string,
  weekStartMs: number,
  now: Date,
): Promise<{ paused: boolean; wagesCents: number } | null> {
  const cfg = projectsConfig(ctx);
  const week = isoDate(weekStartMs);
  const weekEnd = new Date(weekStartMs + WEEK_MS);
  const res = await runInTransaction(async (c) => {
    const claim = await c.query(
      `INSERT INTO project_payroll_runs (project_id, week_start, wages_cents, operating_cost_cents, paid)
       VALUES ($1, $2, 0, 0, false) ON CONFLICT DO NOTHING`,
      [projectId, week],
    );
    if ((claim.rowCount ?? 0) === 0) return null; // this week already ran
    const p = await c.query<{ status: string; cash_cents: string }>(
      `SELECT status, cash_cents FROM projects WHERE project_id = $1 FOR UPDATE`,
      [projectId],
    );
    const proj = p.rows[0];
    if (!proj || (proj.status !== 'founded' && proj.status !== 'live')) return null;
    const m = await c.query<{
      user_id: string;
      role: MemberRole;
      salary_cents_per_week: string;
      worked: boolean;
    }>(
      `SELECT pm.user_id, pm.role, pm.salary_cents_per_week,
              (EXISTS (SELECT 1 FROM ledger_entries le
                        WHERE le.user_id = pm.user_id AND le.reason = ANY($2::text[])
                          AND le.created_at >= $3 AND le.created_at < $4)
               OR EXISTS (SELECT 1 FROM project_work_log w
                           WHERE w.project_id = pm.project_id AND w.user_id = pm.user_id
                             AND w.week_start = $5::date)) AS worked
         FROM project_members pm WHERE pm.project_id = $1`,
      [projectId, cfg.payroll.workLedgerReasons, new Date(weekStartMs), weekEnd, week],
    );
    const plan = planPayroll(
      cfg,
      m.rows.map((r) => ({
        userId: r.user_id,
        role: r.role,
        salaryCentsPerWeek: Number(r.salary_cents_per_week),
        worked: r.worked,
      })),
      Number(proj.cash_cents),
    );
    const events: ProjectEventRow[] = [];
    const wagesCents = plan.wages.reduce((s, w) => s + w.cents, 0);
    if (plan.operatingCostCents === 0) return { paused: false, wagesCents: 0, events };
    if (!plan.affordable) {
      await c.query(`UPDATE projects SET status = 'paused', paused_at = $2 WHERE project_id = $1`, [
        projectId,
        now,
      ]);
      for (const eventId of ['proj_payroll_missed', 'proj_paused']) {
        const e = await recordProjectEvent(c, {
          projectId,
          eventId,
          params: { needCents: String(plan.operatingCostCents), week },
          at: now,
          dedupeKey: `${eventId}:${projectId}:${week}`,
        });
        if (e) events.push(e);
      }
      await c.query(
        `UPDATE project_payroll_runs SET operating_cost_cents = $3 WHERE project_id = $1 AND week_start = $2`,
        [projectId, week, plan.operatingCostCents],
      );
      return { paused: true, wagesCents: 0, events };
    }
    await c.query(`UPDATE projects SET cash_cents = cash_cents - $2 WHERE project_id = $1`, [
      projectId,
      plan.operatingCostCents,
    ]);
    for (const w of plan.wages) {
      await creditCash(
        c,
        w.userId,
        w.cents,
        'project_payroll',
        'project',
        projectId,
        `proj-wage:${projectId}:${week}:${w.userId}`,
      );
    }
    const e = await recordProjectEvent(c, {
      projectId,
      eventId: 'proj_payroll_paid',
      cashDeltaCents: -plan.operatingCostCents,
      params: { wagesCents: String(wagesCents), paidMembers: String(plan.wages.length), week },
      at: now,
      dedupeKey: `proj_payroll_paid:${projectId}:${week}`,
    });
    if (e) events.push(e);
    await c.query(
      `UPDATE project_payroll_runs SET wages_cents = $3, operating_cost_cents = $4, paid = true
        WHERE project_id = $1 AND week_start = $2`,
      [projectId, week, wagesCents, plan.operatingCostCents],
    );
    return { paused: false, wagesCents, events };
  }, RC);
  if (res === null) return null;
  for (const e of res.events) await publishProjectEvent(ctx, e);
  return { paused: res.paused, wagesCents: res.wagesCents };
}

/**
 * Daily risk roll for every live project with a coin. One roll per project
 * per UTC day (a Redis claim), so a retried job cannot roll twice.
 * @param ctx - The application context.
 * @param rng - Injected randomness.
 * @param now - The run time.
 * @returns How many events fired.
 */
export async function runDailyRisk(
  ctx: AppContext,
  rng: Rng,
  now: Date = new Date(),
): Promise<number> {
  const day = isoDate(now.getTime());
  const live = await ctx.db.withConnection((c) =>
    c.query<{ project_id: string }>(
      `SELECT project_id FROM projects WHERE status = 'live' AND coin_id IS NOT NULL ORDER BY project_id`,
    ),
  );
  let fired = 0;
  for (const { project_id: projectId } of live.rows) {
    try {
      const claimed = await ctx.redis.main.set(
        `projects:risk:${day}:${projectId}`,
        '1',
        'EX',
        172_800,
        'NX',
      );
      if (claimed !== 'OK') continue;
      if (await rollProjectRisk(ctx, projectId, rng, now)) fired++;
    } catch (e) {
      console.error(`[projects] risk ${projectId} failed:`, (e as Error).message);
    }
  }
  return fired;
}

/**
 * Roll one live project's risk for `now`'s UTC day and apply the outcome
 * (exported for tests; `runDailyRisk` adds the per-day claim).
 * @param ctx - The application context.
 * @param projectId - The project.
 * @param rng - Injected randomness.
 * @param now - The roll time.
 * @returns The event that fired, or null.
 */
export async function rollProjectRisk(
  ctx: AppContext,
  projectId: string,
  rng: Rng,
  now: Date,
): Promise<ProjectEventRow | null> {
  const cfg = projectsConfig(ctx);
  const day = isoDate(now.getTime());
  const res = await runInTransaction(async (c) => {
    const p = await c.query<{
      cash_cents: string;
      coin_id: string;
      name: string | null;
      status: string;
    }>(`SELECT cash_cents, coin_id, name, status FROM projects WHERE project_id = $1 FOR UPDATE`, [
      projectId,
    ]);
    const proj = p.rows[0];
    if (!proj || proj.status !== 'live' || proj.coin_id === null) return null;
    const roles = await c.query<{ role: MemberRole }>(
      `SELECT role FROM project_members WHERE project_id = $1`,
      [projectId],
    );
    const out = rollRisk(cfg, new Set(roles.rows.map((r) => r.role)), Number(proj.cash_cents), rng);
    if (!out) return null;
    // The event row is the once-per-day claim: write it first, and apply the
    // losses only when it was new.
    const e = await recordProjectEvent(c, {
      projectId,
      eventId: out.def.id,
      cashDeltaCents: out.treasuryDeltaCents,
      params: { priceShockBps: String(out.def.priceShockBps), coinId: proj.coin_id },
      at: now,
      dedupeKey: `risk:${projectId}:${day}`,
    });
    if (!e) return null;
    if (out.treasuryDeltaCents !== 0) {
      await c.query(
        `UPDATE projects SET cash_cents = GREATEST(0, cash_cents + $2) WHERE project_id = $1`,
        [projectId, out.treasuryDeltaCents],
      );
    }
    if (out.def.priceShockBps !== 0) {
      await c.query(
        `UPDATE coins SET price_micros = GREATEST(1, price_micros * (10000 + $2::bigint) / 10000)
          WHERE coin_id = $1 AND stage <> 'dead'`,
        [proj.coin_id, out.def.priceShockBps],
      );
    }
    return {
      e,
      world: out.def.worldEventId ?? null,
      name: proj.name ?? 'Project',
      coinId: proj.coin_id,
    };
  }, RC);
  if (!res) return null;
  await publishProjectEvent(ctx, res.e);
  if (res.world) {
    await publishWorldEvent(ctx, res.world, { projectId, name: res.name, coinId: res.coinId });
  }
  return res.e;
}
