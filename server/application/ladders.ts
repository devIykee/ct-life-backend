/**
 * Career ladders.
 *
 *   GET  /v1/careers?view=ladders   the five ladders, my rank, XP, next rank and perks
 *   POST /v1/careers/{ladderId}/join  switch to a ladder (a cooldown applies after the first)
 *
 * A ladder (Builder, Trader, Caller, Farmer, Founder) sits on top of the existing jobs: it
 * does not add jobs, it names which of the `careers` entries belong to it (`jobIds`) and
 * which tribes it suits (`tribeIds`). Definitions are in `contract/config/careers.json`.
 *
 * XP comes only from the server:
 *   - a paid shift on one of the ladder's jobs (the shift's own XP), see `ShiftsService`;
 *   - related actions (a perp opened, an alpha call, an airdrop claim, a project founded...)
 *     through `recordCareerAction`, capped per ladder per UTC day.
 * Each award is one `ladder_xp_events` row keyed (user, source, ref), so a replayed hook
 * never pays twice. XP is kept per ladder, but only the ladder you are on pays XP and perks.
 *
 * Promotion is automatic. When the cumulative XP crosses a rank's `xpRequired`, the rank
 * rises in the same transaction as the XP, the rank's cosmetic is granted, and after the
 * commit the player gets the realtime `career_promoted`. Perks per rank: a title, a Cash
 * pay bonus on shifts of the ladder's jobs (`payBonusBps`, integer cents, rounded down),
 * venue-area flags and a cosmetic.
 *
 * Joining the first ladder is free. Moving to another waits `ladderJoinCooldownHours` since
 * the last deliberate join. A player who never chose gets enrolled by their first paid
 * shift on a ladder job (an "auto" enrolment, no cooldown), preferring the ladder that
 * suits their tribe.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import { CareerSwitchCooldownError, NotFoundError } from '../shared/domain/errors.js';
import { nextUtcMidnight } from './daily-streak.js';
import { publishToUser } from './realtime-bus.js';
import { ensureRewardCatalog, grantCosmetic } from './rewards.js';
import type { AppContext } from './context.js';

export interface RankDef {
  readonly rank: number;
  readonly id: string;
  readonly title: string;
  readonly xpRequired: number;
  readonly payBonusBps: number;
  readonly venueAccess: readonly string[];
  readonly cosmeticId: string | null;
}

export interface LadderDef {
  readonly id: string;
  readonly name: string;
  readonly tribeIds: readonly string[];
  readonly jobIds: readonly string[];
  readonly actionXp: Readonly<Record<string, number>>;
  readonly ranks: readonly RankDef[];
}

export interface LaddersConfig {
  readonly ladderJoinCooldownHours: number;
  readonly ladderActionXpDailyCap: number;
  readonly ladders: readonly LadderDef[];
}

export interface PromotionInfo {
  readonly ladderId: string;
  readonly ladderName: string;
  readonly fromRank: number;
  readonly toRank: number;
  readonly title: string;
  readonly payBonusBps: number;
  readonly venueAccess: readonly string[];
  readonly cosmeticIds: readonly string[];
  readonly xp: number;
}

/** What a shift learns about the player's ladder before it pays. */
export interface ShiftLadderContext {
  readonly ladder: LadderDef;
  readonly rank: RankDef;
  /** True when the shift's job belongs to the ladder (bonus and XP apply). */
  readonly applies: boolean;
}

/** The highest rank whose `xpRequired` the XP reaches (rank 1 at minimum). */
export function rankForXp(ranks: readonly RankDef[], xp: number): RankDef {
  let best = ranks[0]!;
  for (const r of ranks) if (xp >= r.xpRequired) best = r;
  return best;
}

/** Cash bonus on a base pay: whole cents, rounded down. */
export function payBonusCents(baseCents: number, bps: number): number {
  return Math.floor((baseCents * bps) / 10_000);
}

/** The ladder config (cached by the context). */
export function laddersConfig(ctx: AppContext): LaddersConfig {
  return ctx.configCache.load<LaddersConfig>('careers');
}

/** A ladder by id, or undefined. */
export function findLadder(ctx: AppContext, ladderId: string): LadderDef | undefined {
  return laddersConfig(ctx).ladders.find((l) => l.id === ladderId);
}

interface MembershipRow {
  ladder_id: string;
  joined_at: Date;
  auto: boolean;
}

async function readMembership(
  q: Pick<PoolClient, 'query'>,
  userId: string,
  forUpdate = false,
): Promise<MembershipRow | null> {
  const r = await q.query<MembershipRow>(
    `SELECT ladder_id, joined_at, auto FROM ladder_membership WHERE user_id = $1
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId],
  );
  return r.rows[0] ?? null;
}

async function readProgress(
  q: Pick<PoolClient, 'query'>,
  userId: string,
  ladderId: string,
  forUpdate = false,
): Promise<{ xp: number; rank: number }> {
  const r = await q.query<{ xp: number; rank: number }>(
    `SELECT xp, rank FROM ladder_progress WHERE user_id = $1 AND ladder_id = $2
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId, ladderId],
  );
  return r.rows[0] ?? { xp: 0, rank: 1 };
}

/**
 * Add XP to a ladder inside the caller's transaction. Idempotent on (user, source, ref).
 * @param client - The open transaction.
 * @param userId - The player.
 * @param ladder - The ladder receiving the XP.
 * @param amount - XP to add, before any cap.
 * @param source - 'shift' or 'action'.
 * @param ref - A stable id of the source event.
 * @param now - The current time.
 * @param dailyCap - When set, the most XP this ladder may take from `source` today.
 * @returns The XP actually added and the promotion, if the rank rose.
 */
export async function awardLadderXp(
  client: PoolClient,
  userId: string,
  ladder: LadderDef,
  amount: number,
  source: string,
  ref: string,
  now: Date,
  dailyCap?: number,
): Promise<{ added: number; promotion: PromotionInfo | null }> {
  const none = { added: 0, promotion: null };
  let add = Math.floor(amount);
  if (add <= 0) return none;
  if (dailyCap !== undefined) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const used = await client.query<{ n: string }>(
      `SELECT COALESCE(SUM(amount), 0) AS n FROM ladder_xp_events
        WHERE user_id = $1 AND ladder_id = $2 AND source = $3
          AND created_at >= $4 AND created_at < $5`,
      [userId, ladder.id, source, dayStart, nextUtcMidnight(now)],
    );
    add = Math.min(add, dailyCap - Number(used.rows[0]?.n ?? 0));
    if (add <= 0) return none;
  }
  const seen = await client.query(
    `INSERT INTO ladder_xp_events (user_id, ladder_id, source, ref, amount, created_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING 1`,
    [userId, ladder.id, source, ref, add, now],
  );
  if (seen.rows.length === 0) return none;

  await client.query(
    `INSERT INTO ladder_progress (user_id, ladder_id) VALUES ($1, $2)
     ON CONFLICT (user_id, ladder_id) DO NOTHING`,
    [userId, ladder.id],
  );
  const before = await readProgress(client, userId, ladder.id, true);
  const xp = before.xp + add;
  const rank = rankForXp(ladder.ranks, xp);
  await client.query(
    `UPDATE ladder_progress SET xp = $3, rank = GREATEST(rank, $4), updated_at = $5
      WHERE user_id = $1 AND ladder_id = $2`,
    [userId, ladder.id, xp, rank.rank, now],
  );
  if (rank.rank <= before.rank) return { added: add, promotion: null };

  const gained = ladder.ranks.filter((r) => r.rank > before.rank && r.rank <= rank.rank);
  const cosmeticIds: string[] = [];
  for (const g of gained) {
    if (g.cosmeticId !== null && (await grantCosmetic(client, userId, g.cosmeticId))) {
      cosmeticIds.push(g.cosmeticId);
    }
  }
  return {
    added: add,
    promotion: {
      ladderId: ladder.id,
      ladderName: ladder.name,
      fromRank: before.rank,
      toRank: rank.rank,
      title: rank.title,
      payBonusBps: rank.payBonusBps,
      venueAccess: gained.flatMap((g) => g.venueAccess),
      cosmeticIds,
      xp,
    },
  };
}

/** Tell the player about a promotion over the realtime channel. Never throws. */
export async function publishPromotion(
  ctx: AppContext,
  userId: string,
  p: PromotionInfo,
  now: Date = new Date(),
): Promise<void> {
  await publishToUser(ctx, userId, 'career_promoted', { ...p, at: now.getTime() });
}

/**
 * Work out, inside a shift's transaction, which ladder the shift counts for. Enrols an
 * un-enrolled player on the best ladder containing the job (their tribe's first).
 * @returns The ladder context, or null when the player has no ladder for this job.
 */
export async function ladderForShift(
  client: PoolClient,
  ctx: AppContext,
  userId: string,
  jobId: string,
  now: Date,
): Promise<ShiftLadderContext | null> {
  const cfg = laddersConfig(ctx);
  let member = await readMembership(client, userId, true);
  if (!member) {
    const tribe = await client.query<{ tribe_id: string }>(
      `SELECT tribe_id FROM characters WHERE user_id = $1`,
      [userId],
    );
    const tribeId = tribe.rows[0]?.tribe_id;
    const candidates = cfg.ladders.filter((l) => l.jobIds.includes(jobId));
    const pick = candidates.find((l) => tribeId !== undefined && l.tribeIds.includes(tribeId));
    const chosen = pick ?? candidates[0];
    if (!chosen) return null;
    await client.query(
      `INSERT INTO ladder_membership (user_id, ladder_id, joined_at, auto) VALUES ($1, $2, $3, true)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, chosen.id, now],
    );
    member = await readMembership(client, userId, true);
    if (!member) return null;
  }
  const ladder = cfg.ladders.find((l) => l.id === member.ladder_id);
  if (!ladder) return null;
  const progress = await readProgress(client, userId, ladder.id);
  const rank = ladder.ranks.find((r) => r.rank === progress.rank) ?? ladder.ranks[0]!;
  return { ladder, rank, applies: ladder.jobIds.includes(jobId) };
}

/**
 * Count a related action toward the player's current ladder. Safe to call after any commit:
 * it never throws, a repeated `ref` counts once, and a player on no ladder is ignored.
 * @param ctx - The application context.
 * @param userId - Who did the thing.
 * @param action - The action verb (a quest verb, or `airdrop_claim`, `project_found`...).
 * @param ref - A stable id of the source event.
 * @param now - The current time (injectable for tests).
 * @param counterpart - For social events: the same per-counterpart cooldown the quests use.
 * The player earns no ladder XP for this action from this counterpart again within the
 * window, so a pair of accounts cannot loop it. Checked against accepted ladder awards, so
 * it holds whether or not the player has a quest for the verb.
 */
export async function recordCareerAction(
  ctx: AppContext,
  userId: string,
  action: string,
  ref: string,
  now: Date = new Date(),
  counterpart?: { readonly key: string; readonly cooldownDays: number },
): Promise<void> {
  try {
    const cfg = laddersConfig(ctx);
    if (!cfg.ladders.some((l) => l.actionXp[action] !== undefined)) return;
    await ensureRewardCatalog(ctx.db);
    const promotion = await runInTransaction(async (client) => {
      const member = await readMembership(client, userId);
      if (!member) return null;
      const ladder = cfg.ladders.find((l) => l.id === member.ladder_id);
      const xp = ladder?.actionXp[action];
      if (!ladder || xp === undefined) return null;
      if (counterpart) {
        const since = new Date(now.getTime() - counterpart.cooldownDays * 86_400_000);
        const prior = await client.query(
          `SELECT 1 FROM ladder_xp_events
            WHERE user_id = $1 AND source = 'action' AND starts_with(ref, $2) AND created_at > $3 LIMIT 1`,
          [userId, `${action}:${counterpart.key}|`, since],
        );
        if ((prior.rowCount ?? 0) > 0) return null;
      }
      const r = await awardLadderXp(
        client,
        userId,
        ladder,
        xp,
        'action',
        counterpart ? `${action}:${counterpart.key}|${ref}` : `${action}:${ref}`,
        now,
        cfg.ladderActionXpDailyCap,
      );
      return r.promotion;
    });
    if (promotion) await publishPromotion(ctx, userId, promotion, now);
  } catch (e) {
    console.error(`[ladders] ${action} event ${ref} failed:`, (e as Error).message);
  }
}

/**
 * Give the player's current ladder some action XP inside the caller's transaction, under
 * the same rules as `recordCareerAction`: the shared daily action cap
 * (`ladderActionXpDailyCap`), and a repeated `ref` counts once. A player on no ladder gets
 * nothing (a fallback job never enrols anyone).
 * @returns The XP actually added (0 when none) and the promotion, if the rank rose.
 */
export async function awardActionXpInTx(
  client: PoolClient,
  ctx: AppContext,
  userId: string,
  amount: number,
  ref: string,
  now: Date,
): Promise<{ added: number; promotion: PromotionInfo | null }> {
  const none = { added: 0, promotion: null };
  const cfg = laddersConfig(ctx);
  const member = await readMembership(client, userId);
  if (!member) return none;
  const ladder = cfg.ladders.find((l) => l.id === member.ladder_id);
  if (!ladder) return none;
  return awardLadderXp(
    client,
    userId,
    ladder,
    amount,
    'action',
    ref,
    now,
    cfg.ladderActionXpDailyCap,
  );
}

export interface LadderRankView extends RankDef {
  readonly status: 'achieved' | 'current' | 'next' | 'locked';
}

export interface LadderView {
  readonly id: string;
  readonly name: string;
  readonly tribeIds: readonly string[];
  readonly jobIds: readonly string[];
  readonly active: boolean;
  readonly suggested: boolean;
  readonly xp: number;
  readonly rank: number;
  readonly title: string;
  readonly payBonusBps: number;
  readonly nextRank: RankDef | null;
  readonly xpToNext: number | null;
  readonly ranks: readonly LadderRankView[];
}

export interface LaddersResponse {
  readonly myLadderId: string | null;
  readonly suggestedLadderId: string | null;
  readonly joinCooldownHours: number;
  /** When the next deliberate switch is allowed; null when switching is free now. */
  readonly canSwitchAt: string | null;
  /** Cumulative venue-area flags of the ladder I am on (`venueId:area`). */
  readonly venueAccess: readonly string[];
  readonly ladders: readonly LadderView[];
}

function suggestFor(cfg: LaddersConfig, tribeId: string | undefined): LadderDef | undefined {
  return tribeId === undefined ? undefined : cfg.ladders.find((l) => l.tribeIds.includes(tribeId));
}

function switchAt(cfg: LaddersConfig, m: MembershipRow | null): Date | null {
  if (!m || m.auto) return null;
  return new Date(m.joined_at.getTime() + cfg.ladderJoinCooldownHours * 3_600_000);
}

/** Cumulative venue-area flags of a ladder up to a rank. */
export function venueAreasUpTo(ladder: LadderDef, rank: number): string[] {
  return ladder.ranks.filter((r) => r.rank <= rank).flatMap((r) => [...r.venueAccess]);
}

/** The ladders, with the caller's progress in each. */
export async function getLadders(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<LaddersResponse> {
  const cfg = laddersConfig(ctx);
  const state = await ctx.db.withConnection(async (c) => {
    const member = await readMembership(c, userId);
    const progress = await c.query<{ ladder_id: string; xp: number; rank: number }>(
      `SELECT ladder_id, xp, rank FROM ladder_progress WHERE user_id = $1`,
      [userId],
    );
    const tribe = await c.query<{ tribe_id: string }>(
      `SELECT tribe_id FROM characters WHERE user_id = $1`,
      [userId],
    );
    return { member, progress, tribeId: tribe.rows[0]?.tribe_id };
  });
  const byLadder = new Map(state.progress.rows.map((p) => [p.ladder_id, p]));
  const suggested = suggestFor(cfg, state.tribeId);
  const at = switchAt(cfg, state.member);
  const ladders = cfg.ladders.map((l): LadderView => {
    const p = byLadder.get(l.id) ?? { xp: 0, rank: 1 };
    const cur = l.ranks.find((r) => r.rank === p.rank) ?? l.ranks[0]!;
    const next = l.ranks.find((r) => r.rank === cur.rank + 1) ?? null;
    return {
      id: l.id,
      name: l.name,
      tribeIds: l.tribeIds,
      jobIds: l.jobIds,
      active: state.member?.ladder_id === l.id,
      suggested: suggested?.id === l.id,
      xp: p.xp,
      rank: cur.rank,
      title: cur.title,
      payBonusBps: cur.payBonusBps,
      nextRank: next,
      xpToNext: next ? Math.max(0, next.xpRequired - p.xp) : null,
      ranks: l.ranks.map((r) => ({
        ...r,
        status:
          r.rank < cur.rank
            ? 'achieved'
            : r.rank === cur.rank
              ? 'current'
              : r.rank === cur.rank + 1
                ? 'next'
                : 'locked',
      })),
    };
  });
  const mine = ladders.find((l) => l.active);
  const mineDef = cfg.ladders.find((l) => l.id === mine?.id);
  return {
    myLadderId: mine?.id ?? null,
    suggestedLadderId: suggested?.id ?? null,
    joinCooldownHours: cfg.ladderJoinCooldownHours,
    canSwitchAt: at && at.getTime() > now.getTime() ? at.toISOString() : null,
    venueAccess: mine && mineDef ? venueAreasUpTo(mineDef, mine.rank) : [],
    ladders,
  };
}

/** Venue-area flags the player's current ladder rank grants at one venue. */
export async function careerAreasAt(
  ctx: AppContext,
  userId: string,
  venueId: string,
): Promise<string[]> {
  const cfg = laddersConfig(ctx);
  const flags = await ctx.db.withConnection(async (c) => {
    const member = await readMembership(c, userId);
    if (!member) return [] as string[];
    const ladder = cfg.ladders.find((l) => l.id === member.ladder_id);
    if (!ladder) return [] as string[];
    const p = await readProgress(c, userId, ladder.id);
    return venueAreasUpTo(ladder, p.rank);
  });
  return flags.filter((f) => f.startsWith(`${venueId}:`)).map((f) => f.slice(venueId.length + 1));
}

export interface JoinResult {
  readonly ladderId: string;
  readonly alreadyMember: boolean;
  readonly rank: number;
  readonly title: string;
  readonly xp: number;
  readonly joinedAt: string;
  readonly nextSwitchAt: string;
}

/**
 * Join (or switch to) a ladder.
 * @throws NotFoundError for an unknown ladder.
 * @throws CareerSwitchCooldownError when the last deliberate join is too recent.
 */
export async function joinLadder(
  ctx: AppContext,
  userId: string,
  ladderId: string,
  now: Date = new Date(),
): Promise<JoinResult> {
  const cfg = laddersConfig(ctx);
  const ladder = cfg.ladders.find((l) => l.id === ladderId);
  if (!ladder) throw new NotFoundError({ kind: 'ladder', id: ladderId });
  return runInTransaction(async (client) => {
    const member = await readMembership(client, userId, true);
    let joinedAt = member?.joined_at ?? now;
    const same = member?.ladder_id === ladder.id;
    if (!same) {
      const at = switchAt(cfg, member);
      if (at && at.getTime() > now.getTime()) {
        throw new CareerSwitchCooldownError({
          retryAt: at.toISOString(),
          retryAfterMs: at.getTime() - now.getTime(),
          currentLadderId: member?.ladder_id,
        });
      }
      joinedAt = now;
      await client.query(
        `INSERT INTO ladder_membership (user_id, ladder_id, joined_at, auto) VALUES ($1, $2, $3, false)
         ON CONFLICT (user_id) DO UPDATE SET ladder_id = EXCLUDED.ladder_id,
           joined_at = EXCLUDED.joined_at, auto = false`,
        [userId, ladder.id, now],
      );
      await client.query(
        `INSERT INTO ladder_progress (user_id, ladder_id) VALUES ($1, $2)
         ON CONFLICT (user_id, ladder_id) DO NOTHING`,
        [userId, ladder.id],
      );
    }
    const p = await readProgress(client, userId, ladder.id);
    const cur = ladder.ranks.find((r) => r.rank === p.rank) ?? ladder.ranks[0]!;
    const stillAuto = same && member !== null && member.auto;
    return {
      ladderId: ladder.id,
      alreadyMember: same,
      rank: cur.rank,
      title: cur.title,
      xp: p.xp,
      joinedAt: joinedAt.toISOString(),
      nextSwitchAt: stillAuto
        ? now.toISOString()
        : new Date(joinedAt.getTime() + cfg.ladderJoinCooldownHours * 3_600_000).toISOString(),
    };
  });
}
