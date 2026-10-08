/**
 * Shifts service.
 *
 * M2: shifts are stored in-memory (a per-process Map) since they
 * are short-lived and do not survive process restart. M5 will
 * move them to Redis with a TTL.
 *
 * Start creates a shift with `endsAt = now + shiftSec` and the
 * career's level-1 mini-game set. Complete returns SHIFT_NOT_FINISHED
 * if the shift has not yet ended, computes the pay from the
 * mini-game score (capped at the maxScore from mini_games.json),
 * and writes a ledger entry.
 */
import {
  NotFoundError,
  ShiftNotFinishedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { runInTransaction } from '../shared/db/uow.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import type { AppContext } from './context.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Shift {
  readonly shiftId: string;
  readonly userId: string;
  readonly careerId: string;
  readonly miniGameId: string;
  readonly payCents: number;
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
   * Start a shift. M2 uses the level-1 pay and mini-game from the
   * career config; the player's level is fixed at 1.
   */
  async start(
    userId: string,
    careerId: string,
  ): Promise<{ shiftId: string; miniGameIds: string[]; endsAt: string }> {
    const careers = this.ctx.configCache.load<{
      careers: Array<{
        id: string;
        levels: Array<{ level: number; payCents: number; shiftSec: number; miniGameId: string }>;
      }>;
    }>('careers');
    const career = careers.careers.find((c) => c.id === careerId);
    if (!career) throw new NotFoundError({ kind: 'career', id: careerId });
    const lvl = career.levels[0];
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
  ): Promise<{ payCents: number; xp: number; promoted: boolean }> {
    const shift = _shifts.get(shiftId);
    if (!shift) throw new NotFoundError({ kind: 'shift', id: shiftId });
    if (shift.userId !== userId) throw new NotFoundError({ kind: 'shift', id: shiftId });
    if (shift.completed) throw new NotFoundError({ kind: 'shift_completed', id: shiftId });
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
    const payCents = Math.round(shift.payCents * ratio);
    // Persist the payment in a SERIALIZABLE transaction with a
    // ledger entry.
    await runInTransaction(async (client) => {
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
      // B18 fix: Update last_action_at to shift completion time so decay doesn't accumulate during shift
      await client.query(`UPDATE needs SET last_action_at = now() WHERE user_id = $1`, [userId]);
    });
    _shifts.set(shiftId, { ...shift, completed: true });
    return { payCents, xp: Math.round(ratio * 100), promoted: false };
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
