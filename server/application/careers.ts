/**
 * Careers service.
 *
 * Lists every career from contract/config/careers.json joined with the
 * player's stored progress (`career_progress`; level 1 / 0 XP if they
 * have never applied or worked it). Apply records the career without
 * resetting any progress already earned.
 *
 * Progression: a shift earns XP (see ShiftsService.complete); when the
 * XP inside the current level reaches that level's `xp` threshold the
 * player is promoted, the threshold is subtracted, and the next shift
 * uses the new level's pay, length and mini-game. XP keeps accruing at
 * the top level.
 */
import type { PoolClient } from 'pg';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export interface CareerLevelDef {
  readonly level: number;
  readonly payCents: number;
  readonly shiftSec: number;
  readonly xp: number;
  readonly miniGameId: string;
}

export interface CareerDef {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly phase: number;
  readonly skillGates: Readonly<Record<string, number>>;
  readonly levels: readonly CareerLevelDef[];
}

export interface CareersConfig {
  readonly version: string;
  readonly careers: readonly CareerDef[];
}

export interface CareerProgress {
  readonly level: number;
  readonly xp: number;
}

/**
 * Add `earned` XP to a career progress and apply any promotions.
 * Pure: the caller persists the result.
 */
export function addCareerXp(
  levels: readonly CareerLevelDef[],
  from: CareerProgress,
  earned: number,
): CareerProgress & { promoted: boolean } {
  let level = from.level;
  let xp = from.xp + Math.max(0, earned);
  let promoted = false;
  for (;;) {
    const threshold = levels[level - 1]?.xp;
    if (level >= levels.length || threshold === undefined || xp < threshold) break;
    xp -= threshold;
    level += 1;
    promoted = true;
  }
  return { level, xp, promoted };
}

/** Read a player's progress in one career (level 1 / 0 XP if none). */
export async function readCareerProgress(
  client: PoolClient,
  userId: string,
  careerId: string,
  forUpdate = false,
): Promise<CareerProgress> {
  const r = await client.query<{ level: number; xp: number }>(
    `SELECT level, xp FROM career_progress WHERE user_id = $1 AND career_id = $2
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [userId, careerId],
  );
  const row = r.rows[0];
  return row ? { level: row.level, xp: row.xp } : { level: 1, xp: 0 };
}

export class CareersService {
  private readonly ctx: AppContext;
  /**
   *
   */
  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** List all careers with the player's current level (1 default). */
  async list(userId: string): Promise<
    Array<{
      id: string;
      name: string;
      level: number;
      xp: number;
      payCents: number;
      shiftSec: number;
      miniGameId: string;
      active: boolean;
      phase: number;
    }>
  > {
    const cfg = this.ctx.configCache.load<CareersConfig>('careers');
    const r = await this.ctx.db.withConnection((c) =>
      c.query<{ career_id: string; level: number; xp: number }>(
        `SELECT career_id, level, xp FROM career_progress WHERE user_id = $1`,
        [userId],
      ),
    );
    const progress = new Map(r.rows.map((row) => [row.career_id, row]));
    return cfg.careers
      .filter((c) => c.active)
      .map((c) => {
        const p = progress.get(c.id);
        const level = Math.min(p?.level ?? 1, c.levels.length);
        const lvl = c.levels[level - 1];
        if (!lvl) throw new ValidationFailedError({ career: c.id });
        return {
          id: c.id,
          name: c.name,
          level,
          xp: p?.xp ?? 0,
          payCents: lvl.payCents,
          shiftSec: lvl.shiftSec,
          miniGameId: lvl.miniGameId,
          active: c.active,
          phase: c.phase,
        };
      });
  }

  /**
   * Apply to a career. Validates the skill gates; the player's
   * level is recorded for the shift scoring.
   */
  async apply(
    userId: string,
    careerId: string,
  ): Promise<{ careerId: string; level: number; xp: number; id: string }> {
    const cfg = this.ctx.configCache.load<CareersConfig>('careers');
    const career = cfg.careers.find((c) => c.id === careerId);
    if (!career) throw new NotFoundError({ kind: 'career', id: careerId });
    if (!career.active) throw new ValidationFailedError({ reason: 'career_inactive' });
    // Skill gates (M2: all open).
    for (const [skill, gate] of Object.entries(career.skillGates)) {
      const userSkill = await this.getUserSkill(userId, skill);
      if (userSkill < gate) {
        throw new ValidationFailedError({
          reason: 'skill_gate',
          skill,
          required: gate,
          actual: userSkill,
        });
      }
    }
    // Applying again (or to a career already worked) keeps the
    // progress; only a first application creates the row.
    const progress = await this.ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO career_progress (user_id, career_id) VALUES ($1, $2)
         ON CONFLICT (user_id, career_id) DO NOTHING`,
        [userId, career.id],
      );
      return readCareerProgress(c, userId, career.id);
    });
    return { careerId: career.id, level: progress.level, xp: progress.xp, id: career.id };
  }

  private async getUserSkill(_userId: string, _skill: string): Promise<number> {
    return 10; // M2: open gates.
  }
}
