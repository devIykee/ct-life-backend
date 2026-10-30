/**
 * VC Row (Builder, unlock WP-B B2).
 *
 *   GET  /v1/projects/{id}/vc-offers     founder's term sheets
 *   POST /v1/vc-offers/{offerId}/accept  take the money (treasury += invest)
 *   POST /v1/vc-offers/{offerId}/decline
 *   GET  /v1/vc-row/deals?cursor          the VC Row board
 *
 * Worker side (server/workers/projects.ts): a daily generator gives live
 * projects under the treasury threshold 1-3 term sheets a week (`vc_offer`
 * to the founder), and an hourly unlock pass dumps each deal at `unlockAt`
 * (launchpad price shock, `proj_vc_dump`, world event `evt_vc_dump`).
 *
 * Economy: VC money is an NPC faucet into the project TREASURY. The treasury
 * is never withdrawable and only feeds sinks (and B1 wages never depend on
 * it), so no VC Cash ever reaches a player. Equity is flavour: it buys no
 * control and pays nothing out.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import { ConflictError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import type { Rng } from '../shared/domain/rng.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  dumpStepBps,
  publicUnlockAt,
  rollVcTerms,
  scheduleDumpStart,
  shouldOffer,
  vcDumpShockBps,
  type VcConfig,
} from '../shared/domain/vc.js';
import { SeededRng } from '../shared/domain/rng.js';
import { randomInt } from 'node:crypto';
import { publishToUser, publishWorldEvent } from './realtime-bus.js';
import { assertOwner, lockProject } from './projects.js';
import { projectsConfig, publishProjectEvent, recordProjectEvent } from './project-events.js';
import type { AppContext } from './context.js';

const RC = { isolation: 'read committed' } as const;
const UUID = /^[0-9a-f-]{36}$/i;
const DAY_MS = 86_400_000;

/** `VcOffer` in the contract. */
export interface VcOffer {
  readonly offerId: string;
  readonly projectId: string;
  readonly vcArchetypeId: string;
  readonly investCents: number;
  readonly equityBps: number;
  /** For a pending offer: when the stake would unlock if accepted now. */
  readonly unlockAt: string;
  readonly status: 'pending' | 'accepted' | 'declined' | 'expired';
  readonly expiresAt: string;
}

/** `VcDeal` in the contract. */
export interface VcDeal {
  readonly projectId: string;
  readonly projectName: string;
  readonly vcArchetypeId: string;
  readonly investCents: number;
  readonly equityBps: number;
  readonly status: 'active' | 'unlocked' | 'dumped';
  readonly at: string;
}

interface OfferDbRow {
  offer_id: string;
  project_id: string;
  vc_archetype_id: string;
  invest_cents: string;
  equity_bps: number;
  unlock_days: number;
  status: VcOffer['status'];
  expires_at: Date;
  created_at: Date;
  deal_unlock_at: Date | null;
}

const OFFER_SELECT = `
  SELECT o.offer_id, o.project_id, o.vc_archetype_id, o.invest_cents, o.equity_bps, o.unlock_days,
         o.status, o.expires_at, o.created_at, d.unlock_at AS deal_unlock_at
    FROM vc_offers o
    LEFT JOIN vc_deals d ON d.offer_id = o.offer_id`;

function vcConfig(ctx: AppContext): VcConfig {
  return projectsConfig(ctx).vc;
}

function toOffer(r: OfferDbRow, nowMs: number): VcOffer {
  const expired = r.status === 'pending' && r.expires_at.getTime() <= nowMs;
  // Only the unlock DAY is ever sent (security review H2).
  const unlock = new Date(
    publicUnlockAt((r.deal_unlock_at ?? new Date(nowMs + r.unlock_days * DAY_MS)).getTime()),
  );
  return {
    offerId: r.offer_id,
    projectId: r.project_id,
    vcArchetypeId: r.vc_archetype_id,
    investCents: Number(r.invest_cents),
    equityBps: r.equity_bps,
    unlockAt: unlock.toISOString(),
    status: expired ? 'expired' : r.status,
    expiresAt: r.expires_at.toISOString(),
  };
}

/**
 * The founder's term sheets for a project, newest first.
 * @param ctx - The application context.
 * @param userId - The caller (founder).
 * @param projectId - The project.
 * @returns `{offers}`.
 */
export async function listVcOffers(
  _ctx: AppContext,
  userId: string,
  projectId: string,
): Promise<{ offers: VcOffer[] }> {
  const now = Date.now();
  return runInTransaction(async (c) => {
    const p = await lockProject(c, projectId);
    assertOwner(p, userId);
    const r = await c.query<OfferDbRow>(
      `${OFFER_SELECT} WHERE o.project_id = $1 ORDER BY o.created_at DESC LIMIT 20`,
      [projectId],
    );
    return { offers: r.rows.map((x) => toOffer(x, now)) };
  }, RC);
}

async function lockOfferForFounder(
  c: PoolClient,
  userId: string,
  offerId: string,
  nowMs: number,
): Promise<{ offer: OfferDbRow; project: Awaited<ReturnType<typeof lockProject>> }> {
  if (!UUID.test(offerId)) throw new NotFoundError({ kind: 'vc_offer' });
  const pre = await c.query<{ project_id: string }>(
    `SELECT project_id FROM vc_offers WHERE offer_id = $1`,
    [offerId],
  );
  if (!pre.rows[0]) throw new NotFoundError({ kind: 'vc_offer' });
  // Lock order everywhere: project, then offer.
  const project = await lockProject(c, pre.rows[0].project_id);
  assertOwner(project, userId);
  const r = await c.query<OfferDbRow>(`${OFFER_SELECT} WHERE o.offer_id = $1 FOR UPDATE OF o`, [
    offerId,
  ]);
  const offer = r.rows[0]!;
  if (offer.status !== 'pending')
    throw new ConflictError({ reason: 'not_pending', status: offer.status });
  if (offer.expires_at.getTime() <= nowMs) throw new ConflictError({ reason: 'expired' });
  return { offer, project };
}

/**
 * Take the VC money: treasury += investCents (NPC faucet into the treasury),
 * a `vc_deals` row that unlocks in `unlockDays`. Other open offers expire.
 * @param ctx - The application context.
 * @param userId - The caller (founder).
 * @param offerId - The offer.
 * @returns The offer, `accepted`.
 */
export async function acceptVcOffer(
  ctx: AppContext,
  userId: string,
  offerId: string,
  rng: Rng = new SeededRng(randomInt(0, 2 ** 31)),
): Promise<VcOffer> {
  const now = new Date();
  const cfg = vcConfig(ctx);
  const { offer, event } = await runInTransaction(async (c) => {
    const { offer: o, project } = await lockOfferForFounder(c, userId, offerId, now.getTime());
    if (project.status !== 'live' || project.coinId === null)
      throw new ConflictError({ reason: 'wrong_status', status: project.status });
    const unlockAt = new Date(now.getTime() + o.unlock_days * DAY_MS);
    // Hidden: when the VC really starts selling (never sent to clients).
    const dumpStartAt = new Date(scheduleDumpStart(cfg, unlockAt.getTime(), rng));
    await c.query(`UPDATE vc_offers SET status = 'accepted' WHERE offer_id = $1`, [offerId]);
    await c.query(
      `UPDATE vc_offers SET status = 'expired'
        WHERE project_id = $1 AND status = 'pending' AND offer_id <> $2`,
      [o.project_id, offerId],
    );
    await c.query(`UPDATE projects SET cash_cents = cash_cents + $2 WHERE project_id = $1`, [
      o.project_id,
      Number(o.invest_cents),
    ]);
    await c.query(
      `INSERT INTO vc_deals (deal_id, project_id, vc_archetype_id, invest_cents, equity_bps, status, offer_id, unlock_at, created_at, dump_start_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9)`,
      [
        uuidv7(),
        o.project_id,
        o.vc_archetype_id,
        o.invest_cents,
        o.equity_bps,
        offerId,
        unlockAt,
        now,
        dumpStartAt,
      ],
    );
    const ev = await recordProjectEvent(c, {
      projectId: o.project_id,
      eventId: 'proj_vc_invested',
      cashDeltaCents: Number(o.invest_cents),
      params: {
        vcArchetypeId: o.vc_archetype_id,
        equityBps: String(o.equity_bps),
        unlockOn: new Date(publicUnlockAt(unlockAt.getTime())).toISOString().slice(0, 10),
      },
      at: now,
    });
    return {
      offer: toOffer({ ...o, status: 'accepted', deal_unlock_at: unlockAt }, now.getTime()),
      event: ev,
    };
  }, RC);
  if (event) await publishProjectEvent(ctx, event);
  return offer;
}

/**
 * Turn the VC down.
 * @param ctx - The application context.
 * @param userId - The caller (founder).
 * @param offerId - The offer.
 * @returns The offer, `declined`.
 */
export async function declineVcOffer(
  _ctx: AppContext,
  userId: string,
  offerId: string,
): Promise<VcOffer> {
  const now = new Date();
  return runInTransaction(async (c) => {
    const { offer } = await lockOfferForFounder(c, userId, offerId, now.getTime());
    await c.query(`UPDATE vc_offers SET status = 'declined' WHERE offer_id = $1`, [offerId]);
    return toOffer({ ...offer, status: 'declined' }, now.getTime());
  }, RC);
}

function boardStatus(s: string): VcDeal['status'] {
  if (s === 'active' || s === 'unlocked' || s === 'dumped') return s;
  return s === 'written_off' ? 'dumped' : 'unlocked';
}

/**
 * The VC Row board: recent deals, newest first, keyset-paged on deal id.
 * @param ctx - The application context.
 * @param cursor - The last `dealId` of the previous page (opaque), or null.
 * @param limit - Page size.
 * @returns Deals and the next cursor.
 */
export async function listVcDeals(
  ctx: AppContext,
  cursor: string | null,
  limit: number,
): Promise<{ deals: VcDeal[]; nextCursor: string | null }> {
  if (cursor !== null && !UUID.test(cursor))
    throw new ValidationFailedError({ reason: 'bad_cursor' });
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      deal_id: string;
      project_id: string;
      project_name: string | null;
      vc_archetype_id: string;
      invest_cents: string;
      equity_bps: number;
      status: string;
      created_at: Date;
    }>(
      `SELECT d.deal_id, d.project_id, p.name AS project_name, d.vc_archetype_id,
              d.invest_cents, d.equity_bps, d.status, d.created_at
         FROM vc_deals d
         JOIN projects p ON p.project_id = d.project_id
        WHERE $1::uuid IS NULL
           OR (d.created_at, d.deal_id) < (SELECT created_at, deal_id FROM vc_deals WHERE deal_id = $1::uuid)
        ORDER BY d.created_at DESC, d.deal_id DESC
        LIMIT $2`,
      [cursor, limit + 1],
    ),
  );
  const rows = r.rows.slice(0, limit);
  return {
    deals: rows.map((row) => ({
      projectId: row.project_id,
      projectName: row.project_name ?? 'Project',
      vcArchetypeId: row.vc_archetype_id,
      investCents: Number(row.invest_cents),
      equityBps: row.equity_bps,
      status: boardStatus(row.status),
      at: row.created_at.toISOString(),
    })),
    nextCursor: r.rows.length > limit ? (rows[rows.length - 1]?.deal_id ?? null) : null,
  };
}

/**
 * Daily: term sheets for live projects that qualify (shouldOffer). One
 * decision per project per UTC day (a Redis claim).
 * @param ctx - The application context.
 * @param rng - Injected randomness.
 * @param now - The run time.
 * @returns How many offers were made.
 */
export async function generateVcOffers(
  ctx: AppContext,
  rng: Rng,
  now: Date = new Date(),
): Promise<number> {
  const live = await ctx.db.withConnection((c) =>
    c.query<{ project_id: string }>(
      `SELECT project_id FROM projects WHERE status = 'live' AND coin_id IS NOT NULL ORDER BY project_id`,
    ),
  );
  let made = 0;
  const day = now.toISOString().slice(0, 10);
  for (const { project_id: projectId } of live.rows) {
    try {
      const claimed = await ctx.redis.main.set(
        `projects:vc:${day}:${projectId}`,
        '1',
        'EX',
        172_800,
        'NX',
      );
      if (claimed !== 'OK') continue;
      if (await offerForProject(ctx, projectId, rng, now)) made++;
    } catch (e) {
      console.error(`[projects] vc offer ${projectId} failed:`, (e as Error).message);
    }
  }
  return made;
}

/**
 * Decide and maybe write one term sheet (exported for tests).
 * @param ctx - The application context.
 * @param projectId - A live project.
 * @param rng - Injected randomness.
 * @param now - The decision time.
 * @returns The offer, or null.
 */
export async function offerForProject(
  ctx: AppContext,
  projectId: string,
  rng: Rng,
  now: Date,
): Promise<VcOffer | null> {
  const cfg = vcConfig(ctx);
  const res = await runInTransaction(async (c) => {
    const p = await lockProject(c, projectId);
    if (p.status !== 'live' || p.coinId === null) return null;
    const facts = await c.query<{
      launched_at: Date | null;
      mcap_cents: string | null;
      pending: boolean;
      week: number;
      last_at: Date | null;
    }>(
      `SELECT p.launched_at, co.mcap_cents,
              EXISTS (SELECT 1 FROM vc_offers o WHERE o.project_id = p.project_id
                        AND o.status = 'pending' AND o.expires_at > $2) AS pending,
              (SELECT COUNT(*)::int FROM vc_offers o WHERE o.project_id = p.project_id
                        AND o.created_at > $2::timestamptz - interval '7 days') AS week,
              (SELECT MAX(o.created_at) FROM vc_offers o WHERE o.project_id = p.project_id) AS last_at
         FROM projects p LEFT JOIN coins co ON co.coin_id = p.coin_id
        WHERE p.project_id = $1`,
      [projectId, now],
    );
    const f = facts.rows[0]!;
    const go = shouldOffer(
      cfg,
      {
        treasuryCents: p.treasuryCents,
        liveSinceMs: (f.launched_at ?? p.createdAt).getTime(),
        nowMs: now.getTime(),
        hasPendingOffer: f.pending,
        offersLast7d: f.week,
        lastOfferAtMs: f.last_at?.getTime() ?? null,
      },
      rng,
    );
    if (!go) return null;
    const terms = rollVcTerms(cfg, Number(f.mcap_cents ?? 0), rng);
    if (!terms) return null;
    // Retire a stale pending row (past expiry) so the one-pending index holds.
    await c.query(
      `UPDATE vc_offers SET status = 'expired' WHERE project_id = $1 AND status = 'pending' AND expires_at <= $2`,
      [projectId, now],
    );
    const offerId = uuidv7();
    const expiresAt = new Date(now.getTime() + cfg.offerTtlHours * 3_600_000);
    await c.query(
      `INSERT INTO vc_offers (offer_id, project_id, vc_archetype_id, invest_cents, equity_bps, unlock_days, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [
        offerId,
        projectId,
        terms.vcArchetypeId,
        terms.investCents,
        terms.equityBps,
        cfg.unlockDays,
        expiresAt,
        now,
      ],
    );
    const offer: VcOffer = {
      offerId,
      projectId,
      vcArchetypeId: terms.vcArchetypeId,
      investCents: terms.investCents,
      equityBps: terms.equityBps,
      unlockAt: new Date(publicUnlockAt(now.getTime() + cfg.unlockDays * DAY_MS)).toISOString(),
      status: 'pending',
      expiresAt: expiresAt.toISOString(),
    };
    return { offer, founder: p.ownerUserId };
  }, RC);
  if (!res) return null;
  await publishToUser(ctx, res.founder, 'vc_offer', { ...res.offer });
  return res.offer;
}

/**
 * Every 5 minutes. Built so the dump cannot be front-run (security review
 * H2): players only ever see the unlock DAY, and
 *   1. at `unlock_at` a deal turns `unlocked` and decides whether the VC dumps
 *      (`dumpChanceBps`) and by how much (1.5x the stake, capped);
 *   2. from a hidden random `dump_start_at` (0 to `dumpWindowHours` after
 *      unlock) the sell bleeds out in `dumpSteps` equal multiplicative steps
 *      (about -1% each, smaller than one market tick's noise), one step at a
 *      random run (`dumpStepChanceBps`), all remaining steps by
 *      `maxBleedHours` after the start;
 *   3. only when the last step lands: status `dumped`, `proj_vc_dump`, world
 *      event `evt_vc_dump`.
 * New perps on the coin are refused from `perpFreezeLeadHours` before unlock
 * until the bleed ends (`vcDumpFreezesPerps`, called by openPerp).
 * @param ctx - The application context.
 * @param rng - Injected randomness.
 * @param now - The run time.
 * @returns How many deals finished dumping on this run.
 */
export async function runVcUnlocks(
  ctx: AppContext,
  rng: Rng,
  now: Date = new Date(),
): Promise<number> {
  const cfg = vcConfig(ctx);
  const due = await ctx.db.withConnection((c) =>
    c.query<{ deal_id: string; project_id: string }>(
      `SELECT deal_id, project_id FROM vc_deals
        WHERE (status = 'active' AND unlock_at <= $1)
           OR (status = 'unlocked' AND dump_steps_done < dump_steps AND dump_start_at <= $1)
        ORDER BY unlock_at`,
      [now],
    ),
  );
  let finished = 0;
  for (const d of due.rows) {
    try {
      const res = await runInTransaction(async (c) => {
        const p = await lockProject(c, d.project_id);
        const r = await c.query<{
          status: string;
          equity_bps: number;
          vc_archetype_id: string;
          dump_start_at: Date | null;
          dump_shock_bps: number;
          dump_steps: number;
          dump_steps_done: number;
        }>(
          `SELECT status, equity_bps, vc_archetype_id, dump_start_at, dump_shock_bps, dump_steps, dump_steps_done
             FROM vc_deals WHERE deal_id = $1 FOR UPDATE`,
          [d.deal_id],
        );
        const deal = r.rows[0];
        if (!deal) return null;
        if (deal.status === 'active') {
          const dump = rng.chance(cfg.dumpChanceBps / 10_000);
          const shock = dump ? vcDumpShockBps(cfg, deal.equity_bps) : 0;
          await c.query(
            `UPDATE vc_deals SET status = 'unlocked', dump_shock_bps = $2, dump_steps = $3,
                    dump_start_at = COALESCE(dump_start_at, $4)
              WHERE deal_id = $1`,
            [d.deal_id, shock, shock !== 0 ? cfg.dumpSteps : 0, now],
          );
          if (shock !== 0) return null; // the bleed starts later, unannounced
          const ev = await recordProjectEvent(c, {
            projectId: d.project_id,
            eventId: 'proj_vc_unlocked',
            params: { vcArchetypeId: deal.vc_archetype_id, equityBps: String(deal.equity_bps) },
            at: now,
            dedupeKey: `vc-unlock:${d.deal_id}`,
          });
          return { ev, dumped: false, name: p.name, coinId: p.coinId };
        }
        if (deal.status !== 'unlocked' || deal.dump_steps_done >= deal.dump_steps) return null;
        const start = (deal.dump_start_at ?? now).getTime();
        const overdue = now.getTime() >= start + cfg.maxBleedHours * 3_600_000;
        const steps = overdue
          ? deal.dump_steps - deal.dump_steps_done
          : rng.chance(cfg.dumpStepChanceBps / 10_000)
            ? 1
            : 0;
        if (steps === 0) return null;
        const per = dumpStepBps(deal.dump_shock_bps, deal.dump_steps);
        if (p.coinId !== null && per !== 0) {
          for (let i = 0; i < steps; i++) {
            await c.query(
              `UPDATE coins SET price_micros = GREATEST(1, price_micros * (10000 + $2::bigint) / 10000)
                WHERE coin_id = $1 AND stage <> 'dead'`,
              [p.coinId, per],
            );
          }
        }
        const done = deal.dump_steps_done + steps;
        const last = done >= deal.dump_steps;
        await c.query(
          `UPDATE vc_deals SET dump_steps_done = $2,
                  status = CASE WHEN $3::boolean THEN 'dumped' ELSE status END,
                  dumped_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE dumped_at END
            WHERE deal_id = $1`,
          [d.deal_id, done, last, now],
        );
        if (!last) return null;
        const ev = await recordProjectEvent(c, {
          projectId: d.project_id,
          eventId: 'proj_vc_dump',
          params: {
            vcArchetypeId: deal.vc_archetype_id,
            equityBps: String(deal.equity_bps),
            priceShockBps: String(deal.dump_shock_bps),
          },
          at: now,
          dedupeKey: `vc-dump:${d.deal_id}`,
        });
        return { ev, dumped: true, name: p.name, coinId: p.coinId };
      }, RC);
      if (!res) continue;
      if (res.ev) await publishProjectEvent(ctx, res.ev);
      if (res.dumped) {
        finished++;
        await publishWorldEvent(ctx, 'evt_vc_dump', {
          projectId: d.project_id,
          name: res.name,
          coinId: res.coinId ?? '',
        });
      }
    } catch (e) {
      console.error(`[projects] vc unlock ${d.deal_id} failed:`, (e as Error).message);
    }
  }
  return finished;
}

/**
 * Whether new perps on this coin are frozen: a VC deal on its project is
 * within `perpFreezeLeadHours` of unlock, or unlocked and still bleeding.
 * Called by openPerp so nobody can open a short into a scheduled dump.
 * @param c - A connection or transaction.
 * @param coinId - The coin.
 * @param now - The current time.
 * @param leadHours - projects.json `vc.perpFreezeLeadHours`.
 * @returns True when perp entry is frozen.
 */
export async function vcDumpFreezesPerps(
  c: PoolClient,
  coinId: string,
  now: Date,
  leadHours: number,
): Promise<boolean> {
  const r = await c.query(
    `SELECT 1 FROM vc_deals d JOIN projects p ON p.project_id = d.project_id
      WHERE p.coin_id = $1
        AND ((d.status = 'active' AND d.unlock_at - make_interval(hours => $3) <= $2)
          OR (d.status = 'unlocked' AND d.dump_steps_done < d.dump_steps))
      LIMIT 1`,
    [coinId, now, leadHours],
  );
  return (r.rowCount ?? 0) > 0;
}

/** @returns projects.json `vc.perpFreezeLeadHours`. */
export function perpFreezeLeadHours(ctx: AppContext): number {
  return vcConfig(ctx).perpFreezeLeadHours;
}

/**
 * Worker sweep: pending term sheets past expiry -> expired.
 * @param ctx - The application context.
 * @param now - The current time.
 * @returns How many expired.
 */
export async function expireVcOffers(ctx: AppContext, now: Date = new Date()): Promise<number> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE vc_offers SET status = 'expired' WHERE status = 'pending' AND expires_at <= $1`,
      [now],
    ),
  );
  return r.rowCount ?? 0;
}
