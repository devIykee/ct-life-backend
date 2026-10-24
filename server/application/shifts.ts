/**
 * Shifts service.
 *
 * M2: shifts are stored in-memory (a per-process Map) since they
 * are short-lived and do not survive process restart. M5 will
 * move them to Redis with a TTL.
 *
 * Start creates a shift with `endsAt = now + shiftSec` from the
 * player's current level in that career (`career_progress`). Complete
 * returns SHIFT_NOT_FINISHED if the shift has not yet ended, computes
 * the pay from the mini-game score (capped at the maxScore from
 * mini_games.json), and in one transaction writes the ledger entry and
 * the earned XP, promoting the player when the level threshold is hit.
 */
import {
  NotFoundError,
  ShiftNotFinishedError,
  ValidationFailedError,
  ConflictError,
} from '../shared/domain/errors.js';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { addCareerXp, readCareerProgress, type CareersConfig } from './careers.js';
import {
  awardLadderXp,
  ladderForShift,
  payBonusCents,
  publishPromotion,
  type PromotionInfo,
} from './ladders.js';
import { ensureRewardCatalog } from './rewards.js';
import { recordQuestEvent } from './quests.js';
import type { AppContext } from './context.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Shift {
  readonly shiftId: string;
  readonly userId: string;
  readonly careerId: string;
  readonly miniGameId: string;
  readonly payCents: number;
  readonly level: number;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly completed: boolean;
}

const _shifts = new Map<string, Shift>();

// B16: Export for active shift checking in /me endpoint
export { _shifts };

interface MiniGameDef {
  readonly id: string;
  readonly careerId: string;
  readonly maxScore: number;
  readonly durationSec: number;
}

export class ShiftsService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Start a shift at the player's current level in the career: that
   * level's pay, length and mini-game.
   */
  async start(
    userId: string,
    careerId: string,
  ): Promise<{ shiftId: string; miniGameIds: string[]; endsAt: string }> {
    const careers = this.ctx.configCache.load<CareersConfig>('careers');
    const career = careers.careers.find((c) => c.id === careerId);
    if (!career) throw new NotFoundError({ kind: 'career', id: careerId });
    const progress = await this.ctx.db.withConnection((c) =>
      readCareerProgress(c, userId, careerId),
    );
    const level = Math.min(progress.level, career.levels.length);
    const lvl = career.levels[level - 1];
    if (!lvl) throw new ValidationFailedError({ career: careerId });
    const shiftId = uuidv7();
    const now = Date.now();
    const endsAt = now + lvl.shiftSec * 1000;
    _shifts.set(shiftId, {
      shiftId,
      userId,
      careerId,
      miniGameId: lvl.miniGameId,
      payCents: lvl.payCents,
      level,
      startedAt: now,
      endsAt,
      completed: false,
    });
    return { shiftId, miniGameIds: [lvl.miniGameId], endsAt: new Date(endsAt).toISOString() };
  }

  /**
   * Complete a shift. Validates: shift exists, is the caller's,
   * is not already complete, and `now >= endsAt`. Caps each score
   * at the mini-game's `maxScore` from contract/ids/mini_games.json.
   * B4 fix: Rejects results for mini-games not assigned to this shift.
   */
  async complete(
    userId: string,
    shiftId: string,
    results: Array<{ miniGameId: string; score: number }>,
  ): Promise<{
    payCents: number;
    xp: number;
    promoted: boolean;
    ladder?: {
      ladderId: string;
      rank: number;
      title: string;
      bonusCents: number;
      xpAdded: number;
      promoted: boolean;
    };
  }> {
    const shift = _shifts.get(shiftId);
    if (!shift) throw new NotFoundError({ kind: 'shift', id: shiftId });
    if (shift.userId !== userId) throw new NotFoundError({ kind: 'shift', id: shiftId });
    // B2 fix: Return 409 on duplicate completion (idempotent receipt)
    if (shift.completed) {
      throw new ConflictError({
        shiftId,
        reason: 'shift_already_completed',
      });
    }
    if (Date.now() < shift.endsAt) {
      throw new ShiftNotFinishedError({ shiftId, endsAt: shift.endsAt });
    }
    // B4 fix: Reject results for mini-games not assigned to this shift
    const assignedGameIds = new Set([shift.miniGameId]);
    for (const r of results) {
      if (!assignedGameIds.has(r.miniGameId)) {
        throw new ValidationFailedError({
          reason: 'mini_game_not_assigned',
          miniGameId: r.miniGameId,
          shiftId,
        });
      }
    }
    // Cap scores at the mini-game's maxScore.
    const games = this.loadMiniGames();
    let totalScore = 0;
    let maxPossible = 0;
    for (const r of results) {
      const g = games.find((x) => x.id === r.miniGameId);
      const cap = g?.maxScore ?? 100;
      const clamped = Math.max(0, Math.min(r.score, cap));
      totalScore += clamped;
      maxPossible += cap;
    }
    const ratio = maxPossible > 0 ? totalScore / maxPossible : 0;
    const basePayCents = Math.round(shift.payCents * ratio);
    const xp = Math.round(ratio * 100);
    const career = this.ctx.configCache
      .load<CareersConfig>('careers')
      .careers.find((c) => c.id === shift.careerId);
    if (!career) throw new NotFoundError({ kind: 'career', id: shift.careerId });
    // Claim the shift before the first await so a second complete with
    // a different Idempotency-Key cannot pay or award XP twice.
    _shifts.set(shiftId, { ...shift, completed: true });
    let promoted = false;
    let payCents = basePayCents;
    let ladderOut: {
      ladderId: string;
      rank: number;
      title: string;
      bonusCents: number;
      xpAdded: number;
      promoted: boolean;
    } | null = null;
    let promotion: PromotionInfo | null = null;
    const now = new Date();
    await ensureRewardCatalog(this.ctx.db);
    try {
      // Pay, ledger entry and XP land together in one SERIALIZABLE
      // transaction.
      await runInTransaction(async (client) => {
        // The player's career ladder adds its rank's pay bonus to shifts of its jobs and
        // takes the shift's XP, in this same transaction.
        const lc = await ladderForShift(client, this.ctx, userId, shift.careerId, now);
        const bonusCents = lc?.applies ? payBonusCents(basePayCents, lc.rank.payBonusBps) : 0;
        payCents = basePayCents + bonusCents;
        await client.query(
          `INSERT INTO balances (user_id, cash_cents) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET cash_cents = balances.cash_cents + EXCLUDED.cash_cents, updated_at = now()`,
          [userId, payCents],
        );
        await client.query(
          `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
           VALUES ($1, $2, 'cash', 'shift_pay', 'shift', $3, $4)`,
          [userId, payCents, shiftId, `shift:${shiftId}`],
        );
        const before = await readCareerProgress(client, userId, shift.careerId, true);
        const after = addCareerXp(career.levels, before, xp);
        promoted = after.promoted;
        await client.query(
          `INSERT INTO career_progress (user_id, career_id, level, xp) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, career_id)
           DO UPDATE SET level = EXCLUDED.level, xp = EXCLUDED.xp, updated_at = now()`,
          [userId, shift.careerId, after.level, after.xp],
        );
        // B18 fix: Update last_action_at to shift completion time so decay doesn't accumulate during shift
        await client.query(`UPDATE needs SET last_action_at = now() WHERE user_id = $1`, [userId]);
        promotion = null;
        ladderOut = null;
        if (lc?.applies) {
          const r = await awardLadderXp(client, userId, lc.ladder, xp, 'shift', shiftId, now);
          promotion = r.promotion;
          ladderOut = {
            ladderId: lc.ladder.id,
            rank: promotion?.toRank ?? lc.rank.rank,
            title: promotion?.title ?? lc.rank.title,
            bonusCents,
            xpAdded: r.added,
            promoted: promotion !== null,
          };
        }
      });
    } catch (e) {
      _shifts.set(shiftId, shift);
      throw e;
    }
    if (promotion) await publishPromotion(this.ctx, userId, promotion, now);
    await recordQuestEvent(this.ctx, userId, 'shift_complete', `shift:${shiftId}`);
    return ladderOut ? { payCents, xp, promoted, ladder: ladderOut } : { payCents, xp, promoted };
  }

  private loadMiniGames(): MiniGameDef[] {
    const path = join(REPO_ROOT, 'contract', 'ids', 'mini_games.json');
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { miniGames?: MiniGameDef[] };
      return parsed.miniGames ?? [];
    } catch {
      return [];
    }
  }
}
