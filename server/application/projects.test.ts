/**
 * Builder service tests against the real database.
 *
 * Covers: found (seed -> treasury, founder member, event), offers
 * (band, consent, one role per player, decline, expiry), fund (own Cash ->
 * own treasury only), fire/quit, launch quote and launch onto the in-game
 * launchpad, the weekly game-paid payroll with its matching operating cost,
 * and the daily risk roll. Asserts the economy rule: no path moves Cash from
 * one player to another.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  BlockedError,
  ConflictError,
  ForbiddenError,
  InsufficientCashError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { Rng } from '../shared/domain/rng.js';
import { foundProject, fundProject, getProject, removeMember } from './projects.js';
import {
  acceptOffer,
  createOffer,
  declineOffer,
  expireOffers,
  listMyProjectOffers,
} from './project-offers.js';
import { getLaunchQuote, launchProject } from './project-launch.js';
import { payProject, rollProjectRisk } from './project-payroll.js';
import { listProjectEvents } from './project-events.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

let founder: string;
let dev: string;
let mod: string;
let other: string;

async function cash(userId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT cash_cents AS c FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function treasury(projectId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT cash_cents AS c FROM projects WHERE project_id = $1`,
    [projectId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

/** Age a project past the launch cooldown. */
async function age(projectId: string): Promise<void> {
  await pool.query(
    `UPDATE projects SET created_at = now() - interval '2 hours' WHERE project_id = $1`,
    [projectId],
  );
}

function ticker(): string {
  return `T${uuidv7().replace(/-/g, '').slice(-6).toUpperCase()}`;
}

async function hire(
  projectId: string,
  userId: string,
  role: 'dev' | 'mod',
  cents: number,
): Promise<void> {
  const ctx = buildContext();
  const o = await createOffer(ctx, founder, projectId, { userId, role, salaryCentsPerWeek: cents });
  await acceptOffer(ctx, userId, o.offerId);
}

const always = (fire: boolean): Rng => ({
  int: () => 0,
  float: () => 0,
  chance: () => fire,
  pick: <T>(xs: readonly T[]) => xs[0] as T,
  weighted: <T>(xs: readonly T[]) => xs[0] as T,
  normal: () => 0,
});

beforeAll(async () => {
  [founder, dev, mod, other] = [uuidv7(), uuidv7(), uuidv7(), uuidv7()];
  for (const id of [founder, dev, mod, other]) {
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `projUser-${id}`]);
  }
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(`DELETE FROM project_members WHERE user_id = ANY($1::uuid[])`, [
    [dev, mod, other],
  ]);
  await pool.query(`DELETE FROM projects WHERE owner_user_id = $1`, [founder]);
  await pool.query(`DELETE FROM blocks WHERE blocker_user_id = ANY($1::uuid[])`, [
    [founder, other],
  ]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 10000000), ($2, 0), ($3, 0), ($4, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = EXCLUDED.cash_cents`,
    [founder, dev, mod, other],
  );
});

describe('found', () => {
  it('moves the seed into the treasury and makes the founder the first member', async () => {
    const ctx = buildContext();
    const before = await cash(founder);
    const p = await foundProject(ctx, founder, 'memecoin', 'Froge Labs');
    expect(p).toMatchObject({
      status: 'founded',
      name: 'Froge Labs',
      treasuryCents: 50_000,
      cashCents: 50_000,
      memberCount: 1,
      coinId: null,
      openRoles: ['dev', 'mod', 'kol', 'auditor'],
    });
    expect(await cash(founder)).toBe(before - 50_000);
    const d = await getProject(ctx, p.projectId);
    expect(d.members.map((m) => m.role)).toEqual(['founder']);
    expect(d.recentEvents[0]?.eventId).toBe('proj_founded');
  });

  it('refuses without the seed', async () => {
    await pool.query(`UPDATE balances SET cash_cents = 0 WHERE user_id = $1`, [founder]);
    await expect(foundProject(buildContext(), founder, 'l2')).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});

describe('offers', () => {
  it('needs consent, moves no Cash, and fills the role', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    const before = [await cash(founder), await cash(dev)];
    const o = await createOffer(ctx, founder, p.projectId, {
      userId: dev,
      role: 'dev',
      salaryCentsPerWeek: 20_000,
    });
    expect(o).toMatchObject({
      status: 'pending',
      role: 'dev',
      toUserId: dev,
      projectName: 'Memecoin',
    });
    expect((await getProject(ctx, p.projectId)).members).toHaveLength(1);
    const mine = await listMyProjectOffers(ctx, dev, 'pending', 10);
    expect(mine.map((x) => x.offerId)).toEqual([o.offerId]);
    const a = await acceptOffer(ctx, dev, o.offerId);
    expect(a.status).toBe('accepted');
    const d = await getProject(ctx, p.projectId);
    expect(d.members.map((m) => [m.role, m.salaryCentsPerWeek])).toEqual([
      ['founder', 0],
      ['dev', 20_000],
    ]);
    expect(d.project.openRoles).toEqual(['mod', 'kol', 'auditor']);
    expect([await cash(founder), await cash(dev)]).toEqual(before);
  });

  it('rejects a wage outside the band with the band', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    const err = await createOffer(ctx, founder, p.projectId, {
      userId: dev,
      role: 'dev',
      salaryCentsPerWeek: 999_999,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationFailedError);
    expect((err as ValidationFailedError).details).toMatchObject({
      reason: 'salary_out_of_band',
      min: 15_000,
      max: 30_000,
    });
  });

  it('only the founder offers; blocked, duplicate, member and filled-role offers are refused', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    await expect(
      createOffer(ctx, other, p.projectId, {
        userId: dev,
        role: 'dev',
        salaryCentsPerWeek: 20_000,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await createOffer(ctx, founder, p.projectId, {
      userId: dev,
      role: 'dev',
      salaryCentsPerWeek: 20_000,
    });
    await expect(
      createOffer(ctx, founder, p.projectId, {
        userId: dev,
        role: 'mod',
        salaryCentsPerWeek: 10_000,
      }),
    ).rejects.toMatchObject({ details: { reason: 'offer_pending' } });
    await pool.query(
      `INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2), ($2, $1)`,
      [other, founder],
    );
    await expect(
      createOffer(ctx, founder, p.projectId, {
        userId: other,
        role: 'mod',
        salaryCentsPerWeek: 10_000,
      }),
    ).rejects.toBeInstanceOf(BlockedError);
    await hire(p.projectId, mod, 'mod', 10_000);
    await expect(
      createOffer(ctx, founder, p.projectId, {
        userId: mod,
        role: 'kol',
        salaryCentsPerWeek: 10_000,
      }),
    ).rejects.toMatchObject({ details: { reason: 'already_member' } });
    await pool.query(`DELETE FROM blocks WHERE blocker_user_id = ANY($1::uuid[])`, [
      [founder, other],
    ]);
    await expect(
      createOffer(ctx, founder, p.projectId, {
        userId: other,
        role: 'mod',
        salaryCentsPerWeek: 10_000,
      }),
    ).rejects.toMatchObject({ details: { reason: 'role_filled' } });
  });

  it('a player holds one role across projects; only the invitee answers; decline and expiry', async () => {
    const ctx = buildContext();
    const a = await foundProject(ctx, founder, 'memecoin');
    const b = await foundProject(ctx, founder, 'memecoin');
    await hire(a.projectId, dev, 'dev', 20_000);
    const o = await createOffer(ctx, founder, b.projectId, {
      userId: dev,
      role: 'dev',
      salaryCentsPerWeek: 20_000,
    });
    await expect(acceptOffer(ctx, other, o.offerId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acceptOffer(ctx, dev, o.offerId)).rejects.toMatchObject({
      details: { reason: 'membership_limit' },
    });
    expect((await declineOffer(ctx, dev, o.offerId)).status).toBe('declined');
    await expect(declineOffer(ctx, dev, o.offerId)).rejects.toMatchObject({
      details: { reason: 'not_pending' },
    });
    const late = await createOffer(ctx, founder, b.projectId, {
      userId: mod,
      role: 'mod',
      salaryCentsPerWeek: 10_000,
    });
    await pool.query(
      `UPDATE project_offers SET expires_at = now() - interval '1 minute' WHERE offer_id = $1`,
      [late.offerId],
    );
    expect((await listMyProjectOffers(ctx, mod, 'expired', 10))[0]?.offerId).toBe(late.offerId);
    await expect(acceptOffer(ctx, mod, late.offerId)).rejects.toMatchObject({
      details: { reason: 'expired' },
    });
    expect(await expireOffers(ctx)).toBeGreaterThanOrEqual(1);
  });
});

describe('fund and members', () => {
  it('moves only the founder’s own Cash into the treasury, and resumes a paused project', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    await hire(p.projectId, dev, 'dev', 20_000);
    await expect(fundProject(ctx, dev, p.projectId, 1000)).rejects.toBeInstanceOf(ForbiddenError);
    const before = await cash(founder);
    await pool.query(`UPDATE projects SET status = 'paused' WHERE project_id = $1`, [p.projectId]);
    const out = await fundProject(ctx, founder, p.projectId, 12_345);
    expect(out.project.treasuryCents).toBe(50_000 + 12_345);
    expect(out.project.status).toBe('founded');
    expect(await cash(founder)).toBe(before - 12_345);
    expect(await cash(dev)).toBe(0);
    await pool.query(`UPDATE balances SET cash_cents = 10 WHERE user_id = $1`, [founder]);
    await expect(fundProject(ctx, founder, p.projectId, 11)).rejects.toBeInstanceOf(
      InsufficientCashError,
    );
    const ids = (await listProjectEvents(ctx, p.projectId, null, 10)).events.map((e) => e.eventId);
    expect(ids.slice(0, 2).sort()).toEqual(['proj_funded', 'proj_resumed']);
  });

  it('the founder fires, a member quits, the founder cannot be removed', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    await hire(p.projectId, dev, 'dev', 20_000);
    await hire(p.projectId, mod, 'mod', 10_000);
    await expect(removeMember(ctx, mod, p.projectId, dev)).rejects.toBeInstanceOf(ForbiddenError);
    await removeMember(ctx, founder, p.projectId, dev);
    await removeMember(ctx, mod, p.projectId, mod);
    await expect(removeMember(ctx, founder, p.projectId, founder)).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(removeMember(ctx, founder, p.projectId, other)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect((await getProject(ctx, p.projectId)).project.memberCount).toBe(1);
  });
});

describe('launch', () => {
  it('quotes blockers, then lists a coin on the in-game launchpad from the treasury', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    const q0 = await getLaunchQuote(ctx, founder, p.projectId);
    expect(q0.blockers.sort()).toEqual(['cooldown', 'no_dev_hired']);
    await expect(getLaunchQuote(ctx, dev, p.projectId)).rejects.toBeInstanceOf(ForbiddenError);
    await hire(p.projectId, dev, 'dev', 20_000);
    await age(p.projectId);
    const q = await getLaunchQuote(ctx, founder, p.projectId);
    expect(q).toMatchObject({
      canLaunch: true,
      blockers: [],
      launchCostCents: 50_000,
      treasuryCents: 50_000,
    });
    await expect(
      launchProject(ctx, founder, p.projectId, { ticker: ticker(), quotedCostCents: 1 }),
    ).rejects.toMatchObject({ details: { reason: 'quote_changed', launchCostCents: 50_000 } });
    const t = ticker();
    const live = await launchProject(ctx, founder, p.projectId, {
      ticker: t,
      quotedCostCents: 50_000,
    });
    expect(live.status).toBe('live');
    expect(live.coinId).toMatch(/^[0-9a-f-]{36}$/);
    expect(live.treasuryCents).toBe(0);
    const coin = await pool.query<{ ticker: string; stage: string }>(
      `SELECT ticker, stage FROM coins WHERE coin_id = $1`,
      [live.coinId],
    );
    expect(coin.rows[0]).toEqual({ ticker: t, stage: 'new' });
    await expect(
      launchProject(ctx, founder, p.projectId, { ticker: ticker(), quotedCostCents: 50_000 }),
    ).rejects.toMatchObject({ details: { reason: 'wrong_status' } });
  });

  it('refuses a taken ticker and an empty treasury', async () => {
    const ctx = buildContext();
    const a = await foundProject(ctx, founder, 'memecoin');
    await hire(a.projectId, dev, 'dev', 20_000);
    await age(a.projectId);
    const t = ticker();
    await launchProject(ctx, founder, a.projectId, { ticker: t, quotedCostCents: 50_000 });
    const b = await foundProject(ctx, founder, 'memecoin');
    await pool.query(`DELETE FROM project_members WHERE user_id = $1`, [dev]);
    await hire(b.projectId, dev, 'dev', 20_000);
    await age(b.projectId);
    await expect(
      launchProject(ctx, founder, b.projectId, { ticker: t, quotedCostCents: 50_000 }),
    ).rejects.toMatchObject({ details: { reason: 'ticker_taken' } });
    await pool.query(`UPDATE projects SET cash_cents = 100 WHERE project_id = $1`, [b.projectId]);
    await expect(
      launchProject(ctx, founder, b.projectId, { ticker: ticker(), quotedCostCents: 50_000 }),
    ).rejects.toBeInstanceOf(InsufficientCashError);
    expect(await treasury(b.projectId)).toBe(100);
  });
});

describe('weekly payroll', () => {
  // A week long past, so no other test's ledger rows fall inside it.
  const weekStart = Date.parse('2020-01-06T00:00:00Z');
  const runAt = new Date('2020-01-13T00:00:00Z');

  async function worked(userId: string): Promise<void> {
    await pool.query(
      `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref, created_at)
       VALUES ($1, 100, 'cash', 'shift_pay', 'shift', $2, $3, '2020-01-08T10:00:00Z')`,
      [userId, uuidv7(), `test-shift:${uuidv7()}`],
    );
  }

  it('the game pays members who worked; the treasury pays the matching operating cost; idempotent', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    await hire(p.projectId, dev, 'dev', 20_000);
    await hire(p.projectId, mod, 'mod', 10_000);
    await worked(dev); // mod did not work this week
    const founderBefore = await cash(founder);
    const r = await payProject(ctx, p.projectId, weekStart, runAt);
    expect(r).toEqual({ paused: false, wagesCents: 20_000 });
    expect(await cash(dev)).toBe(20_000);
    expect(await cash(mod)).toBe(0);
    expect(await cash(founder)).toBe(founderBefore); // the founder's wallet is untouched
    expect(await treasury(p.projectId)).toBe(50_000 - 20_000);
    expect(await payProject(ctx, p.projectId, weekStart, runAt)).toBeNull();
    expect(await cash(dev)).toBe(20_000);
  });

  it('pauses the project and pays nobody when the treasury cannot cover payroll', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'memecoin');
    await hire(p.projectId, dev, 'dev', 20_000);
    await worked(dev);
    await pool.query(`UPDATE projects SET cash_cents = 19999 WHERE project_id = $1`, [p.projectId]);
    expect(await payProject(ctx, p.projectId, weekStart, runAt)).toEqual({
      paused: true,
      wagesCents: 0,
    });
    expect(await cash(dev)).toBe(0);
    const d = await getProject(ctx, p.projectId);
    expect(d.project.status).toBe('paused');
    expect(d.nextPayrollAt).toBeNull();
    expect(d.recentEvents.map((e) => e.eventId)).toContain('proj_payroll_missed');
  });
});

describe('daily risk', () => {
  it('an exploit takes treasury and shocks the coin price; nothing fires on a quiet day', async () => {
    const ctx = buildContext();
    const p = await foundProject(ctx, founder, 'dex');
    await hire(p.projectId, dev, 'dev', 20_000);
    await age(p.projectId);
    const live = await launchProject(ctx, founder, p.projectId, {
      ticker: ticker(),
      quotedCostCents: 250_000,
    });
    await pool.query(`UPDATE projects SET cash_cents = 500000 WHERE project_id = $1`, [
      p.projectId,
    ]);
    const price0 = BigInt(
      (
        await pool.query<{ p: string }>(`SELECT price_micros AS p FROM coins WHERE coin_id = $1`, [
          live.coinId,
        ])
      ).rows[0]!.p,
    );
    expect(
      await rollProjectRisk(ctx, p.projectId, always(false), new Date('2026-11-05T12:00:00Z')),
    ).toBeNull();
    const e = await rollProjectRisk(
      ctx,
      p.projectId,
      always(true),
      new Date('2026-11-06T12:00:00Z'),
    );
    expect(e).toMatchObject({ eventId: 'proj_exploit', cashDeltaCents: -100_000 });
    expect(await treasury(p.projectId)).toBe(400_000);
    const price1 = BigInt(
      (
        await pool.query<{ p: string }>(`SELECT price_micros AS p FROM coins WHERE coin_id = $1`, [
          live.coinId,
        ])
      ).rows[0]!.p,
    );
    expect(price1).toBe((price0 * 7000n) / 10000n);
    // Same UTC day again: the dedupe key keeps it to one event.
    expect(
      await rollProjectRisk(ctx, p.projectId, always(true), new Date('2026-11-06T13:00:00Z')),
    ).toBeNull();
  });
});
