/**
 * Daily and weekly quests.
 *
 *   GET  /v1/quests              today's 3 daily quests and this week's chain of 5, with progress
 *   POST /v1/quests/{id}/claim   claim a finished quest (idempotent)
 *
 * Definitions live in `contract/ids/quests.json`. Each player gets a deterministic pick:
 * the daily 3 are seeded by user and UTC date, the weekly 5 by user and ISO week, with
 * distinct verbs preferred. Nothing about the pick is stored; it is recomputed from the
 * file, so editing a definition changes today's quests for everyone.
 *
 * Progress comes only from server events. `recordQuestEvent` is called after the commit
 * of the service that did the real thing (a shift paid, a perp opened, ...), never from
 * a route that takes the client's word. Each source event carries a stable `ref`, and
 * `quest_events (user_id, verb, ref)` makes it count once however often the hook fires.
 * A failure here is logged and swallowed: it must never fail the action that triggered it.
 *
 * Starter quests (pool 'starter') are not picked by date. A NEW account (created after the
 * onboarding migration) is given them once, at its first onboarding contact (character
 * creation, or the first GET /quests); they are recorded in `starter_quests` and never
 * reseeded. Old accounts get none. `q_starter_trade` is only given while markets are live
 * (`LIVE_PHASE` >= 2); if markets open later it is added then. Their progress uses
 * `quest_progress` with period_key 'starter', so claim, Cash (`quest_reward`) and Season XP
 * are the ordinary ones.
 *
 * Rewards come from the definitions file, never from the request. A claim pays Cash with
 * ledger reason `quest_reward` and records Season XP in `season_xp`. Only quests in the
 * caller's current picks can be claimed, so another player's quest id is a plain 404.
 */
import { createHash } from 'node:crypto';
import { runInTransaction } from '../shared/db/uow.js';
import { recordEvent } from './analytics.js';
import { NotFoundError, QuestNotCompleteError } from '../shared/domain/errors.js';
import { nextUtcMidnight, utcDate } from './daily-streak.js';
import { recordCareerAction } from './ladders.js';
import { publishToUser } from './realtime-bus.js';
import { weekIso } from './season-clock.js';
import { isNewAccount, lockOnboarding } from './onboarding-store.js';
import type { AppContext } from './context.js';

export type QuestVerb =
  | 'shift_complete'
  | 'perp_open'
  | 'perp_close'
  | 'prediction_place'
  | 'alpha_call'
  | 'paid_call'
  | 'tip_send'
  | 'home_visit'
  | 'shift_start'
  | 'trade_open'
  | 'chest_open';

export interface QuestDef {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly verb: QuestVerb;
  readonly target: number;
  readonly reward: { readonly cashCents: number; readonly seasonXp: number };
  readonly pool: 'daily' | 'weekly' | 'starter';
  readonly deepLink?: string;
}

export const DAILY_COUNT = 3;
export const WEEKLY_COUNT = 5;
/** A home counts for `home_visit` once per this many days. */
export const HOME_VISIT_COOLDOWN_DAYS = 7;
/** A pair of players counts for `paid_call` once per this many days. */
export const PAID_CALL_PAIR_COOLDOWN_DAYS = 7;

/** Limit a social event to once per counterpart within a window. */
export interface CounterpartRule {
  /** Identifies the other side (a user id, a home id). */
  readonly key: string;
  readonly cooldownDays: number;
}

/**
 * Every quest definition.
 * @param ctx - The application context.
 * @returns The definitions from contract/ids/quests.json.
 */
export function loadQuestDefs(ctx: AppContext): readonly QuestDef[] {
  return ctx.configCache.load<{ quests: QuestDef[] }>('quests').quests;
}

/**
 * Deterministically pick `count` quests for a player and period. The order is a hash of
 * user, period and quest id; verbs already chosen are skipped until none are left.
 * @param userId - The player.
 * @param periodKey - The UTC date (daily) or ISO week (weekly).
 * @param pool - The candidate definitions.
 * @param count - How many to pick.
 * @returns The picks.
 */
export function pickQuests(
  userId: string,
  periodKey: string,
  pool: readonly QuestDef[],
  count: number,
): QuestDef[] {
  const ranked = pool
    .map((q) => ({
      q,
      h: createHash('sha256').update(`${userId}:${periodKey}:${q.id}`).digest('hex'),
    }))
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
    .map((x) => x.q);
  const picked: QuestDef[] = [];
  const verbs = new Set<string>();
  for (const q of ranked) {
    if (picked.length >= count) break;
    if (verbs.has(q.verb)) continue;
    verbs.add(q.verb);
    picked.push(q);
  }
  for (const q of ranked) {
    if (picked.length >= count) break;
    if (!picked.includes(q)) picked.push(q);
  }
  return picked;
}

interface Picks {
  readonly dayKey: string;
  readonly weekKey: string;
  readonly daily: QuestDef[];
  readonly weekly: QuestDef[];
}

function picksFor(ctx: AppContext, userId: string, now: Date): Picks {
  const defs = loadQuestDefs(ctx);
  const dayKey = utcDate(now);
  const weekKey = weekIso(now);
  const daily = pickQuests(
    userId,
    dayKey,
    defs.filter((d) => d.pool === 'daily'),
    DAILY_COUNT,
  );
  // The chain climbs: the smaller rewards come first.
  const weekly = pickQuests(
    userId,
    weekKey,
    defs.filter((d) => d.pool === 'weekly'),
    WEEKLY_COUNT,
  ).sort((a, b) => a.reward.cashCents - b.reward.cashCents || (a.id < b.id ? -1 : 1));
  return { dayKey, weekKey, daily, weekly };
}

function nextMondayUtc(now: Date): Date {
  const daysToMonday = (8 - now.getUTCDay()) % 7 || 7;
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToMonday),
  );
}

export interface QuestView {
  readonly id: string;
  readonly pool: 'starter' | 'daily' | 'weekly';
  readonly title: string;
  readonly description: string | null;
  readonly verb: QuestVerb;
  readonly target: number;
  readonly progress: number;
  readonly completed: boolean;
  readonly claimed: boolean;
  readonly reward: { readonly cashCents: number; readonly seasonXp: number };
  readonly deepLink: string | null;
  /** Position in the weekly chain, 1 to 5. Absent for daily quests. */
  readonly step?: number;
}

export interface QuestsResponse {
  /** The starter quests, first. Empty for an old account or once none are left to show. */
  readonly starter: {
    readonly quests: QuestView[];
  };
  readonly daily: {
    readonly date: string;
    readonly resetsAt: string;
    readonly quests: QuestView[];
  };
  readonly weekly: {
    readonly week: string;
    readonly resetsAt: string;
    readonly quests: QuestView[];
  };
}

interface ProgressRow {
  period_key: string;
  quest_id: string;
  progress: number;
  completed_at: Date | null;
  claimed_at: Date | null;
}

function view(
  q: QuestDef,
  rows: Map<string, ProgressRow>,
  periodKey: string,
  step?: number,
): QuestView {
  const r = rows.get(`${periodKey}|${q.id}`);
  const progress = Math.min(r?.progress ?? 0, q.target);
  return {
    id: q.id,
    pool: q.pool,
    title: q.title,
    description: q.description ?? null,
    verb: q.verb,
    target: q.target,
    progress,
    completed: progress >= q.target,
    claimed: r?.claimed_at != null,
    reward: q.reward,
    deepLink: q.deepLink ?? null,
    ...(step !== undefined ? { step } : {}),
  };
}

const STARTER_KEY = 'starter';
/** Markets are live for the deployment (LIVE_PHASE 2 or more). */
const marketsLive = (ctx: AppContext): boolean => ctx.config.livePhase >= 2;

/**
 * Seed the starter quests for a NEW account, once. Run in a transaction. Creates the
 * onboarding row if needed. Accounts from before the onboarding migration get nothing.
 * Later it also adds `q_starter_trade` if markets went live after the first seeding.
 * @returns The seeded quest ids (empty for an old account).
 */
export async function ensureStarterQuests(
  client: Parameters<typeof lockOnboarding>[0],
  ctx: AppContext,
  userId: string,
  now: Date,
): Promise<string[]> {
  // Eligibility is the account's age, never "a row exists": an old account that replayed
  // the first session has a row and must still get nothing (no seeding, no late trade quest).
  if (!(await isNewAccount(client, userId))) return [];
  const row = await lockOnboarding(client, userId, now);
  if (!row) return [];
  const starters = loadQuestDefs(ctx).filter((d) => d.pool === 'starter');
  const wanted = starters.filter((d) => d.verb !== 'trade_open' || marketsLive(ctx));
  if (row.starter_seeded_at === null) {
    for (const q of wanted) {
      await client.query(
        `INSERT INTO starter_quests (user_id, quest_id, seeded_at) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, q.id, now],
      );
    }
    await client.query(
      `UPDATE onboarding_state SET starter_seeded_at = $2, updated_at = $2 WHERE user_id = $1`,
      [userId, now],
    );
  } else if (marketsLive(ctx)) {
    const trade = starters.find((d) => d.verb === 'trade_open');
    if (trade) {
      await client.query(
        `INSERT INTO starter_quests (user_id, quest_id, seeded_at) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, trade.id, now],
      );
    }
  }
  const r = await client.query<{ quest_id: string }>(
    `SELECT quest_id FROM starter_quests WHERE user_id = $1`,
    [userId],
  );
  return r.rows.map((x) => x.quest_id);
}

/** The starter quests the player holds, in the file's order. */
async function starterQuestsOf(
  ctx: AppContext,
  c: Parameters<typeof lockOnboarding>[0],
  userId: string,
): Promise<QuestDef[]> {
  const r = await c.query<{ quest_id: string }>(
    `SELECT quest_id FROM starter_quests WHERE user_id = $1`,
    [userId],
  );
  const mine = new Set(r.rows.map((x) => x.quest_id));
  return loadQuestDefs(ctx).filter((d) => d.pool === 'starter' && mine.has(d.id));
}

/**
 * The caller's quests for now.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param now - The current time (injectable for tests).
 * @returns Today's 3 and the weekly chain, with progress.
 */
export async function listQuests(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<QuestsResponse> {
  const p = picksFor(ctx, userId, now);
  // A new account that has not been seeded yet (or an old one: nothing happens) gets its
  // starter quests on this first read.
  await runInTransaction(
    async (client) => {
      await ensureStarterQuests(client, ctx, userId, now);
    },
    {},
    ctx.db,
  );
  const { rows, starters } = await ctx.db.withConnection(async (c) => {
    const r = await c.query<ProgressRow>(
      `SELECT period_key, quest_id, progress, completed_at, claimed_at
         FROM quest_progress WHERE user_id = $1 AND period_key = ANY($2::text[])`,
      [userId, [p.dayKey, p.weekKey, STARTER_KEY]],
    );
    return {
      rows: new Map(r.rows.map((x) => [`${x.period_key}|${x.quest_id}`, x])),
      starters: await starterQuestsOf(ctx, c, userId),
    };
  });
  return {
    starter: { quests: starters.map((q) => view(q, rows, STARTER_KEY)) },
    daily: {
      date: p.dayKey,
      resetsAt: nextUtcMidnight(now).toISOString(),
      quests: p.daily.map((q) => view(q, rows, p.dayKey)),
    },
    weekly: {
      week: p.weekKey,
      resetsAt: nextMondayUtc(now).toISOString(),
      quests: p.weekly.map((q, i) => view(q, rows, p.weekKey, i + 1)),
    },
  };
}

export interface QuestEventUpdate {
  readonly questId: string;
  readonly pool: 'daily' | 'weekly' | 'starter';
  readonly progress: number;
  readonly target: number;
  readonly completed: boolean;
}

/**
 * Count a real server event toward the caller's quests. Safe to call after any commit:
 * it never throws, and a repeated `ref` counts once.
 * @param ctx - The application context.
 * @param userId - Who did the thing.
 * @param verb - What they did.
 * @param ref - A stable id of the source event (shift id, perp id, ...).
 * @param now - The current time (injectable for tests).
 * @param counterpart - For social events: skip the event when this player already earned
 * this verb from the same counterpart within the window, so a pair of accounts cannot
 * loop the same quest.
 */
export async function recordQuestEvent(
  ctx: AppContext,
  userId: string,
  verb: QuestVerb,
  ref: string,
  now: Date = new Date(),
  counterpart?: CounterpartRule,
): Promise<void> {
  // The same real event also feeds the player's career ladder (never throws). A shift has
  // its own, richer path in `ShiftsService`, so it is not counted twice here.
  if (verb !== 'shift_complete') await recordCareerAction(ctx, userId, verb, ref, now, counterpart);
  try {
    const p = picksFor(ctx, userId, now);
    const starters = (await ctx.db.withConnection((c) => starterQuestsOf(ctx, c, userId))).filter(
      (q) => q.verb === verb,
    );
    const matches = [
      ...starters.map((q) => ({ q, key: STARTER_KEY })),
      ...p.daily.filter((q) => q.verb === verb).map((q) => ({ q, key: p.dayKey })),
      ...p.weekly.filter((q) => q.verb === verb).map((q) => ({ q, key: p.weekKey })),
    ];
    if (matches.length === 0) return;
    const updates = await runInTransaction(async (client) => {
      if (counterpart) {
        const since = new Date(now.getTime() - counterpart.cooldownDays * 86_400_000);
        const prior = await client.query(
          `SELECT 1 FROM quest_events
            WHERE user_id = $1 AND verb = $2 AND starts_with(ref, $3) AND created_at > $4 LIMIT 1`,
          [userId, verb, `${counterpart.key}|`, since],
        );
        if (prior.rows.length > 0) return [] as QuestEventUpdate[];
      }
      const stored = counterpart ? `${counterpart.key}|${ref}` : ref;
      const seen = await client.query(
        `INSERT INTO quest_events (user_id, verb, ref, created_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING 1`,
        [userId, verb, stored, now],
      );
      if (seen.rows.length === 0) return [] as QuestEventUpdate[];
      const out: QuestEventUpdate[] = [];
      for (const { q, key } of matches) {
        const r = await client.query<{ progress: number; completed_at: Date | null }>(
          `INSERT INTO quest_progress (user_id, period_key, quest_id, pool, progress, completed_at, updated_at)
           VALUES ($1, $2, $3, $4, 1, CASE WHEN 1 >= $5 THEN $6::timestamptz END, $6)
           ON CONFLICT (user_id, period_key, quest_id) DO UPDATE
             SET progress = LEAST(quest_progress.progress + 1, $5),
                 completed_at = COALESCE(quest_progress.completed_at,
                   CASE WHEN quest_progress.progress + 1 >= $5 THEN $6::timestamptz END),
                 updated_at = $6
           RETURNING progress, completed_at`,
          [userId, key, q.id, q.pool, q.target, now],
        );
        const row = r.rows[0]!;
        out.push({
          questId: q.id,
          pool: q.pool,
          progress: row.progress,
          target: q.target,
          completed: row.completed_at !== null,
        });
      }
      return out;
    });
    for (const u of updates) {
      await publishToUser(ctx, userId, 'quest_progress', { ...u, at: now.getTime() });
    }
  } catch (e) {
    console.error(`[quests] ${verb} event ${ref} failed:`, (e as Error).message);
  }
}

export interface QuestClaimResult {
  readonly questId: string;
  /** True when the quest had already been claimed: nothing was paid this time. */
  readonly alreadyClaimed: boolean;
  readonly reward: { readonly cashCents: number; readonly seasonXp: number };
}

/**
 * Claim a finished quest.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @param questId - The quest, which must be in the caller's current picks.
 * @param now - The current time (injectable for tests).
 * @returns What was paid.
 * @throws NotFoundError for an unknown quest or one that is not the caller's today.
 * @throws QuestNotCompleteError when the target is not reached.
 */
export async function claimQuest(
  ctx: AppContext,
  userId: string,
  questId: string,
  now: Date = new Date(),
): Promise<QuestClaimResult> {
  const p = picksFor(ctx, userId, now);
  const inDaily = p.daily.find((q) => q.id === questId);
  const inWeekly = p.weekly.find((q) => q.id === questId);
  const inStarter =
    inDaily || inWeekly
      ? undefined
      : (await ctx.db.withConnection((c) => starterQuestsOf(ctx, c, userId))).find(
          (q) => q.id === questId,
        );
  const q = inDaily ?? inWeekly ?? inStarter;
  if (!q) throw new NotFoundError({ kind: 'quest', id: questId });
  const periodKey = inDaily ? p.dayKey : inWeekly ? p.weekKey : STARTER_KEY;
  return runInTransaction(async (client) => {
    const r = await client.query<{ progress: number; claimed_at: Date | null }>(
      `SELECT progress, claimed_at FROM quest_progress
        WHERE user_id = $1 AND period_key = $2 AND quest_id = $3 FOR UPDATE`,
      [userId, periodKey, q.id],
    );
    const row = r.rows[0];
    if (!row || row.progress < q.target) {
      throw new QuestNotCompleteError({
        questId: q.id,
        progress: row?.progress ?? 0,
        target: q.target,
      });
    }
    if (row.claimed_at !== null) {
      return { questId: q.id, alreadyClaimed: true, reward: q.reward };
    }
    await client.query(
      `UPDATE quest_progress SET claimed_at = $4, updated_at = $4
        WHERE user_id = $1 AND period_key = $2 AND quest_id = $3`,
      [userId, periodKey, q.id, now],
    );
    if (q.reward.cashCents > 0) {
      await client.query(
        `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
        [userId, q.reward.cashCents],
      );
      await client.query(
        `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref, created_at)
         VALUES ($1, $2, 'cash', 'quest_reward', 'quest', $3, $4, $5)`,
        [userId, q.reward.cashCents, q.id, `quest:${userId}:${periodKey}:${q.id}`, now],
      );
    }
    if (q.reward.seasonXp > 0) {
      await client.query(
        `INSERT INTO season_xp (user_id, amount, source, ref, season_iso, created_at)
         VALUES ($1, $2, 'quest', $3, $4, $5)
         ON CONFLICT (user_id, source, ref) DO NOTHING`,
        [userId, q.reward.seasonXp, `${periodKey}:${q.id}`, weekIso(now), now],
      );
    }
    await recordEvent(
      client,
      userId,
      {
        name: 'quest_claimed',
        props: { questId: q.id, period: inDaily ? 'daily' : 'weekly' },
        amountCents: q.reward.cashCents,
      },
      now,
    );
    return { questId: q.id, alreadyClaimed: false, reward: q.reward };
  });
}
