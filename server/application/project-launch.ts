/**
 * Project launch (Builder): list the project's token on the in-game,
 * server-simulated launchpad. Nothing is minted on chain.
 *
 *   GET  /v1/projects/{id}/launch-quote   cost now (Builder tribe -30%) and blockers
 *   POST /v1/projects/{id}/launch         {ticker, quotedCostCents}
 *
 * The cost is paid from the project treasury (a sink). The coin is created by
 * the existing `launchCoin` in launchpad.ts (used as is), so it ticks on the
 * market like any player coin. Steps:
 *   1. lock the project, recompute the quote, debit the treasury, mark
 *      `launching` (so a second launch sees `wrong_status`);
 *   2. `launchCoin`;
 *   3. set `coinId`, `status = live`.
 * If step 2 fails the treasury is refunded and the project goes back to
 * `founded`.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  ConflictError,
  InsufficientCashError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { quoteLaunch, type MemberRole } from '../shared/domain/projects.js';
import type { PoolClient } from 'pg';
import { launchCoin } from './launchpad.js';
import { recordCareerAction } from './ladders.js';
import { publishWorldEvent } from './realtime-bus.js';
import {
  assertOwner,
  loadSummary,
  lockProject,
  type LockedProject,
  type ProjectSummary,
} from './projects.js';
import { projectsConfig, publishProjectEvent, recordProjectEvent } from './project-events.js';
import type { AppContext } from './context.js';

const RC = { isolation: 'read committed' } as const;
export const TICKER_RE = /^[A-Z0-9]{2,8}$/;

export interface LaunchQuote {
  readonly projectId: string;
  readonly launchCostCents: number;
  readonly builderDiscountBps: number;
  readonly treasuryCents: number;
  readonly canLaunch: boolean;
  readonly blockers: string[];
  readonly quotedAt: string;
}

async function quoteFor(
  ctx: AppContext,
  c: PoolClient,
  p: LockedProject,
  nowMs: number,
): Promise<ReturnType<typeof quoteLaunch>> {
  const r = await c.query<{ role: MemberRole }>(
    `SELECT role FROM project_members WHERE project_id = $1`,
    [p.projectId],
  );
  const t = await c.query<{ tribe_id: string | null }>(
    `SELECT tribe_id FROM characters WHERE user_id = $1`,
    [p.ownerUserId],
  );
  return quoteLaunch(projectsConfig(ctx), {
    kind: p.kind,
    status: p.status,
    treasuryCents: p.treasuryCents,
    roles: new Set(r.rows.map((x) => x.role)),
    createdAtMs: p.createdAt.getTime(),
    nowMs,
    founderTribeId: t.rows[0]?.tribe_id ?? null,
  });
}

/**
 * Founder only. A read: the row is locked only for the length of the read.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param projectId - The project.
 * @returns The quote.
 */
export async function getLaunchQuote(
  ctx: AppContext,
  userId: string,
  projectId: string,
): Promise<LaunchQuote> {
  const now = Date.now();
  return runInTransaction(async (c) => {
    const p = await lockProject(c, projectId);
    assertOwner(p, userId);
    const q = await quoteFor(ctx, c, p, now);
    return {
      projectId,
      launchCostCents: q.launchCostCents,
      builderDiscountBps: q.builderDiscountBps,
      treasuryCents: p.treasuryCents,
      canLaunch: q.canLaunch,
      blockers: q.blockers,
      quotedAt: new Date(now).toISOString(),
    };
  }, RC);
}

/**
 * Launch the project's token at the cost the player confirmed.
 * @param ctx - The application context.
 * @param userId - The caller (founder).
 * @param projectId - The project.
 * @param body - `ticker` (^[A-Z0-9]{2,8}$) and `quotedCostCents` from the quote.
 * @returns The project, `live` with `coinId`.
 */
export async function launchProject(
  ctx: AppContext,
  userId: string,
  projectId: string,
  body: { ticker: string; quotedCostCents: number },
): Promise<ProjectSummary> {
  const ticker = body.ticker.toUpperCase();
  if (!TICKER_RE.test(ticker)) throw new ValidationFailedError({ reason: 'bad_ticker' });
  const taken = await ctx.db.withConnection((c) =>
    c.query(`SELECT 1 FROM coins WHERE upper(ticker) = $1 LIMIT 1`, [ticker]),
  );
  if ((taken.rowCount ?? 0) > 0) throw new ConflictError({ reason: 'ticker_taken' });

  const now = Date.now();
  const { name, cost } = await runInTransaction(async (c) => {
    const p = await lockProject(c, projectId);
    assertOwner(p, userId);
    const q = await quoteFor(ctx, c, p, now);
    if (q.blockers.includes('wrong_status'))
      throw new ConflictError({ reason: 'wrong_status', status: p.status });
    if (q.launchCostCents !== body.quotedCostCents)
      throw new ConflictError({ reason: 'quote_changed', launchCostCents: q.launchCostCents });
    if (q.blockers.includes('no_dev_hired')) throw new ConflictError({ reason: 'no_dev_hired' });
    if (q.blockers.includes('cooldown')) {
      const ready =
        p.createdAt.getTime() + projectsConfig(ctx).launch.minProjectAgeMinutes * 60_000;
      throw new ConflictError({ reason: 'cooldown', retryAt: new Date(ready).toISOString() });
    }
    if (q.blockers.includes('insufficient_treasury'))
      throw new InsufficientCashError({ have: p.treasuryCents, need: q.launchCostCents });
    await c.query(
      `UPDATE projects SET cash_cents = cash_cents - $2, status = 'launching', ticker = $3
        WHERE project_id = $1`,
      [projectId, q.launchCostCents, ticker],
    );
    return { name: p.name, cost: q.launchCostCents };
  }, RC);

  let coinId: string;
  try {
    coinId = (await launchCoin(ctx, { userId, name: name.slice(0, 64), ticker })).coinId;
  } catch (e) {
    await runInTransaction(async (c) => {
      await c.query(
        `UPDATE projects SET cash_cents = cash_cents + $2, status = 'founded'
          WHERE project_id = $1 AND status = 'launching'`,
        [projectId, cost],
      );
    }, RC);
    const reason = (e as { details?: { reason?: string } }).details?.reason;
    if (e instanceof ValidationFailedError && reason === 'ticker already exists')
      throw new ConflictError({ reason: 'ticker_taken' });
    throw e;
  }

  const { summary, event } = await runInTransaction(async (c) => {
    await c.query(
      `UPDATE projects SET status = 'live', coin_id = $2, launched_at = $3
        WHERE project_id = $1 AND status = 'launching'`,
      [projectId, coinId, new Date(now)],
    );
    const ev = await recordProjectEvent(c, {
      projectId,
      eventId: 'proj_launched',
      cashDeltaCents: -cost,
      params: { coinId, ticker },
      at: new Date(now),
    });
    return { summary: (await loadSummary(c, projectId))!, event: ev };
  }, RC);
  await publishWorldEvent(ctx, 'evt_project_launch', { projectId, name, ticker, coinId });
  if (event) await publishProjectEvent(ctx, event);
  await recordCareerAction(ctx, userId, 'project_launch', projectId);
  return summary;
}
