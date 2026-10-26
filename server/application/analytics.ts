/**
 * Server-side product analytics: the funnel and the economy, in Postgres.
 *
 * One row per product event in `analytics_events` (migration 098), written
 * in the same transaction as the action it describes, so an event exists
 * exactly when the action committed (a rolled-back or replayed request
 * writes nothing). Daily rollups are SQL views over that table and over
 * the Cash ledger; see docs/ANALYTICS.md.
 *
 * Privacy: the only identifier is the internal user id (a random uuid).
 * Event names and their props are a closed, typed list below; props hold
 * numbers, booleans and catalogue ids only. No wallet address, alias,
 * free text, IP, device id or location is ever recorded. Rows are deleted
 * with the user (ON DELETE CASCADE) and pruned after
 * ANALYTICS_RETENTION_DAYS by the workers.
 *
 * Set ANALYTICS_ENABLED=false to stop writing events (the actions still run).
 */
import type { PoolClient } from 'pg';
import type { Db } from '../shared/db/pool.js';
import { loadConfig } from '../shared/config/config.js';

/** Catalogue ids only: lowercase, digits, `_ : . -`, at most 64 chars. */
const ID_RE = /^[a-z0-9][a-z0-9_:.-]{0,63}$/;

export type SignInMethod = 'siws' | 'dev';

/** Every event the server records, with its props. Closed on purpose. */
export type AnalyticsEvent =
  | { name: 'signup'; props: { method: SignInMethod; seeker: boolean } }
  | { name: 'session_start'; props: { method: SignInMethod } }
  | { name: 'character_created'; props: { tribeId: string; likeness: boolean } }
  | { name: 'lottery_rolled'; props: { outcome: string }; amountCents: number }
  | {
      name: 'quest_claimed';
      props: { questId: string; period: 'daily' | 'weekly' | 'starter' };
      amountCents: number;
    }
  | { name: 'daily_claimed'; props: { streakDay: number; reset: boolean }; amountCents: number }
  | { name: 'shift_paid'; props: { careerId: string; bonusCents: number }; amountCents: number }
  | {
      name: 'casino_round';
      props: { game: string; stakeCents: number; payoutCents: number; pvp: boolean };
      /** Player's net: payout minus stake. */
      amountCents: number;
    }
  | { name: 'shop_order'; props: { lines: number; units: number }; amountCents: number }
  | { name: 'tip_sent'; props: { feeCents: number }; amountCents: number };

export type AnalyticsEventName = AnalyticsEvent['name'];

/** The registry the migration's CHECK mirrors; keep the two in step. */
export const ANALYTICS_EVENT_NAMES: readonly AnalyticsEventName[] = [
  'signup',
  'session_start',
  'character_created',
  'lottery_rolled',
  'quest_claimed',
  'daily_claimed',
  'shift_paid',
  'casino_round',
  'shop_order',
  'tip_sent',
];

let override: boolean | null = null;

/** Test-only: force recording on or off (null goes back to the config). */
export function _setAnalyticsEnabledForTests(on: boolean | null): void {
  override = on;
}

function isEnabled(): boolean {
  return override ?? loadConfig().analytics.enabled;
}

/**
 * Whether migration 098 has run on this database, checked once per process.
 * A deploy whose code lands before its migration must not turn every
 * sign-in and claim into a 500 (an INSERT into a missing table aborts the
 * caller's transaction), so until the table exists events are skipped.
 */
let tableReady: boolean | null = null;
let warnedMissing = false;

async function tableExists(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  if (tableReady !== null) return tableReady;
  const r = await client.query<{ t: string | null }>(
    `SELECT to_regclass('analytics_events')::text AS t`,
  );
  const ready = r.rows[0]?.t != null;
  // Remember a hit for good; re-check a miss on the next event (the
  // migration may run while the process is up).
  if (ready) tableReady = true;
  else if (!warnedMissing) {
    warnedMissing = true;
    console.warn('[analytics] analytics_events is missing (migration 098); events skipped');
  }
  return ready;
}

/**
 * Check the props are the safe shapes (finite numbers, booleans, catalogue
 * ids). The types already prevent anything else at compile time; this is
 * the runtime backstop so a stray string can never carry PII.
 * @param props - The event props.
 * @returns The props, unchanged.
 */
export function safeProps(
  props: Record<string, unknown>,
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && ID_RE.test(v)) out[k] = v;
    else throw new Error(`analytics: prop ${k} is not a number, boolean or catalogue id`);
  }
  return out;
}

/**
 * Record one event inside the caller's transaction.
 * @param client - The transaction's connection.
 * @param userId - The player (internal uuid), or null for a system event.
 * @param event - The event.
 * @param at - When it happened (defaults to the transaction's now()).
 */
export async function recordEvent(
  client: Pick<PoolClient, 'query'>,
  userId: string | null,
  event: AnalyticsEvent,
  at?: Date,
): Promise<void> {
  if (!isEnabled()) return;
  const props = safeProps(event.props);
  if (!(await tableExists(client))) return;
  const amount = 'amountCents' in event ? Math.trunc(event.amountCents) : null;
  await client.query(
    `INSERT INTO analytics_events (user_id, name, props, amount_cents, occurred_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))`,
    [userId, event.name, props, amount, at ?? null],
  );
}

/**
 * Delete events older than the retention window. Run daily by the workers.
 * @param db - The pool.
 * @param days - Retention in days.
 * @returns How many rows were deleted.
 */
export async function pruneAnalyticsEvents(db: Db, days: number): Promise<number> {
  const r = await db.withConnection((c) =>
    c.query(`DELETE FROM analytics_events WHERE occurred_at < now() - make_interval(days => $1)`, [
      days,
    ]),
  );
  return r.rowCount ?? 0;
}
