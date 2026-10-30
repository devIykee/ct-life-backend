/**
 * Builder (player projects): pure rules. No I/O; the application layer
 * (server/application/projects*.ts) reads the rows and persists the results.
 *
 * Economy rule (docs/ECONOMY.md): Cash never moves between players. So:
 *   - a role's wage is a fixed band from contract/config/projects.json, paid
 *     by the game (a faucet), only for a week the member did a task for that
 *     project, prorated for a mid-week join, one paid role per player, and
 *     capped per project and per founder. Wages never depend on the treasury,
 *     so founder deposits can never become someone's wage;
 *   - the project treasury pays an operating cost (a pure sink) in the same
 *     run, so the founder still feels payroll;
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
    readonly maxWagesCentsPerProjectWeek: number;
    readonly maxWagesCentsPerFounderWeek: number;
  };
  readonly task: { readonly durationMinutes: number };
  readonly offers: { readonly ttlHours: number; readonly maxPendingPerProject: number };
  readonly membership: {
    readonly maxRolesPerPlayer: number;
    readonly maxProjectsPerPlayer: number;
  };
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
  /** A project_work_log row for THIS project and week (a real project task). */
  readonly worked: boolean;
  /** When they joined; a mid-week join is prorated. */
  readonly joinedAtMs: number;
  /**
   * False when this is not the player's one paid role this week (an earlier
   * membership elsewhere, or already paid this week by another project).
   */
  readonly paidRoleEligible: boolean;
}

export interface PayrollPlan {
  /** Wages the game credits (a faucet; independent of the treasury). */
  readonly wages: ReadonlyArray<{ readonly userId: string; readonly cents: number }>;
  /** The operating cost the treasury owes (a sink; matches the wages). */
  readonly operatingCostCents: number;
}

/**
 * The share of the week `[weekStartMs, weekStartMs + 7d)` a member was in the
 * project, as a wage in cents (floor).
 * @param fullCents - The weekly wage.
 * @param joinedAtMs - When they joined.
 * @param weekStartMs - Monday 00:00 UTC of the week.
 * @returns The prorated wage.
 */
export function proratedWage(fullCents: number, joinedAtMs: number, weekStartMs: number): number {
  const weekEnd = weekStartMs + WEEK_MS;
  const from = Math.max(joinedAtMs, weekStartMs);
  if (from >= weekEnd) return 0;
  return Math.floor((fullCents * (weekEnd - from)) / WEEK_MS);
}

/**
 * One week's payroll for one project. The treasury plays no part in what a
 * member earns: wages come from the game, so a founder's deposits cannot be
 * piped to another account.
 * @param cfg - projects.json.
 * @param members - Every member with their work, join time and eligibility.
 * @param weekStartMs - Monday 00:00 UTC of the week being paid.
 * @param capCents - What this project may still pay this week (the smaller of
 *   the per-project cap and what is left of the founder's weekly cap).
 * @returns The wages and the operating cost.
 */
export function planPayroll(
  cfg: ProjectsConfig,
  members: readonly PayrollMember[],
  weekStartMs: number,
  capCents: number,
): PayrollPlan {
  let left = Math.max(0, Math.min(capCents, cfg.payroll.maxWagesCentsPerProjectWeek));
  const wages: Array<{ userId: string; cents: number }> = [];
  const ordered = [...members].sort((a, b) => a.joinedAtMs - b.joinedAtMs);
  for (const m of ordered) {
    if (m.role === 'founder' || !m.worked || !m.paidRoleEligible) continue;
    const full = payableWage(cfg, m.role, m.salaryCentsPerWeek);
    const cents = Math.min(left, proratedWage(full, m.joinedAtMs, weekStartMs));
    if (cents <= 0) continue;
    wages.push({ userId: m.userId, cents });
    left -= cents;
  }
  const total = wages.reduce((s, w) => s + w.cents, 0);
  return { wages, operatingCostCents: Math.ceil((total * cfg.payroll.operatingCostBps) / 10_000) };
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
