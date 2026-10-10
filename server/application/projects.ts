/**
 * Player projects service (M5 #65).
 *
 * Endpoints:
 *
 *   POST /v1/projects                — found a project (kind + cash
 *                                      seed). The Builder -30% perk
 *                                      lowers the seed cost (out of
 *                                      M5 scope; the perk check is
 *                                      left as a TODO). Debits the
 *                                      seed via a 'project_seed'
 *                                      ledger row.
 *   POST /v1/projects/{id}/hire      — hire a player (role + salary).
 *                                      Inserts project_hires, weekly
 *                                      salary debits from the project
 *                                      owner's cash via a
 *                                      'project_payroll' ledger row.
 *   POST /v1/projects/{id}/launch    — flip status 'founded' -> 'launching'.
 *                                      The M3 launchpad flow (M3 #42)
 *                                      runs from there; for M5 we just
 *                                      flip the status and return.
 *   GET  /v1/projects/{id}           — return the project + hires + status.
 *
 * The weekly payroll worker (server/workers/projects.ts) debits
 * every project_hire's salary from the owner's cash every Monday
 * 00:00 UTC. When cash < salary the project's status flips to
 * 'paused'.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ConflictError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

export type ProjectKind = 'memecoin' | 'dex' | 'nft_studio' | 'perps_venue' | 'l2';
export type ProjectStatus = 'founded' | 'launching' | 'live' | 'paused' | 'rugged';
export type ProjectRole = 'dev' | 'mod' | 'kol' | 'auditor';

export interface ProjectRow {
  readonly projectId: string;
  readonly ownerUserId: string;
  readonly kind: ProjectKind;
  readonly status: ProjectStatus;
  readonly cashCents: number;
  readonly createdAt: string;
}

export interface ProjectHireRow {
  readonly hireId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly role: ProjectRole;
  readonly salaryCentsPerWeek: number;
  readonly hiredAt: string;
}

const SEED_COST_BY_KIND: Record<ProjectKind, number> = {
  memecoin: 50_000,
  dex: 250_000,
  nft_studio: 200_000,
  perps_venue: 400_000,
  l2: 1_000_000,
};

interface ProjectDbRow {
  project_id: string;
  owner_user_id: string;
  kind: ProjectKind;
  status: ProjectStatus;
  cash_cents: string;
  created_at: Date;
}

interface ProjectHireDbRow {
  hire_id: string;
  project_id: string;
  user_id: string;
  role: ProjectRole;
  salary_cents_per_week: string;
  hired_at: Date;
}

function rowToProject(r: ProjectDbRow): ProjectRow {
  return {
    projectId: r.project_id,
    ownerUserId: r.owner_user_id,
    kind: r.kind,
    status: r.status,
    cashCents: Number(r.cash_cents),
    createdAt: r.created_at.toISOString(),
  };
}

function rowToHire(r: ProjectHireDbRow): ProjectHireRow {
  return {
    hireId: r.hire_id,
    projectId: r.project_id,
    userId: r.user_id,
    role: r.role,
    salaryCentsPerWeek: Number(r.salary_cents_per_week),
    hiredAt: r.hired_at.toISOString(),
  };
}

/** Found a project. Debits the seed cost. */
export async function foundProject(
  _ctx: AppContext,
  ownerUserId: string,
  kind: ProjectKind,
  name?: string,
  ticker?: string,
): Promise<ProjectRow> {
  const seedCost = SEED_COST_BY_KIND[kind];
  if (seedCost === undefined) {
    throw new ValidationFailedError({ reason: `unknown project kind ${kind}` });
  }
  const projectId = uuidv7();
  const result = await runInTransaction(async (client) => {
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
    const r = await client.query<ProjectDbRow>(
      `INSERT INTO projects (project_id, owner_user_id, kind, status, cash_cents, name, ticker)
       VALUES ($1, $2, $3, 'founded', $4, $5, $6)
       RETURNING project_id, owner_user_id, kind, status, cash_cents, created_at`,
      [
        projectId,
        ownerUserId,
        kind,
        seedCost,
        name ?? kind.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()),
        ticker ?? null,
      ],
    );
    return r.rows[0]!;
  });
  return rowToProject(result);
}

/** Hire a player into a project. */
export async function hirePlayer(
  _ctx: AppContext,
  ownerUserId: string,
  projectId: string,
  args: { userId: string; role: ProjectRole; salaryCentsPerWeek: number },
): Promise<ProjectHireRow> {
  if (args.salaryCentsPerWeek <= 0) {
    throw new ValidationFailedError({ reason: 'salaryCentsPerWeek > 0 required' });
  }
  const hireId = uuidv7();
  const result = await runInTransaction(async (client) => {
    // Lock the project.
    const pR = await client.query<ProjectDbRow>(
      `SELECT project_id, owner_user_id, kind, status, cash_cents, created_at
       FROM projects WHERE project_id = $1 FOR UPDATE`,
      [projectId],
    );
    const project = pR.rows[0];
    if (!project) throw new NotFoundError({ reason: 'project not found' });
    if (project.owner_user_id !== ownerUserId) {
      throw new ConflictError({ reason: 'only the owner may hire' });
    }
    if (project.status === 'rugged') {
      throw new ValidationFailedError({ reason: 'project is rugged' });
    }
    // Lock the new hire's balance (debit the first week's salary
    // immediately; the weekly worker debits future weeks).
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
    if (cash < BigInt(args.salaryCentsPerWeek)) {
      throw new ValidationFailedError({
        reason: 'insufficient cash for first week salary',
        have: cash.toString(),
        need: args.salaryCentsPerWeek.toString(),
      });
    }
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents - $1, updated_at = now() WHERE user_id = $2`,
      [args.salaryCentsPerWeek, ownerUserId],
    );
    // Credit the hired player's balance.
    await client.query(
      `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [args.userId],
    );
    await client.query(
      `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
      [args.salaryCentsPerWeek, args.userId],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'project_payroll', 'project_hire', $3, $4)`,
      [ownerUserId, -args.salaryCentsPerWeek, hireId, `proj-payroll:${hireId}:${uuidv7()}`],
    );
    await client.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
       VALUES ($1, $2, 'cash', 'project_payroll', 'project_hire', $3, $4)`,
      [args.userId, args.salaryCentsPerWeek, hireId, `proj-payroll-in:${hireId}:${uuidv7()}`],
    );
    // Insert the project_hires row. UNIQUE (project_id, user_id)
    // means a duplicate insert fires 23505 -> translate to 409.
    try {
      const r = await client.query<ProjectHireDbRow>(
        `INSERT INTO project_hires (hire_id, project_id, user_id, role, salary_cents_per_week)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING hire_id, project_id, user_id, role, salary_cents_per_week, hired_at`,
        [hireId, projectId, args.userId, args.role, args.salaryCentsPerWeek],
      );
      return r.rows[0]!;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictError({ reason: 'user already hired into this project' });
      }
      throw e;
    }
  });
  return rowToHire(result);
}

/** Launch: flip founded -> launching. */
export async function launchProject(
  _ctx: AppContext,
  ownerUserId: string,
  projectId: string,
): Promise<ProjectRow> {
  const result = await runInTransaction(async (client) => {
    const r = await client.query<ProjectDbRow>(
      `UPDATE projects SET status = 'launching'
       WHERE project_id = $1 AND owner_user_id = $2 AND status = 'founded'
       RETURNING project_id, owner_user_id, kind, status, cash_cents, created_at`,
      [projectId, ownerUserId],
    );
    if (!r.rows[0]) {
      throw new NotFoundError({ reason: 'project not in founded state' });
    }
    return r.rows[0];
  });
  return rowToProject(result);
}

/**
 *
 */
export async function getProject(
  ctx: AppContext,
  projectId: string,
): Promise<{ project: ProjectRow; hires: ProjectHireRow[] }> {
  const project = await ctx.db.withConnection(async (c) => {
    const r = await c.query<ProjectDbRow>(
      `SELECT project_id, owner_user_id, kind, status, cash_cents, created_at
       FROM projects WHERE project_id = $1`,
      [projectId],
    );
    return r.rows[0];
  });
  if (!project) throw new NotFoundError({ reason: 'project not found' });
  const hires = await ctx.db.withConnection(async (c) => {
    const r = await c.query<ProjectHireDbRow>(
      `SELECT hire_id, project_id, user_id, role, salary_cents_per_week, hired_at
       FROM project_hires WHERE project_id = $1
       ORDER BY hired_at ASC`,
      [projectId],
    );
    return r.rows.map(rowToHire);
  });
  return { project: rowToProject(project), hires };
}

void ConflictError;

export interface ProjectListRow {
  readonly projectId: string;
  readonly name: string | null;
  readonly ticker: string | null;
  readonly kind: string;
  readonly status: string;
  readonly ownerUserId: string;
  readonly ownerAlias: string | null;
  readonly memberCount: number;
  readonly treasuryCents: number;
  readonly createdAt: string;
}

/**
 * List projects for the Builder Hills boards.
 *
 * `mine` is what I founded or work for, `all` is every project that is not
 * rugged, ordered by treasury. There is no open-role record yet, so
 * `hiring` falls back to `all`.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @param scope - mine, hiring or all.
 * @param limit - Page size, capped by the caller.
 * @returns The projects, newest or richest first depending on scope.
 */
export async function listProjects(
  ctx: AppContext,
  userId: string,
  scope: 'mine' | 'hiring' | 'all',
  limit: number,
): Promise<ProjectListRow[]> {
  const mine = scope === 'mine';
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      project_id: string;
      owner_user_id: string;
      kind: string;
      status: string;
      cash_cents: string;
      created_at: Date;
      name: string | null;
      ticker: string | null;
      owner_alias: string | null;
      member_count: string;
    }>(
      `SELECT p.project_id, p.owner_user_id, p.kind, p.status, p.cash_cents, p.created_at,
              p.name, p.ticker, ch.alias AS owner_alias,
              (SELECT COUNT(*) FROM project_hires h WHERE h.project_id = p.project_id)::text
                AS member_count
         FROM projects p
         LEFT JOIN characters ch ON ch.user_id = p.owner_user_id
        WHERE ($2::boolean IS FALSE AND p.status <> 'rugged')
           OR ($2::boolean IS TRUE AND (
                 p.owner_user_id = $1
                 OR EXISTS (SELECT 1 FROM project_hires h
                             WHERE h.project_id = p.project_id AND h.user_id = $1)))
        ORDER BY CASE WHEN $2::boolean THEN p.created_at END DESC NULLS LAST,
                 p.cash_cents DESC,
                 p.created_at DESC
        LIMIT $3`,
      [userId, mine, limit],
    );
  });
  return r.rows.map((row) => ({
    projectId: row.project_id,
    name: row.name,
    ticker: row.ticker,
    kind: row.kind,
    status: row.status,
    ownerUserId: row.owner_user_id,
    ownerAlias: row.owner_alias,
    memberCount: Number(row.member_count),
    treasuryCents: Number(row.cash_cents),
    createdAt: row.created_at.toISOString(),
  }));
}

export interface HireOfferRow {
  readonly offerId: string;
  readonly projectId: string;
  readonly projectName: string | null;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly role: string;
  readonly salaryCentsPerWeek: number;
  readonly status: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

/**
 * Role offers sent to me.
 * @param ctx - The application context.
 * @param userId - The calling user.
 * @param status - Optional status filter.
 * @param limit - Page size.
 * @returns Offers, newest first.
 */
export async function listMyProjectOffers(
  ctx: AppContext,
  userId: string,
  status: string | null,
  limit: number,
): Promise<HireOfferRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      offer_id: string;
      project_id: string;
      project_name: string | null;
      from_user_id: string;
      to_user_id: string;
      role: string;
      salary_cents_per_week: string;
      status: string;
      expires_at: Date;
      created_at: Date;
    }>(
      `SELECT o.offer_id, o.project_id, p.name AS project_name, o.from_user_id, o.to_user_id,
              o.role, o.salary_cents_per_week, o.status, o.expires_at, o.created_at
         FROM project_offers o
         JOIN projects p ON p.project_id = o.project_id
        WHERE o.to_user_id = $1
          AND ($2::text IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC
        LIMIT $3`,
      [userId, status, limit],
    );
  });
  return r.rows.map((row) => ({
    offerId: row.offer_id,
    projectId: row.project_id,
    projectName: row.project_name,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    role: row.role,
    salaryCentsPerWeek: Number(row.salary_cents_per_week),
    status: row.status,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }));
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
