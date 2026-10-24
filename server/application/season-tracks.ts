/**
 * Season Pass tracks: a free and a paid track of tiers, filled by Season XP.
 *
 *   GET  /v1/season                          — the current season, my XP and tiers
 *   POST /v1/season/tiers/{n}/claim?track=   — claim a tier reward
 *
 * Definitions are the contract file `contract/config/season_tracks.json`:
 * tier n unlocks at n * xpPerTier XP earned inside the season window, and each
 * tier holds one reward (Cash, a reward cosmetic, or shop furniture). The
 * client never sends XP or a reward; it names a tier and a track.
 *
 * XP is the sum of `season_xp` rows created inside [startsAt, endsAt). Writers:
 * the daily/weekly quests (PR #9, source 'quest') and nod finds (source 'nod').
 *
 * A claim is one row in `season_tier_claims`, whose primary key makes it pay
 * once; the reward commits in the same transaction. The paid track needs a
 * live `season_pass` row (bought with real money through the payment intent
 * flow); it is checked at claim time, so tiers earned while the pass was live
 * but not claimed need a live pass when they are claimed.
 */
import type { PoolClient } from 'pg';
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, PassRequiredError, TierLockedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import {
  creditCash,
  ensureRewardCatalog,
  grantCosmetic,
  grantFurniture,
  readContractJson,
  type RewardCosmeticDef,
} from './rewards.js';
import { weekIso } from './season-clock.js';

export type Track = 'free' | 'paid';
export const TRACKS: readonly Track[] = ['free', 'paid'];

export type TierReward =
  | { readonly cashCents: number }
  | { readonly cosmeticId: string }
  | { readonly furnitureItemId: string };

export interface TierDef {
  readonly tier: number;
  readonly reward: TierReward;
}

export interface SeasonDef {
  readonly seasonId: string;
  readonly name: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly xpPerTier: number;
  readonly nodXp: number;
  readonly tracks: Record<Track, readonly TierDef[]>;
}

interface SeasonFile {
  readonly cosmetics: readonly RewardCosmeticDef[];
  readonly seasons: readonly SeasonDef[];
}

let file: SeasonFile | null = null;

/** The parsed `season_tracks.json`, read once per process. */
export function seasonFile(): SeasonFile {
  file ??= readContractJson<SeasonFile>('config', 'season_tracks.json');
  return file;
}

/** Re-read the file on the next call (tests). */
export function _resetSeasonFileForTests(): void {
  file = null;
}

/**
 * The season whose window holds `now`, or null.
 * @param now - The current time.
 */
export function currentSeason(now: Date): SeasonDef | null {
  const t = now.getTime();
  return (
    seasonFile().seasons.find((s) => Date.parse(s.startsAt) <= t && t < Date.parse(s.endsAt)) ??
    null
  );
}

export type TierStatus = 'locked' | 'claimable' | 'claimed' | 'pass_required';

export interface TierView {
  readonly tier: number;
  readonly xpRequired: number;
  readonly reward: TierReward;
  /** locked: not enough XP; claimable; claimed; pass_required: reached, paid track, no live pass. */
  readonly status: TierStatus;
}

export interface SeasonView {
  readonly season: {
    readonly seasonId: string;
    readonly name: string;
    readonly startsAt: string;
    readonly endsAt: string;
    readonly xpPerTier: number;
  };
  readonly xp: number;
  /** Highest tier the XP reaches (0 when none), capped at the track length. */
  readonly tier: number;
  /** XP still needed for the next tier, or null at the top. */
  readonly xpToNext: number | null;
  readonly hasPass: boolean;
  readonly tracks: Record<Track, TierView[]>;
}

/** Season XP a player earned inside the season window. */
export async function seasonXp(
  q: Pick<PoolClient, 'query'>,
  userId: string,
  s: SeasonDef,
): Promise<number> {
  const r = await q.query<{ xp: string }>(
    `SELECT COALESCE(SUM(amount), 0) AS xp FROM season_xp
      WHERE user_id = $1 AND created_at >= $2 AND created_at < $3`,
    [userId, s.startsAt, s.endsAt],
  );
  return Number(r.rows[0]?.xp ?? 0);
}

/** True while the player holds a live season pass. */
export async function hasLivePass(
  q: Pick<PoolClient, 'query'>,
  userId: string,
  now: Date,
): Promise<boolean> {
  const r = await q.query(
    `SELECT 1 FROM season_pass WHERE user_id = $1 AND tier = 'season' AND expires_at > $2`,
    [userId, now],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Record Season XP for a source event. Idempotent on (user, source, ref).
 * Quests (PR #9) write the same table with source 'quest'.
 * @returns True when the XP was newly recorded.
 */
export async function awardSeasonXp(
  client: PoolClient,
  userId: string,
  amount: number,
  source: string,
  ref: string,
  now: Date,
): Promise<boolean> {
  if (amount <= 0) return false;
  const r = await client.query(
    `INSERT INTO season_xp (user_id, amount, source, ref, season_iso, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, source, ref) DO NOTHING`,
    [userId, amount, source, ref, weekIso(now), now],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * The current season for the caller.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - The current time (injectable for tests).
 * @throws NotFoundError when no season is running.
 */
export async function getSeason(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<SeasonView> {
  const s = currentSeason(now);
  if (!s) throw new NotFoundError({ reason: 'no active season' });
  return ctx.db.withConnection(async (c) => {
    const [xp, pass, claims] = await Promise.all([
      seasonXp(c, userId, s),
      hasLivePass(c, userId, now),
      c.query<{ track: Track; tier: number }>(
        `SELECT track, tier FROM season_tier_claims WHERE user_id = $1 AND season_id = $2`,
        [userId, s.seasonId],
      ),
    ]);
    const claimed = new Set(claims.rows.map((r) => `${r.track}:${r.tier}`));
    const view = (track: Track): TierView[] =>
      s.tracks[track].map((t) => {
        const xpRequired = t.tier * s.xpPerTier;
        let status: TierStatus = 'locked';
        if (claimed.has(`${track}:${t.tier}`)) status = 'claimed';
        else if (xp >= xpRequired)
          status = track === 'paid' && !pass ? 'pass_required' : 'claimable';
        return { tier: t.tier, xpRequired, reward: t.reward, status };
      });
    const top = Math.max(...s.tracks.free.map((t) => t.tier), ...s.tracks.paid.map((t) => t.tier));
    const tier = Math.min(top, Math.floor(xp / s.xpPerTier));
    return {
      season: {
        seasonId: s.seasonId,
        name: s.name,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        xpPerTier: s.xpPerTier,
      },
      xp,
      tier,
      xpToNext: tier >= top ? null : (tier + 1) * s.xpPerTier - xp,
      hasPass: pass,
      tracks: { free: view('free'), paid: view('paid') },
    };
  });
}

export interface ClaimResult {
  readonly seasonId: string;
  readonly track: Track;
  readonly tier: number;
  readonly reward: TierReward;
  /** True when the tier was claimed before: nothing was paid this time. */
  readonly alreadyClaimed: boolean;
  readonly xp: number;
}

function rewardRef(r: TierReward): { kind: 'cash' | 'cosmetic' | 'furniture'; ref: string } {
  if ('cashCents' in r) return { kind: 'cash', ref: String(r.cashCents) };
  if ('cosmeticId' in r) return { kind: 'cosmetic', ref: r.cosmeticId };
  return { kind: 'furniture', ref: r.furnitureItemId };
}

/**
 * Claim a tier reward. Idempotent: a tier pays once, a repeat returns the same
 * answer with `alreadyClaimed: true`.
 * @param ctx - The app context.
 * @param userId - The caller (a claim only ever touches the caller's rows).
 * @param tier - The tier number.
 * @param track - 'free' or 'paid'.
 * @param now - The current time (injectable for tests).
 * @throws NotFoundError for no season or a tier not in the track.
 * @throws PassRequiredError on the paid track without a live pass.
 * @throws TierLockedError when the XP does not reach the tier yet.
 */
export async function claimTier(
  ctx: AppContext,
  userId: string,
  tier: number,
  track: Track,
  now: Date = new Date(),
): Promise<ClaimResult> {
  const s = currentSeason(now);
  if (!s) throw new NotFoundError({ reason: 'no active season' });
  const def = s.tracks[track].find((t) => t.tier === tier);
  if (!def) throw new NotFoundError({ reason: 'no such tier', tier, track });
  await ensureRewardCatalog(ctx.db);
  return runInTransaction(async (client) => {
    const base = { seasonId: s.seasonId, track, tier, reward: def.reward };
    const already = await client.query(
      `SELECT 1 FROM season_tier_claims
        WHERE user_id = $1 AND season_id = $2 AND track = $3 AND tier = $4`,
      [userId, s.seasonId, track, tier],
    );
    const xp = await seasonXp(client, userId, s);
    if ((already.rowCount ?? 0) > 0) return { ...base, alreadyClaimed: true, xp };
    if (track === 'paid' && !(await hasLivePass(client, userId, now))) {
      throw new PassRequiredError({ track, tier });
    }
    const need = tier * s.xpPerTier;
    if (xp < need) throw new TierLockedError({ tier, track, xp, xpRequired: need });
    const { kind, ref } = rewardRef(def.reward);
    const ins = await client.query(
      `INSERT INTO season_tier_claims (user_id, season_id, track, tier, reward_kind, reward_ref, claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING`,
      [userId, s.seasonId, track, tier, kind, ref, now],
    );
    if ((ins.rowCount ?? 0) === 0) return { ...base, alreadyClaimed: true, xp };
    if ('cashCents' in def.reward) {
      await creditCash(
        client,
        userId,
        def.reward.cashCents,
        'season_reward',
        'season_tier',
        `${s.seasonId}:${track}:${tier}`,
        `season-reward:${userId}:${s.seasonId}:${track}:${tier}`,
      );
    } else if ('cosmeticId' in def.reward) {
      await grantCosmetic(client, userId, def.reward.cosmeticId);
    } else {
      await grantFurniture(client, userId, def.reward.furnitureItemId);
    }
    return { ...base, alreadyClaimed: false, xp };
  });
}
