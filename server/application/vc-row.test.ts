/**
 * VC Row against the real database: term-sheet generation rules, accept
 * (treasury faucet, deal row, siblings expire), decline, founder-only, expiry,
 * the dump at unlock (price shock, deal dumped), the board, and `vcStakes`.
 * No VC Cash ever reaches a player's balance.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ForbiddenError } from '../shared/domain/errors.js';
import type { Rng } from '../shared/domain/rng.js';
import { foundProject, getProject } from './projects.js';
import { acceptOffer, createOffer } from './project-offers.js';
import { launchProject } from './project-launch.js';
import {
  acceptVcOffer,
  declineVcOffer,
  expireVcOffers,
  listVcDeals,
  listVcOffers,
  offerForProject,
  runVcUnlocks,
} from './vc-row.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let founder: string;
let dev: string;
let other: string;

const yes: Rng = {
  int: () => 10,
  float: () => 0,
  chance: () => true,
  pick: <T>(xs: readonly T[]) => xs[0] as T,
  weighted: <T>(xs: readonly T[]) => xs[0] as T,
  normal: () => 0,
};

async function liveProject(): Promise<{ projectId: string; coinId: string }> {
  const ctx = buildContext();
  const p = await foundProject(ctx, founder, 'memecoin');
  const o = await createOffer(ctx, founder, p.projectId, {
    userId: dev,
    role: 'dev',
    salaryCentsPerWeek: 20_000,
  });
  await acceptOffer(ctx, dev, o.offerId);
  await pool.query(
    `UPDATE projects SET created_at = now() - interval '3 days' WHERE project_id = $1`,
    [p.projectId],
  );
  const t = `V${uuidv7().replace(/-/g, '').slice(-6).toUpperCase()}`;
  const live = await launchProject(ctx, founder, p.projectId, {
    ticker: t,
    quotedCostCents: 50_000,
  });
  await pool.query(
    `UPDATE projects SET launched_at = now() - interval '2 days' WHERE project_id = $1`,
    [p.projectId],
  );
  return { projectId: p.projectId, coinId: live.coinId! };
}

async function treasury(projectId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT cash_cents AS c FROM projects WHERE project_id = $1`,
    [projectId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function price(coinId: string): Promise<bigint> {
  const r = await pool.query<{ p: string }>(
    `SELECT price_micros AS p FROM coins WHERE coin_id = $1`,
    [coinId],
  );
  return BigInt(r.rows[0]!.p);
}

beforeAll(async () => {
  [founder, dev, other] = [uuidv7(), uuidv7(), uuidv7()];
  for (const id of [founder, dev, other]) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `vcUser-${id}`]);
  }
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM projects WHERE owner_user_id = $1`, [founder]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 10000000), ($2, 0), ($3, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents`,
    [founder, dev, other],
  );
});

describe('term sheets', () => {
  it('a qualifying live project gets one; a pending one blocks another; founded projects get none', async () => {
    const ctx = buildContext();
    const { projectId } = await liveProject();
    const now = new Date();
    const o = await offerForProject(ctx, projectId, yes, now);
    expect(o).toMatchObject({ projectId, vcArchetypeId: 'vc', status: 'pending', equityBps: 1300 });
    expect(o!.investCents).toBeGreaterThan(0);
    expect(await offerForProject(ctx, projectId, yes, now)).toBeNull();
    const founded = await foundProject(ctx, founder, 'memecoin');
    expect(await offerForProject(ctx, founded.projectId, yes, now)).toBeNull();
  });

  it('accept: treasury faucet, active deal, siblings expire, nothing paid to a player', async () => {
    const ctx = buildContext();
    const { projectId } = await liveProject();
    const o = (await offerForProject(ctx, projectId, yes, new Date()))!;
    const before = await treasury(projectId);
    const balances0 = await pool.query(
      `SELECT user_id, cash_cents FROM balances WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`,
      [[founder, dev, other]],
    );
    await expect(acceptVcOffer(ctx, dev, o.offerId)).rejects.toBeInstanceOf(ForbiddenError);
    const a = await acceptVcOffer(ctx, founder, o.offerId);
    expect(a.status).toBe('accepted');
    expect(await treasury(projectId)).toBe(before + o.investCents);
    const balances1 = await pool.query(
      `SELECT user_id, cash_cents FROM balances WHERE user_id = ANY($1::uuid[]) ORDER BY user_id`,
      [[founder, dev, other]],
    );
    expect(balances1.rows).toEqual(balances0.rows);
    const d = await getProject(ctx, projectId);
    expect(d.vcStakes).toEqual([
      {
        vcArchetypeId: 'vc',
        equityBps: o.equityBps,
        investedCents: o.investCents,
        unlockAt: a.unlockAt,
      },
    ]);
    expect(d.recentEvents[0]).toMatchObject({
      eventId: 'proj_vc_invested',
      cashDeltaCents: o.investCents,
    });
    await expect(acceptVcOffer(ctx, founder, o.offerId)).rejects.toMatchObject({
      details: { reason: 'not_pending' },
    });
    const board = await listVcDeals(ctx, null, 50);
    expect(board.deals.find((x) => x.projectId === projectId)).toMatchObject({
      status: 'active',
      investCents: o.investCents,
    });
  });

  it('decline, expiry, founder-only listing', async () => {
    const ctx = buildContext();
    const { projectId } = await liveProject();
    const o = (await offerForProject(ctx, projectId, yes, new Date()))!;
    await expect(listVcOffers(ctx, other, projectId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await declineVcOffer(ctx, founder, o.offerId)).status).toBe('declined');
    const late = await offerForProject(ctx, projectId, yes, new Date());
    expect(late).not.toBeNull();
    // Past its 24 h TTL.
    await pool.query(
      `UPDATE vc_offers SET expires_at = now() - interval '1 minute' WHERE offer_id = $1`,
      [late!.offerId],
    );
    await expect(acceptVcOffer(ctx, founder, late!.offerId)).rejects.toMatchObject({
      details: { reason: 'expired' },
    });
    expect(
      (await listVcOffers(ctx, founder, projectId)).offers.map((x) => x.status).sort(),
    ).toEqual(['declined', 'expired']);
    expect(await expireVcOffers(ctx)).toBeGreaterThanOrEqual(1);
  });
});

describe('unlock', () => {
  it('at unlockAt the VC dumps: price shock by stake, deal dumped, once', async () => {
    const ctx = buildContext();
    const { projectId, coinId } = await liveProject();
    const o = (await offerForProject(ctx, projectId, yes, new Date()))!;
    await acceptVcOffer(ctx, founder, o.offerId);
    expect(await runVcUnlocks(ctx, yes, new Date())).toBe(0); // not yet
    const p0 = await price(coinId);
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await runVcUnlocks(ctx, yes, later)).toBeGreaterThanOrEqual(1);
    const shock = -Math.min(3000, Math.floor((o.equityBps * 15_000) / 10_000));
    expect(await price(coinId)).toBe((p0 * BigInt(10_000 + shock)) / 10_000n);
    const d = await getProject(ctx, projectId);
    expect(d.vcStakes).toEqual([]);
    expect(d.recentEvents[0]).toMatchObject({ eventId: 'proj_vc_dump' });
    const board = await listVcDeals(ctx, null, 50);
    expect(board.deals.find((x) => x.projectId === projectId)?.status).toBe('dumped');
    const again = await price(coinId);
    await runVcUnlocks(ctx, yes, later);
    expect(await price(coinId)).toBe(again);
  });
});
