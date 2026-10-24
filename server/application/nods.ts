/**
 * Community nods: find a painted prop in the world, "photograph" it, and it
 * counts once. A filled set grants a cosmetic once. A Hunter board ranks
 * players by nods found.
 *
 *   GET  /v1/nods              — my collection and the sets
 *   POST /v1/nods/{id}/collect — collect a nod, with a proof
 *   GET  /v1/nods/leaderboard  — the Hunter board
 *
 * The registry is the FE-owned `contract/ids/nods.json` (a placeholder until
 * the frontend exports the placed positions).
 *
 * Anti-cheat. The proof is the nod id plus the client-reported position, but
 * the client's word is never what grants a find. The server reads its OWN last
 * position for the player, the one the street, venue and vehicles rooms write
 * to the `ctl:pos` presence hash while the player moves (those rooms already
 * clamp speed and bounds), and requires it to be fresh (30 s) and within the
 * nod's radius (15 m by default) of the registry position. The client position
 * is only a consistency check (a client far from where the server saw it is
 * refused). Attempts are rate limited per player (10 burst, 12 per minute),
 * successful or not, so walking the nod list with a spoofed id costs tokens.
 * XP and rewards come from the config, never from the request.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  NodTooFarError,
  NotFoundError,
  PositionUnknownError,
  RateLimitedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import { decodePos, POS_FRESH_MS, POS_HASH } from '../realtime/movement.js';
import type { AppContext } from './context.js';
import { ensureRewardCatalog, grantCosmetic, readContractJson } from './rewards.js';
import { awardSeasonXp, currentSeason } from './season-tracks.js';

export interface NodDef {
  readonly nodId: string;
  readonly name: string;
  readonly setId: string;
  readonly tier: 'A' | 'B' | 'C';
  readonly district: string;
  readonly x: number;
  readonly z: number;
  readonly radiusM?: number;
}

export interface NodSetDef {
  readonly setId: string;
  readonly name: string;
  readonly reward: { readonly cosmeticId: string };
}

interface NodsFile {
  readonly defaultRadiusM: number;
  readonly sets: readonly NodSetDef[];
  readonly nods: readonly NodDef[];
}

/** Collect attempts per player: burst, then refill per second (12 a minute). */
export const COLLECT_BURST = 10;
export const COLLECT_REFILL_PER_SEC = 0.2;
/** The client position may differ from the server's by this much (metres). */
export const CLIENT_POS_TOLERANCE_M = 30;
export const LEADERBOARD_SIZE = 50;

let file: NodsFile | null = null;

/** The parsed `nods.json`, read once per process. */
export function nodsFile(): NodsFile {
  file ??= readContractJson<NodsFile>('ids', 'nods.json');
  return file;
}

/** Re-read the registry on the next call (tests). */
export function _resetNodsFileForTests(): void {
  file = null;
}

export interface NodProof {
  readonly nodId: string;
  readonly x: number;
  readonly z: number;
}

export interface CollectResult {
  readonly nodId: string;
  /** True when this nod was already in the collection: nothing was paid. */
  readonly alreadyCollected: boolean;
  /** Season XP awarded by this find (0 on a repeat or when no season runs). */
  readonly xp: number;
  readonly set: {
    readonly setId: string;
    readonly collected: number;
    readonly total: number;
    readonly completed: boolean;
  };
  /** The cosmetic granted because this find filled the set, else null. */
  readonly setReward: { readonly setId: string; readonly cosmeticId: string } | null;
}

function setProgress(
  setId: string,
  found: ReadonlySet<string>,
): { setId: string; collected: number; total: number; completed: boolean } {
  const members = nodsFile().nods.filter((n) => n.setId === setId);
  const collected = members.filter((n) => found.has(n.nodId)).length;
  return { setId, collected, total: members.length, completed: collected === members.length };
}

async function foundSet(
  q: { query: (sql: string, p: unknown[]) => Promise<{ rows: { nod_id: string }[] }> },
  userId: string,
): Promise<Set<string>> {
  const r = await q.query(`SELECT nod_id FROM collected_nods WHERE user_id = $1`, [userId]);
  return new Set(r.rows.map((x) => x.nod_id));
}

/**
 * Collect a nod.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param nodId - The nod from the path.
 * @param proof - The body: the nod id (must match the path) and the client position.
 * @param now - The current time (injectable for tests).
 * @throws NotFoundError for an id not in the registry.
 * @throws ValidationFailedError when the proof names another nod or the client
 *   position disagrees with the server's.
 * @throws RateLimitedError when the player is attempting too fast.
 * @throws PositionUnknownError when the server has no fresh position.
 * @throws NodTooFarError when the server position is outside the radius.
 */
export async function collectNod(
  ctx: AppContext,
  userId: string,
  nodId: string,
  proof: NodProof,
  now: Date = new Date(),
): Promise<CollectResult> {
  const reg = nodsFile();
  const nod = reg.nods.find((n) => n.nodId === nodId);
  if (!nod) throw new NotFoundError({ reason: 'unknown nod' });
  if (proof.nodId !== nodId) {
    throw new ValidationFailedError({ reason: 'proof.nodId must match the path' });
  }
  const decision = await perUserTokenBucket(
    ctx.redis.main,
    `rl:nod:${userId}`,
    COLLECT_BURST,
    COLLECT_REFILL_PER_SEC,
  );
  if (!decision.allowed) {
    throw new RateLimitedError(decision.retryAfterMs, { limit: '12/min' });
  }

  // A repeat is a plain replay: it needs no position and pays nothing.
  const found = await ctx.db.withConnection((c) => foundSet(c, userId));
  if (found.has(nodId)) {
    return {
      nodId,
      alreadyCollected: true,
      xp: 0,
      set: setProgress(nod.setId, found),
      setReward: null,
    };
  }

  const server = decodePos(await ctx.redis.main.hget(POS_HASH, userId));
  if (!server || now.getTime() - server.at > POS_FRESH_MS) {
    throw new PositionUnknownError({ reason: 'no fresh position' });
  }
  const radius = nod.radiusM ?? reg.defaultRadiusM;
  const distance = Math.hypot(server.x - nod.x, server.z - nod.z);
  if (distance > radius) {
    throw new NodTooFarError({ radiusM: radius, distanceM: Math.round(distance) });
  }
  if (Math.hypot(proof.x - server.x, proof.z - server.z) > CLIENT_POS_TOLERANCE_M) {
    throw new ValidationFailedError({ reason: 'position_mismatch' });
  }

  await ensureRewardCatalog(ctx.db);
  const season = currentSeason(now);
  const setDef = reg.sets.find((s) => s.setId === nod.setId);
  return runInTransaction(async (client) => {
    const ins = await client.query(
      `INSERT INTO collected_nods (user_id, nod_id, collected_at) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [userId, nodId, now],
    );
    const mine = await foundSet(client, userId);
    const set = setProgress(nod.setId, mine);
    if ((ins.rowCount ?? 0) === 0) {
      return { nodId, alreadyCollected: true, xp: 0, set, setReward: null };
    }
    let xp = 0;
    if (season && season.nodXp > 0) {
      const added = await awardSeasonXp(client, userId, season.nodXp, 'nod', nodId, now);
      if (added) xp = season.nodXp;
    }
    let setReward: CollectResult['setReward'] = null;
    if (set.completed && setDef) {
      const g = await client.query(
        `INSERT INTO nod_set_grants (user_id, set_id, granted_at) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [userId, setDef.setId, now],
      );
      if ((g.rowCount ?? 0) > 0) {
        await grantCosmetic(client, userId, setDef.reward.cosmeticId);
        setReward = { setId: setDef.setId, cosmeticId: setDef.reward.cosmeticId };
      }
    }
    return { nodId, alreadyCollected: false, xp, set, setReward };
  });
}

export interface NodsView {
  readonly total: number;
  readonly collected: number;
  readonly sets: {
    readonly setId: string;
    readonly name: string;
    readonly reward: { readonly cosmeticId: string };
    readonly total: number;
    readonly collected: number;
    readonly completed: boolean;
    readonly rewardGranted: boolean;
    readonly nods: {
      readonly nodId: string;
      readonly name: string;
      readonly tier: string;
      readonly found: boolean;
      readonly collectedAt: string | null;
    }[];
  }[];
}

/**
 * My collection book: every set with its nods and what I found. Positions are
 * not part of the answer.
 * @param ctx - The app context.
 * @param userId - The caller.
 */
export async function getCollection(ctx: AppContext, userId: string): Promise<NodsView> {
  const reg = nodsFile();
  const { mine, granted } = await ctx.db.withConnection(async (c) => {
    const f = await c.query<{ nod_id: string; collected_at: Date }>(
      `SELECT nod_id, collected_at FROM collected_nods WHERE user_id = $1`,
      [userId],
    );
    const g = await c.query<{ set_id: string }>(
      `SELECT set_id FROM nod_set_grants WHERE user_id = $1`,
      [userId],
    );
    return {
      mine: new Map(f.rows.map((r) => [r.nod_id, r.collected_at])),
      granted: new Set(g.rows.map((r) => r.set_id)),
    };
  });
  const sets = reg.sets.map((s) => {
    const members = reg.nods.filter((n) => n.setId === s.setId);
    const nods = members.map((n) => ({
      nodId: n.nodId,
      name: n.name,
      tier: n.tier,
      found: mine.has(n.nodId),
      collectedAt: mine.get(n.nodId)?.toISOString() ?? null,
    }));
    const collected = nods.filter((n) => n.found).length;
    return {
      setId: s.setId,
      name: s.name,
      reward: s.reward,
      total: nods.length,
      collected,
      completed: collected === nods.length,
      rewardGranted: granted.has(s.setId),
      nods,
    };
  });
  return {
    total: reg.nods.length,
    collected: sets.reduce((a, s) => a + s.collected, 0),
    sets,
  };
}

export interface HunterRow {
  readonly rank: number;
  readonly userId: string;
  readonly alias: string;
  readonly count: number;
}

export interface Leaderboard {
  readonly total: number;
  readonly top: HunterRow[];
  /** The caller's row, or null when they have found nothing. */
  readonly me: HunterRow | null;
}

/**
 * The Hunter board: most nods found first, ties broken by who got there first
 * (earliest latest find). Counts only nods that are still in the registry.
 * @param ctx - The app context.
 * @param userId - The caller, for the `me` row.
 */
export async function leaderboard(ctx: AppContext, userId: string): Promise<Leaderboard> {
  const ids = nodsFile().nods.map((n) => n.nodId);
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{ user_id: string; alias: string | null; cnt: string; rank: string }>(
      `WITH t AS (
         SELECT user_id, COUNT(*) AS cnt, MAX(collected_at) AS last_at
           FROM collected_nods WHERE nod_id = ANY($1::text[]) GROUP BY user_id
       ), ranked AS (
         SELECT t.user_id, t.cnt, ROW_NUMBER() OVER (ORDER BY t.cnt DESC, t.last_at ASC, t.user_id) AS rank
           FROM t
       )
       SELECT r.user_id, ch.alias, r.cnt, r.rank
         FROM ranked r LEFT JOIN characters ch ON ch.user_id = r.user_id
        WHERE r.rank <= $2 OR r.user_id = $3
        ORDER BY r.rank`,
      [ids, LEADERBOARD_SIZE, userId],
    );
    const rows: HunterRow[] = r.rows.map((x) => ({
      rank: Number(x.rank),
      userId: x.user_id,
      alias: x.alias ?? '',
      count: Number(x.cnt),
    }));
    return {
      total: ids.length,
      top: rows.filter((x) => x.rank <= LEADERBOARD_SIZE),
      me: rows.find((x) => x.userId === userId) ?? null,
    };
  });
}
