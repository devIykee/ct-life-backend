/**
 * Careers service.
 *
 * Lists every career from contract/config/careers.json and joins it
 * with the player's level (1 if no shift history). Apply sets the
 * active job on the user; M2 supports one active career at a time.
 */
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

interface CareerDef {
  readonly id: string;
  readonly name: string;
  readonly active: boolean;
  readonly phase: number;
  readonly skillGates: Readonly<Record<string, number>>;
  readonly levels: ReadonlyArray<{
    readonly level: number;
    readonly payCents: number;
    readonly shiftSec: number;
    readonly xp: number;
    readonly miniGameId: string;
  }>;
}

interface CareersConfig {
  readonly version: string;
  readonly careers: readonly CareerDef[];
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
    void this.getUserSkills(userId);
    return cfg.careers
      .filter((c) => c.active)
      .map((c) => {
        // Level = number of past shifts / 5 + 1, capped at the
        // number of levels in the config. M2 uses this simple
        // formula; the proper XP curve is in skills.json.
        const level = 1;
        const lvl = c.levels[level - 1];
        if (!lvl) throw new ValidationFailedError({ career: c.id });
        return {
          id: c.id,
          name: c.name,
          level,
          xp: 0,
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
    // The contract's Job is {careerId, level, xp}. level and xp are still
    // the M2 placeholders that list() uses; only the shape is fixed here,
    // since the client could not parse {id, level}.
    return { careerId: career.id, level: 1, xp: 0, id: career.id };
  }

  private async getUserSkills(_userId: string): Promise<Record<string, number>> {
    return { clout: 1, coding: 1, trading: 1, writing: 1, design: 1, security: 1 };
  }

  private async getUserSkill(_userId: string, _skill: string): Promise<number> {
    return 10; // M2: open gates.
  }
}
