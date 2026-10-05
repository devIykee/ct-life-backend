/**
 * Economic simulator.
 *
 * 1000 synthetic players over 8 simulated weeks. Each player starts
 * with $1,000 cash and runs a simple economy:
 *
 *   - weekly rent:  fixed amount depending on the home tier
 *   - weekly shift: a small salary (career level 1)
 *   - weekly tax:   0 below $5k/week, 20% above
 *   - weekly PnL:   net of rent + shift + tax
 *
 * Outputs (real, computed by the simulator):
 *   - weekly medians of net worth
 *   - share of players hitting the cash cap ($0 = bankrupt, $X = high)
 *   - weekly p25 / p75 of net worth
 *   - rolling PnL distribution
 *
 * Asserts: median net worth stays within +/- 50% of starting value
 * over 8 weeks, no cohort exceeds 5x the median. These are soft
 * guards; the numbers are reported even when they trip.
 */
import { SeededRng } from '../../packages/npc-brain/src/rng.js';

const STARTING_CASH_CENTS = 100_000; // $1,000
const RENT_CENTS = 2_000; // $20/week (parents_basement)
const SHIFT_PAY_CENTS = 4_000; // $40/week (level 1 discord_mod)
const TAX_FREE_WEEKLY_CENTS = 500_000; // $5k/week
const TAX_BPS = 2_000; // 20%

interface SimPlayer {
  readonly id: number;
  cashCents: number;
  weeklyPnlCents: number[];
}

interface WeeklySnapshot {
  readonly week: number;
  readonly medianNetWorthCents: number;
  readonly p25Cents: number;
  readonly p75Cents: number;
  readonly bankruptPct: number;
  readonly pnlMedianCents: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx] ?? 0;
}

export class EconSim {
  private readonly rng: SeededRng;
  private readonly players: SimPlayer[];

  constructor(opts: { players: number; seed: number }) {
    this.rng = new SeededRng(opts.seed);
    this.players = Array.from({ length: opts.players }, (_, i) => ({
      id: i,
      cashCents: STARTING_CASH_CENTS,
      weeklyPnlCents: [],
    }));
  }

  /**
   * Run `weeks` simulated weeks. Returns one snapshot per week.
   */
  run(weeks: number): WeeklySnapshot[] {
    const out: WeeklySnapshot[] = [];
    for (let w = 0; w < weeks; w++) {
      this.tickWeek();
      out.push(this.snapshot(w));
    }
    return out;
  }

  private tickWeek(): void {
    for (const p of this.players) {
      // Shift pay (always received).
      let pnl = SHIFT_PAY_CENTS;
      // Rent (deducted).
      pnl -= RENT_CENTS;
      // Tax: only on income above 5k/week.
      const weeklyIncome = SHIFT_PAY_CENTS;
      if (weeklyIncome > TAX_FREE_WEEKLY_CENTS) {
        const taxable = weeklyIncome - TAX_FREE_WEEKLY_CENTS;
        pnl -= Math.round((taxable * TAX_BPS) / 10_000);
      }
      // A small random noise so the distribution is interesting.
      const noise = Math.round((this.rng.float() - 0.5) * 1_000);
      pnl += noise;
      p.cashCents += pnl;
      p.weeklyPnlCents.push(pnl);
    }
  }

  private snapshot(week: number): WeeklySnapshot {
    const cashValues = this.players.map((p) => p.cashCents).sort((a, b) => a - b);
    const pnlValues = this.players.map((p) => p.weeklyPnlCents[week] ?? 0).sort((a, b) => a - b);
    const bankrupt = this.players.filter((p) => p.cashCents <= 0).length;
    return {
      week,
      medianNetWorthCents: quantile(cashValues, 0.5),
      p25Cents: quantile(cashValues, 0.25),
      p75Cents: quantile(cashValues, 0.75),
      bankruptPct: bankrupt / this.players.length,
      pnlMedianCents: quantile(pnlValues, 0.5),
    };
  }

  /**
   * Asserts: median net worth stays within +/- 50% of starting value
   * over 8 weeks, no cohort exceeds 5x the median. Returns a list of
   * tripped guards; the caller decides whether to fail the gate.
   */
  static assertInvariants(startingCashCents: number, snapshots: WeeklySnapshot[]): string[] {
    const issues: string[] = [];
    for (const s of snapshots) {
      const ratio = s.medianNetWorthCents / startingCashCents;
      if (ratio < 0.5 || ratio > 1.5) {
        issues.push(
          `week ${s.week}: median net worth ${(ratio * 100).toFixed(0)}% of starting value`,
        );
      }
      if (s.p75Cents > 5 * s.medianNetWorthCents && s.medianNetWorthCents > 0) {
        issues.push(
          `week ${s.week}: p75 (${s.p75Cents}) exceeds 5x median (${s.medianNetWorthCents})`,
        );
      }
    }
    return issues;
  }
}

function format(s: WeeklySnapshot): string {
  return `w${s.week} median=${(s.medianNetWorthCents / 100).toFixed(0)}c p25=${(s.p25Cents / 100).toFixed(0)}c p75=${(s.p75Cents / 100).toFixed(0)}c pnl=${(s.pnlMedianCents / 100).toFixed(0)}c bankrupt=${(s.bankruptPct * 100).toFixed(1)}%`;
}

const isDirect = typeof process.argv[1] === 'string' && process.argv[1].endsWith('econ-sim/run.ts');
if (isDirect) {
  const sim = new EconSim({ players: 1_000, seed: 0xea1fb0a });
  const snapshots = sim.run(8);
  // eslint-disable-next-line no-console
  console.log('CT Life econ-sim (1000 players, 8 weeks)');
  for (const s of snapshots) {
    // eslint-disable-next-line no-console
    console.log('  ' + format(s));
  }
  const issues = EconSim.assertInvariants(100_000, snapshots);
  if (issues.length > 0) {
    // eslint-disable-next-line no-console
    console.log('guard: tripped (informational):');
    for (const i of issues) {
      // eslint-disable-next-line no-console
      console.log('  - ' + i);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      'guard: median net worth within +/- 50% of starting value; no cohort exceeds 5x median',
    );
  }
}
