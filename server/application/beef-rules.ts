/**
 * CT Beef pure rules (unlock A6): the config shape, the arena-crowd split,
 * the activity score and the Elo update. No I/O; see ratio-arena.ts (match
 * lifecycle), beef-close.ts (phases, close, reward), beef-votes.ts (votes)
 * and beef-activity.ts (in-arena counters).
 */
import type { AppContext } from './context.js';

export interface BeefConfig {
  readonly version?: string;
  readonly topics: ReadonlyArray<{ id: string; label: string }>;
  readonly phases: { openSeconds: number; activeSeconds: number; votingSeconds: number };
  readonly reward: {
    winnerCents: number;
    maxRewardedWinsPerDay: number;
    maxRewardedWinsPerPairPerDay: number;
    minAccountAgeHours: number;
    minPlayerVotes: number;
  };
  readonly participants: { minAccountAgeHours: number; minShiftDays: number };
  readonly elo: { start: number; kFactor: number; maxRatedMatchesPerPairPerDay: number };
  readonly crowd: {
    npcVotes: number;
    talkSecondWeight: number;
    emoteWeight: number;
    sayWeight: number;
    maxTalkSpanSeconds: number;
    maxScorePerParticipant: number;
  };
  readonly voters: { minAccountAgeHours: number; minShiftDays: number };
  readonly limits: {
    maxOpenPerChallenger: number;
    inviteCooldownSeconds: number;
    maxInvitesPerSenderPerHour: number;
    maxNotificationsPerTargetPerHour: number;
  };
}

export interface Activity {
  readonly talkSeconds: number;
  readonly emotes: number;
  readonly says: number;
}

/** @returns contract/config/beef_topics.json. */
export function beefConfig(ctx: AppContext): BeefConfig {
  return ctx.configCache.load<BeefConfig>('beef_topics');
}

/**
 * A participant's in-arena performance during `active`, capped so it cannot
 * be ground out.
 * @param cfg - The config.
 * @param a - The counters.
 */
export function activityScore(cfg: BeefConfig, a: Activity): number {
  const c = cfg.crowd;
  const raw = a.talkSeconds * c.talkSecondWeight + a.emotes * c.emoteWeight + a.says * c.sayWeight;
  return Math.max(0, Math.min(c.maxScorePerParticipant, raw));
}

/**
 * Split the NPC arena crowd between the two participants by activity score.
 * Each side gets floor(n x its share); the leftover goes to the busier side,
 * and abstains on a tie. Nobody active: no crowd votes. Deterministic.
 * @param n - Crowd size.
 * @param challengerScore - Challenger activity score.
 * @param accepterScore - Accepter activity score.
 * @returns `{challenger, accepter}` votes.
 */
export function crowdSplit(
  n: number,
  challengerScore: number,
  accepterScore: number,
): { challenger: number; accepter: number } {
  const total = challengerScore + accepterScore;
  if (n <= 0 || total <= 0) return { challenger: 0, accepter: 0 };
  let challenger = Math.floor((n * challengerScore) / total);
  let accepter = Math.floor((n * accepterScore) / total);
  const left = n - challenger - accepter;
  if (challengerScore > accepterScore) challenger += left;
  else if (accepterScore > challengerScore) accepter += left;
  return { challenger, accepter };
}

/**
 * Standard Elo with K, clamped to [0, 3000].
 * @param challengerPre - Challenger rating before.
 * @param accepterPre - Accepter rating before.
 * @param result - 1 challenger won, 0 accepter won, 0.5 draw.
 * @param k - K-factor.
 * @returns The two ratings after.
 */
export function eloAfter(
  challengerPre: number,
  accepterPre: number,
  result: 0 | 0.5 | 1,
  k: number,
): { challenger: number; accepter: number } {
  const expected = 1 / (1 + Math.pow(10, (accepterPre - challengerPre) / 400));
  const delta = Math.round(k * (result - expected));
  const clamp = (e: number): number => Math.max(0, Math.min(3000, e));
  return { challenger: clamp(challengerPre + delta), accepter: clamp(accepterPre - delta) };
}

/**
 * @param now - Now.
 * @returns The start of the current UTC day.
 */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
