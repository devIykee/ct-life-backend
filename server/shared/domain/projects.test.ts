import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  nextPayrollAt,
  payableWage,
  planPayroll,
  proratedWage,
  quoteLaunch,
  rollRisk,
  salaryOutOfBand,
  shockPrice,
  weekStartUtc,
  type MemberRole,
  type ProjectsConfig,
} from './projects.js';
import type { Rng } from './rng.js';

const cfg = JSON.parse(readFileSync('contract/config/projects.json', 'utf8')) as ProjectsConfig;

/** An Rng whose chance() answers from a fixed list (true = fire). */
function scripted(answers: boolean[]): Rng {
  let i = 0;
  return {
    int: () => 0,
    float: () => 0,
    chance: () => answers[i++] ?? false,
    pick: <T>(xs: readonly T[]) => xs[0] as T,
    weighted: <T>(xs: readonly T[]) => xs[0] as T,
    normal: () => 0,
  };
}

describe('projects config (inflation-safe defaults)', () => {
  it('bands are sane, op cost >= wages, one paid role, caps nest', () => {
    for (const role of ['dev', 'mod', 'kol', 'auditor'] as const) {
      const b = cfg.wages[role];
      expect(b.minCentsPerWeek).toBeGreaterThan(0);
      expect(b.minCentsPerWeek).toBeLessThanOrEqual(b.maxCentsPerWeek);
    }
    expect(cfg.payroll.operatingCostBps).toBeGreaterThanOrEqual(10_000);
    expect(cfg.membership.maxRolesPerPlayer).toBe(1);
    expect(cfg.payroll.maxWagesCentsPerProjectWeek).toBeLessThanOrEqual(
      cfg.payroll.maxWagesCentsPerFounderWeek,
    );
  });

  it('no risk event can add Cash to a treasury', () => {
    for (const e of cfg.risk.events) expect(e.treasuryDeltaBps).toBeLessThanOrEqual(0);
  });
});

describe('wage bands', () => {
  it('accepts a wage inside the band and returns the band otherwise', () => {
    expect(salaryOutOfBand(cfg, 'dev', 20_000)).toBeNull();
    expect(salaryOutOfBand(cfg, 'dev', 14_999)).toEqual(cfg.wages.dev);
    expect(salaryOutOfBand(cfg, 'mod', 15_001)).toEqual(cfg.wages.mod);
    expect(salaryOutOfBand(cfg, 'kol', 1.5)).toEqual(cfg.wages.kol);
  });

  it('pays the founder nothing and clamps a stored wage into the current band', () => {
    expect(payableWage(cfg, 'founder', 99_999)).toBe(0);
    expect(payableWage(cfg, 'dev', 1_000_000)).toBe(cfg.wages.dev.maxCentsPerWeek);
    expect(payableWage(cfg, 'mod', 1)).toBe(cfg.wages.mod.minCentsPerWeek);
  });
});

describe('payroll weeks (UTC)', () => {
  it('weeks start Monday 00:00 UTC; payroll is the next Monday', () => {
    const wed = Date.parse('2026-11-04T15:30:00Z');
    expect(new Date(weekStartUtc(wed)).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(new Date(nextPayrollAt(wed)).toISOString()).toBe('2026-11-09T00:00:00.000Z');
    const sun = Date.parse('2026-11-08T23:59:59Z');
    expect(new Date(weekStartUtc(sun)).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    const mon = Date.parse('2026-11-09T00:00:00Z');
    expect(new Date(weekStartUtc(mon)).toISOString()).toBe('2026-11-09T00:00:00.000Z');
  });
});

describe('planPayroll', () => {
  const week = Date.parse('2026-11-02T00:00:00Z');
  const before = week - 86_400_000;
  const m = (
    userId: string,
    role: MemberRole,
    cents: number,
    over: Partial<{ worked: boolean; joinedAtMs: number; paidRoleEligible: boolean }> = {},
  ) => ({
    userId,
    role,
    salaryCentsPerWeek: cents,
    worked: true,
    joinedAtMs: before,
    paidRoleEligible: true,
    ...over,
  });

  it('pays only members who worked for this project, never the founder, with a matching operating cost', () => {
    const p = planPayroll(
      cfg,
      [m('f', 'founder', 0), m('d', 'dev', 20_000), m('x', 'mod', 10_000, { worked: false })],
      week,
      Number.MAX_SAFE_INTEGER,
    );
    expect(p.wages).toEqual([{ userId: 'd', cents: 20_000 }]);
    expect(p.operatingCostCents).toBe(20_000);
  });

  it('takes no treasury input at all: wages cannot depend on founder deposits', () => {
    expect(planPayroll.length).toBe(4);
    const a = planPayroll(cfg, [m('d', 'dev', 20_000)], week, 1e9);
    const b = planPayroll(cfg, [m('d', 'dev', 20_000)], week, 1e9);
    expect(a).toEqual(b);
  });

  it('prorates a mid-week join and pays nothing for a join after the week', () => {
    const midweek = week + 3.5 * 86_400_000;
    expect(proratedWage(20_000, midweek, week)).toBe(10_000);
    expect(proratedWage(20_000, before, week)).toBe(20_000);
    expect(proratedWage(20_000, week + 7 * 86_400_000, week)).toBe(0);
    const p = planPayroll(cfg, [m('d', 'dev', 20_000, { joinedAtMs: midweek })], week, 1e9);
    expect(p.wages).toEqual([{ userId: 'd', cents: 10_000 }]);
  });

  it('skips a second paid role and caps per project and per founder', () => {
    const team = [
      m('d', 'dev', 30_000),
      m('a', 'auditor', 30_000),
      m('k', 'kol', 20_000),
      m('o', 'mod', 15_000, { paidRoleEligible: false }),
    ];
    const capped = planPayroll(cfg, team, week, 1e9);
    expect(capped.wages.reduce((s, w) => s + w.cents, 0)).toBe(
      cfg.payroll.maxWagesCentsPerProjectWeek,
    );
    expect(capped.wages.map((w) => w.userId)).not.toContain('o');
    const founderCap = planPayroll(cfg, team, week, 25_000);
    expect(founderCap.wages).toEqual([{ userId: 'd', cents: 25_000 }]);
    expect(planPayroll(cfg, team, week, -5).wages).toEqual([]);
  });
});

describe('quoteLaunch', () => {
  const base = {
    kind: 'dex' as const,
    status: 'founded' as const,
    treasuryCents: 1_000_000,
    roles: new Set<MemberRole>(['founder', 'dev']),
    createdAtMs: 0,
    nowMs: 3_600_000,
    founderTribeId: null,
  };

  it('costs the kind price, 30% off for a Builder founder', () => {
    expect(quoteLaunch(cfg, base)).toEqual({
      launchCostCents: 250_000,
      builderDiscountBps: 0,
      canLaunch: true,
      blockers: [],
    });
    const b = quoteLaunch(cfg, { ...base, founderTribeId: 'builder' });
    expect(b.launchCostCents).toBe(175_000);
    expect(b.builderDiscountBps).toBe(3000);
  });

  it('lists every blocker', () => {
    const q = quoteLaunch(cfg, {
      ...base,
      status: 'live',
      roles: new Set<MemberRole>(['founder']),
      nowMs: 60_000,
      treasuryCents: 10,
    });
    expect(q.canLaunch).toBe(false);
    expect(q.blockers.sort()).toEqual(
      ['cooldown', 'insufficient_treasury', 'no_dev_hired', 'wrong_status'].sort(),
    );
  });
});

describe('rollRisk', () => {
  const roles = new Set<MemberRole>(['founder', 'dev']);

  it('returns null when nothing fires', () => {
    expect(rollRisk(cfg, roles, 1_000_000, scripted([false, false, false]))).toBeNull();
  });

  it('an exploit takes 20% of the treasury, capped', () => {
    const r = rollRisk(cfg, roles, 500_000, scripted([true]));
    expect(r?.def.id).toBe('proj_exploit');
    expect(r?.treasuryDeltaCents).toBe(-100_000);
    const big = rollRisk(cfg, roles, 100_000_000, scripted([true]));
    expect(big?.treasuryDeltaCents).toBe(-200_000);
  });

  it('never takes more than the treasury holds, and skips events that need a missing role', () => {
    const r = rollRisk(cfg, roles, 0, scripted([true]));
    expect(r?.treasuryDeltaCents).toBe(0);
    // proj_audit_passed needs an auditor: with only founder+dev, the third
    // chance() is never asked.
    expect(rollRisk(cfg, roles, 1000, scripted([false, false, true]))).toBeNull();
  });

  it('uses the mitigated chance when the mitigating role is filled', () => {
    const seen: number[] = [];
    const rng: Rng = { ...scripted([]), chance: (p: number) => (seen.push(p), false) };
    rollRisk(cfg, new Set<MemberRole>(['auditor', 'mod']), 1000, rng);
    expect(seen).toEqual([0.01, 0.015, 0.04]);
  });
});

describe('shockPrice', () => {
  it('applies basis points and never goes below 1', () => {
    expect(shockPrice(10_000n, -3000)).toBe(7_000n);
    expect(shockPrice(10_000n, 500)).toBe(10_500n);
    expect(shockPrice(1n, -5000)).toBe(1n);
  });
});
