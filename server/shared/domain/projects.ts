/**
 * Builder (player projects): pure rules. No I/O; the application layer
 * (server/application/projects*.ts) reads the rows and persists the results.
 *
 * Economy rule (docs/ECONOMY.md): Cash never moves between players. So:
 *   - a role's wage is a fixed band from contract/config/projects.json, paid
 *     by the game (a faucet), and only for a week the member worked;
 *   - the project treasury pays a matching operating cost (a sink) in the
 *     same run, so the founder still feels payroll;
 *   - treasury Cash only ever leaves through sinks (launch, operating cost,
 *     risk losses), never to a player.
 */
import type { Rng } from './rng.js';

export const PROJECT_KINDS = ['memecoin', 'dex', 'nft_studio', 'perps_venue', 'l2'] as const;
export const HIRE_ROLES = ['dev', 'mod', 'kol', 'auditor'] as const;

export type ProjectKind = (typeof PROJECT_KINDS)[number];
export type HireRole = (typeof HIRE_ROLES)[number];
export type MemberRole = HireRole | 'founder';
export type ProjectStatus = 'founded' | 'launching' | 'live' | 'paused' | 'rugged';

export interface WageBand {
  readonly minCentsPerWeek: number;
  readonly maxCentsPerWeek: number;
}

export interface RiskEventDef {
  readonly id: string;
  readonly dailyChanceBps: number;
  readonly mitigatedBy?: HireRole;
  readonly mitigatedChanceBps?: number;
  readonly requiresRole?: HireRole;
  readonly treasuryDeltaBps: number;
  readonly treasuryDeltaCapCents: number;
  readonly priceShockBps: number;
  readonly worldEventId?: string | null;
}

export interface ProjectsConfig {
  readonly version: string;
  readonly wages: Readonly<Record<HireRole, WageBand>>;
  readonly payroll: {
    readonly operatingCostBps: number;
    readonly workLedgerReasons: readonly string[];
  };
  readonly offers: { readonly ttlHours: number; readonly maxPendingPerProject: number };
  readonly membership: { readonly maxRolesPerPlayer: number };
  readonly fund: { readonly maxCentsPerCall: number };
  readonly launch: {
    readonly costCentsByKind: Readonly<Record<ProjectKind, number>>;
    readonly builderTribeId: string;
    readonly builderDiscountBps: number;
    readonly requiredRole: HireRole | null;
    readonly minProjectAgeMinutes: number;
  };
  readonly risk: { readonly events: readonly RiskEventDef[] };
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * @param cfg - projects.json.
 * @param role - A hireable role.
 * @param cents - The offered weekly wage.
 * @returns null when the wage is inside the role's band, else the band.
 */
export function salaryOutOfBand(
  cfg: ProjectsConfig,
  role: HireRole,
  cents: number,
): WageBand | null {
  const band = cfg.wages[role];
  if (!Number.isSafeInteger(cents) || cents < band.minCentsPerWeek || cents > band.maxCentsPerWeek)
    return band;
  return null;
}

/**
 * The wage the game pays for a week: the stored salary clamped into the
 * role's current band (a band tightened after hiring caps old offers too).
 * @param cfg - projects.json.
 * @param role - The member's role (the founder earns nothing).
 * @param storedCents - salary_cents_per_week on the member row.
 * @returns Cents to pay.
 */
export function payableWage(cfg: ProjectsConfig, role: MemberRole, storedCents: number): number {
  if (role === 'founder') return 0;
  const band = cfg.wages[role];
  return Math.max(band.minCentsPerWeek, Math.min(band.maxCentsPerWeek, Math.trunc(storedCents)));
}

/**
 * @param at - Any instant (epoch ms).
 * @returns Monday 00:00 UTC of the ISO week that contains `at` (epoch ms).
 */
export function weekStartUtc(at: number): number {
  const d = new Date(at);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return midnight - sinceMonday * DAY_MS;
}

/** @returns The next Monday 00:00 UTC strictly after `at` (epoch ms). */
export function nextPayrollAt(at: number): number {
  return weekStartUtc(at) + WEEK_MS;
}

/** @returns 'YYYY-MM-DD' of the UTC day `at` falls on. */
export function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export interface PayrollMember {
  readonly userId: string;
  readonly role: MemberRole;
  readonly salaryCentsPerWeek: number;
  readonly worked: boolean;
}

export interface PayrollPlan {
  /** Wages the game credits (only members who worked). */
  readonly wages: ReadonlyArray<{ readonly userId: string; readonly cents: number }>;
  /** What the treasury pays as the matching operating cost. */
  readonly operatingCostCents: number;
  /** False when the treasury cannot cover the operating cost: nothing is paid. */
  readonly affordable: boolean;
}

/**
 * One week's payroll for one project.
 * @param cfg - projects.json.
 * @param members - Every member with whether they worked that week.
 * @param treasuryCents - The project's treasury before the run.
 * @returns The wages to pay and the operating cost to debit.
 */
export function planPayroll(
  cfg: ProjectsConfig,
  members: readonly PayrollMember[],
  treasuryCents: number,
): PayrollPlan {
  const wages = members
    .filter((m) => m.role !== 'founder' && m.worked)
    .map((m) => ({ userId: m.userId, cents: payableWage(cfg, m.role, m.salaryCentsPerWeek) }))
    .filter((w) => w.cents > 0);
  const total = wages.reduce((s, w) => s + w.cents, 0);
  const operatingCostCents = Math.ceil((total * cfg.payroll.operatingCostBps) / 10_000);
  const affordable = treasuryCents >= operatingCostCents;
  return affordable
    ? { wages, operatingCostCents, affordable }
    : { wages: [], operatingCostCents, affordable };
}

export type LaunchBlocker = 'insufficient_treasury' | 'wrong_status' | 'no_dev_hired' | 'cooldown';

export interface LaunchQuoteInput {
  readonly kind: ProjectKind;
  readonly status: ProjectStatus;
  readonly treasuryCents: number;
  readonly roles: ReadonlySet<MemberRole>;
  readonly createdAtMs: number;
  readonly nowMs: number;
  /** The founder's tribe gets `builderDiscountBps` off. */
  readonly founderTribeId: string | null;
}

export interface LaunchQuoteResult {
  readonly launchCostCents: number;
  readonly builderDiscountBps: number;
  readonly canLaunch: boolean;
  readonly blockers: LaunchBlocker[];
}

/**
 * What launching costs now and what blocks it. The quote is a pure function
 * of the project row, so `POST /launch` recomputes it and compares.
 * @param cfg - projects.json.
 * @param q - The project facts.
 * @returns Cost (discount already applied), discount and blockers.
 */
export function quoteLaunch(cfg: ProjectsConfig, q: LaunchQuoteInput): LaunchQuoteResult {
  const base = cfg.launch.costCentsByKind[q.kind];
  const discountBps =
    q.founderTribeId !== null && q.founderTribeId === cfg.launch.builderTribeId
      ? cfg.launch.builderDiscountBps
      : 0;
  const launchCostCents = Math.ceil((base * (10_000 - discountBps)) / 10_000);
  const blockers: LaunchBlocker[] = [];
  if (q.status !== 'founded') blockers.push('wrong_status');
  if (cfg.launch.requiredRole !== null && !q.roles.has(cfg.launch.requiredRole))
    blockers.push('no_dev_hired');
  if (q.nowMs - q.createdAtMs < cfg.launch.minProjectAgeMinutes * 60_000) blockers.push('cooldown');
  if (q.treasuryCents < launchCostCents) blockers.push('insufficient_treasury');
  return {
    launchCostCents,
    builderDiscountBps: discountBps,
    canLaunch: blockers.length === 0,
    blockers,
  };
}

export interface RiskOutcome {
  readonly def: RiskEventDef;
  /** Negative or zero: what the treasury loses. */
  readonly treasuryDeltaCents: number;
}

/**
 * The daily risk roll for one live project: at most one event a day. Each
 * event is tried in config order with its own chance (halved-style
 * mitigation when the mitigating role is filled; events that need a role
 * are skipped without it).
 * @param cfg - projects.json.
 * @param roles - The roles currently filled.
 * @param treasuryCents - The treasury now (losses are a share of it, capped).
 * @param rng - Injected randomness.
 * @returns The event that fired, or null.
 */
export function rollRisk(
  cfg: ProjectsConfig,
  roles: ReadonlySet<MemberRole>,
  treasuryCents: number,
  rng: Rng,
): RiskOutcome | null {
  for (const def of cfg.risk.events) {
    if (def.requiresRole !== undefined && !roles.has(def.requiresRole)) continue;
    const mitigated = def.mitigatedBy !== undefined && roles.has(def.mitigatedBy);
    const chanceBps = mitigated
      ? (def.mitigatedChanceBps ?? def.dailyChanceBps)
      : def.dailyChanceBps;
    if (!rng.chance(chanceBps / 10_000)) continue;
    const raw = Math.trunc((treasuryCents * def.treasuryDeltaBps) / 10_000);
    const treasuryDeltaCents = Math.max(raw, -def.treasuryDeltaCapCents, -treasuryCents);
    return { def, treasuryDeltaCents: treasuryDeltaCents === 0 ? 0 : treasuryDeltaCents };
  }
  return null;
}

/**
 * Apply a price shock in basis points to a coin price (micros), never below 1.
 * @param priceMicros - The current price.
 * @param shockBps - e.g. -3000 for -30%.
 * @returns The shocked price.
 */
export function shockPrice(priceMicros: bigint, shockBps: number): bigint {
  const next = (priceMicros * BigInt(10_000 + shockBps)) / 10_000n;
  return next < 1n ? 1n : next;
}
