/**
 * Sunday Unlock + Weekly Meta rotation worker (M5 #60, M5 #68).
 *
 * Two cron-driven jobs:
 *
 *   jobs:sunday-unlock   @ Sun 20:00 UTC
 *     - Reads last week's daily_clue_attempts and pulls the
 *       winners (correct=true) and losers (correct=false)
 *       per user. The winners get a flat $5 perk credit via
 *       a 'weekly_perk' ledger row. The losers get nothing.
 *     - Writes a meta_jobs row (UNIQUE on (kind, week_iso)) so
 *       a re-run cannot double-credit.
 *
 *   jobs:weekly-meta     @ Sun 20:05 UTC
 *     - Pulls the week's winners and losers, derives a new
 *       WeeklyMeta (currently a placeholder shape), and
 *       upserts the 'current' meta row.
 *     - Writes a meta_jobs row.
 *
 * Both handlers are exported individually so the workers
 * main.ts can wire them to the BullMQ queues. Both also
 * accept the `db` from the AppContext so the routes + tests
 * can drive the rotation without spinning up BullMQ.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { Db } from '../shared/db/pool.js';

export const WEEKLY_PERK_CENTS = 500; // $5
export const SUNDAY_UNLOCK_WEEK_PRIOR_DAYS = 7;

export interface WeeklyMetaShape {
  readonly weekIso: string;
  readonly winnersCount: number;
  readonly losersCount: number;
  readonly perkCents: number;
  readonly generatedAt: string;
}

/** Returns the ISO-8601 week identifier (e.g. '2026-W40') for `d`. */
export function weekIso(d: Date): string {
  // Copy the date and roll to the nearest Thursday: that gives
  // the ISO-8601 week number.
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7,
    );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The UTC range [start, end) of the prior ISO week, given `now`. */
export function priorWeekRange(now: Date = new Date()): { startUtc: Date; endUtc: Date } {
  // Walk back to the previous Sunday's 20:00 UTC, then take
  // the 7-day window ending there.
  const endUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0, 0),
  );
  const startUtc = new Date(endUtc.getTime() - SUNDAY_UNLOCK_WEEK_PRIOR_DAYS * 86_400_000);
  return { startUtc, endUtc };
}

interface PassRow {
  user_id: string;
  pass_id: string;
}

interface MetaRow {
  key: string;
  value: unknown;
}

/**
 * Run the Sunday Unlock perk. For every user with a
 * season_pass(tier='season') that solved at least one
 * clue in the prior week, credit a 'weekly_perk' ledger row.
 *
 * Idempotent on (kind='sunday_unlock', week_iso=...) via the
 * meta_jobs UNIQUE index. A re-run of the same week is a no-op.
 */
export async function runSundayUnlock(
  db: Db,
  now: Date = new Date(),
): Promise<{
  credited: number;
  weekIso: string;
  skipped: boolean;
}> {
  const wk = weekIso(now);
  const already = await db.withConnection(async (c) => {
    const r = await c.query<{ job_id: string }>(
      `SELECT job_id FROM meta_jobs WHERE kind = 'sunday_unlock' AND week_iso = $1`,
      [wk],
    );
    return r.rows[0];
  });
  if (already) {
    return { credited: 0, weekIso: wk, skipped: true };
  }
  const { startUtc, endUtc } = priorWeekRange(now);
  const winners = await db.withConnection(async (c) => {
    const r = await c.query<{ user_id: string }>(
      `SELECT DISTINCT user_id
       FROM daily_clue_attempts
       WHERE correct = true
         AND attempted_at >= $1
         AND attempted_at < $2`,
      [startUtc, endUtc],
    );
    return r.rows.map((x) => x.user_id);
  });
  // Pass holders only.
  const passHolders = await db.withConnection(async (c) => {
    const r = await c.query<PassRow>(
      `SELECT user_id, pass_id FROM season_pass
       WHERE tier = 'season' AND expires_at > now()`,
    );
    return r.rows;
  });
  const holderIds = new Set(passHolders.map((p) => p.user_id));
  const eligible = winners.filter((u) => holderIds.has(u));

  let credited = 0;
  for (const userId of eligible) {
    await runInTransaction(async (client) => {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      const bal = await client.query<{ cash_cents: string }>(
        `SELECT cash_cents FROM balances WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      void bal;
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
        [userId, WEEKLY_PERK_CENTS],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
         VALUES ($1, $2, 'cash', 'weekly_perk', 'season_pass', $3, $4)`,
        [userId, WEEKLY_PERK_CENTS, wk, `weekly-perk:${wk}:${userId}:${uuidv7()}`],
      );
      credited += 1;
    });
  }
  await db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO meta_jobs (job_id, kind, week_iso, payload)
       VALUES ($1, 'sunday_unlock', $2, $3)
       ON CONFLICT (kind, week_iso) DO NOTHING`,
      [uuidv7(), wk, { credited, weekIso: wk, totalEligible: eligible.length }],
    );
  });
  return { credited, weekIso: wk, skipped: false };
}

/**
 * Run the Weekly Meta rotation. Pulls the week's winners and
 * losers, derives a new WeeklyMeta, upserts the 'current'
 * meta row. Idempotent on (kind='weekly_meta', week_iso=...).
 */
export async function runWeeklyMeta(
  db: Db,
  now: Date = new Date(),
): Promise<{
  weekIso: string;
  winnersCount: number;
  losersCount: number;
  skipped: boolean;
}> {
  const wk = weekIso(now);
  const already = await db.withConnection(async (c) => {
    const r = await c.query<{ job_id: string }>(
      `SELECT job_id FROM meta_jobs WHERE kind = 'weekly_meta' AND week_iso = $1`,
      [wk],
    );
    return r.rows[0];
  });
  if (already) {
    return { weekIso: wk, winnersCount: 0, losersCount: 0, skipped: true };
  }
  const { startUtc, endUtc } = priorWeekRange(now);
  const counts = await db.withConnection(async (c) => {
    const r = await c.query<{ correct: boolean; n: string }>(
      `SELECT correct, COUNT(*)::text AS n
       FROM daily_clue_attempts
       WHERE attempted_at >= $1 AND attempted_at < $2
       GROUP BY correct`,
      [startUtc, endUtc],
    );
    const map = new Map<boolean, number>();
    for (const row of r.rows) {
      map.set(row.correct, Number(row.n));
    }
    return {
      winnersCount: map.get(true) ?? 0,
      losersCount: map.get(false) ?? 0,
    };
  });
  const meta: WeeklyMetaShape = {
    weekIso: wk,
    winnersCount: counts.winnersCount,
    losersCount: counts.losersCount,
    perkCents: WEEKLY_PERK_CENTS,
    generatedAt: now.toISOString(),
  };
  await db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO meta (key, value, updated_at)
       VALUES ('current', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(meta)],
    );
    await c.query(
      `INSERT INTO meta_jobs (job_id, kind, week_iso, payload)
       VALUES ($1, 'weekly_meta', $2, $3)
       ON CONFLICT (kind, week_iso) DO NOTHING`,
      [uuidv7(), wk, meta],
    );
  });
  return { weekIso: wk, ...counts, skipped: false };
}

/** Pull the current WeeklyMeta row, if any. */
export async function getCurrentMeta(db: Db): Promise<WeeklyMetaShape | null> {
  const r = await db.withConnection(async (c) => {
    return c.query<MetaRow>(`SELECT key, value FROM meta WHERE key = 'current'`);
  });
  const row = r.rows[0];
  if (!row) return null;
  return row.value as WeeklyMetaShape;
}

/** Stand-alone helpers so the BullMQ worker can call them. */
import type { Job } from 'bullmq';
import type { RedisLayer } from '../shared/redis/client.js';
import { createLogger } from '../shared/logger/logger.js';
import { buildContext } from '../application/context.js';

/**
 * BullMQ handler: Sunday Unlock.
 * The cron is registered in `server/workers/main.ts`.
 */
export async function handleSundayUnlock(job: Job, _redis: RedisLayer): Promise<void> {
  const log = createLogger().child({ worker: 'sunday-unlock' });
  const ctx = buildContext();
  const out = await runSundayUnlock(ctx.db);
  log.info({ jobId: job.id, ...out }, 'sunday unlock ran');
}

/**
 * BullMQ handler: Weekly Meta rotation.
 */
export async function handleWeeklyMeta(job: Job, _redis: RedisLayer): Promise<void> {
  const log = createLogger().child({ worker: 'weekly-meta' });
  const ctx = buildContext();
  const out = await runWeeklyMeta(ctx.db);
  log.info({ jobId: job.id, ...out }, 'weekly meta ran');
}
