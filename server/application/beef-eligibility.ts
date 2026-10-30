/**
 * CT Beef, client-facing reads (unlock A6 contract gaps):
 *
 *   GET /v1/config            `beef` block (null while the `beef` capability is off)
 *   GET /v1/beef/eligibility  may the caller open or accept a beef, and how far along they are
 *
 * Both read the same gates the write paths enforce (ratio-arena.ts
 * `assertParticipantEligible`, the sybil jail check in open/accept), so the client can
 * show progress instead of waiting for a 403. Nothing here writes.
 */
import type { AppContext } from './context.js';
import { isCapabilityOn } from './capabilities.js';
import { beefConfig } from './beef-rules.js';
import { playerStanding } from './ratio-arena.js';
import { isSybilJailed } from './sybil-jail.js';
import { NotFoundError } from '../shared/domain/errors.js';

export interface BeefClientConfig {
  readonly version: string;
  readonly topics: ReadonlyArray<{ id: string; label: string }>;
  /** House-paid reward for a rewarded win (Cash cents). */
  readonly winnerRewardCents: number;
  /** Rewarded wins per player per UTC day. */
  readonly maxRewardedWinsPerDay: number;
  /** Participant gate: account age to open or accept a beef. */
  readonly minAccountAgeHours: number;
  /** Participant gate: distinct UTC days with a paid server-timed shift. */
  readonly minShiftDays: number;
  /** The gate to vote (may differ from the participant gate). */
  readonly voters: { readonly minAccountAgeHours: number; readonly minShiftDays: number };
}

/**
 * The parts of beef_topics.json the client shows.
 * @param ctx - The app context.
 * @returns The block, or null while `beef` is off.
 */
export function beefClientConfig(ctx: AppContext): BeefClientConfig | null {
  if (!isCapabilityOn(ctx, 'beef')) return null;
  const c = beefConfig(ctx);
  return {
    version: c.version ?? '1.0.0',
    topics: c.topics.map((t) => ({ id: t.id, label: t.label })),
    winnerRewardCents: c.reward.winnerCents,
    maxRewardedWinsPerDay: c.reward.maxRewardedWinsPerDay,
    minAccountAgeHours: c.participants.minAccountAgeHours,
    minShiftDays: c.participants.minShiftDays,
    voters: {
      minAccountAgeHours: c.voters.minAccountAgeHours,
      minShiftDays: c.voters.minShiftDays,
    },
  };
}

/** Same strings as the refusals: 403 FORBIDDEN {reason} and 403 SYBIL_JAILED. */
export type BeefIneligibleReason = 'too_new' | 'shift_days' | 'sybil_jailed';

export interface BeefEligibility {
  readonly eligible: boolean;
  readonly accountAgeOk: boolean;
  readonly minAccountAgeHours: number;
  /** When the account passes the age gate (ISO). */
  readonly accountAgeOkAt: string;
  readonly shiftDays: number;
  readonly requiredShiftDays: number;
  readonly reasons: BeefIneligibleReason[];
}

/**
 * Whether the caller may open or accept a beef right now (the participant gate).
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - Injectable clock.
 * @throws NotFoundError for an unknown user.
 */
export async function beefEligibility(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<BeefEligibility> {
  const cfg = beefConfig(ctx).participants;
  return ctx.db.withConnection(async (c) => {
    const me = await playerStanding(c, userId);
    if (!me) throw new NotFoundError({ kind: 'user', id: userId });
    const okAt = new Date(me.created_at.getTime() + cfg.minAccountAgeHours * 3_600_000);
    const accountAgeOk = now.getTime() >= okAt.getTime();
    const reasons: BeefIneligibleReason[] = [];
    if (!accountAgeOk) reasons.push('too_new');
    if (me.shiftDays < cfg.minShiftDays) reasons.push('shift_days');
    if (await isSybilJailed(c, userId, now)) reasons.push('sybil_jailed');
    return {
      eligible: reasons.length === 0,
      accountAgeOk,
      minAccountAgeHours: cfg.minAccountAgeHours,
      accountAgeOkAt: okAt.toISOString(),
      shiftDays: me.shiftDays,
      requiredShiftDays: cfg.minShiftDays,
      reasons,
    };
  });
}
