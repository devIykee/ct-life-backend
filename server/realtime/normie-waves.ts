/**
 * Normie market waves (spec NPC table: "Normie (exit liquidity) arrives in
 * waves at market peaks"; FE ask 2026-11-01).
 *
 * While the market mood (`getMoodBps`: the volume-weighted 5m change of the
 * in-game coins, the same number the city room sends as `mood` and the
 * home screen shows) is at or above `peakBps`, a venue that hosts waves
 * spawns 2-4 normies on free spots. They stay a few minutes and leave
 * early when the mood drops below `calmBps`. One wave at a time, and a
 * cooldown between wave starts so a long peak cannot spam the room.
 *
 * Pure state machine: the room passes the clock, the mood, the rng and the
 * free spots on every step and applies the returned actions to its state.
 * Nothing here reads the database, the wall clock or the room.
 */
import type { Rng } from '../../packages/npc-brain/src/rng.js';
import { MAX_NPCS_PER_INSTANCE, NPC_PHASE2 } from './npc-roster.js';

/** Venues that get normie waves (the spec's trading venues). */
export const NORMIE_WAVE_VENUES: readonly string[] = [
  'timeline_square',
  'terminal_cafe',
  'launchpad_tower',
];

/** archetypes.json `normie.maxPerInstance`. */
export const NORMIE_MAX_PER_INSTANCE = 4;

export interface NormieWaveConfig {
  /** Mood (bps) at or above which a wave may start. */
  readonly peakBps: number;
  /** Mood (bps) below which every normie leaves. */
  readonly calmBps: number;
  readonly minSize: number;
  readonly maxSize: number;
  /** How long a normie stays, at least and at most (ms). */
  readonly minStayMs: number;
  readonly maxStayMs: number;
  /** Minimum time between two wave starts (ms). */
  readonly cooldownMs: number;
  /** How long a leaving normie walks to the exit before it is removed (ms). */
  readonly leaveWalkMs: number;
  /** Normies in the room at once. */
  readonly maxPerInstance: number;
  /** NPCs in the room at once, normies included. */
  readonly roomCap: number;
}

export const DEFAULT_NORMIE_WAVES: NormieWaveConfig = {
  peakBps: 300, // +3% (the Doomposter turns up at -2%)
  calmBps: 100,
  minSize: 2,
  maxSize: 4,
  minStayMs: 3 * 60_000,
  maxStayMs: 5 * 60_000,
  cooldownMs: 15 * 60_000,
  leaveWalkMs: 5_000,
  maxPerInstance: NORMIE_MAX_PER_INSTANCE,
  roomCap: MAX_NPCS_PER_INSTANCE,
};

/** A spot a normie may take, with the anim it holds there. */
export interface FreeSpot {
  readonly spotId: string;
  readonly animId: string;
}

export interface NormieStepInput {
  readonly nowMs: number;
  readonly moodBps: number;
  /** NPCs in the room right now, normies (leaving ones too) included. */
  readonly npcCount: number;
  /** Spots no player or NPC holds, best first. */
  readonly freeSpots: readonly FreeSpot[];
  readonly rng: Rng;
}

export type LeaveReason = 'mood' | 'timeout' | 'yield';

export interface NormieStep {
  readonly spawn: ReadonlyArray<{ npcId: string; spotId: string; animId: string }>;
  readonly leave: ReadonlyArray<{ npcId: string; reason: LeaveReason }>;
  /** Leaving normies that reached the exit: delete them from the room. */
  readonly remove: readonly string[];
}

/**
 * Whether a venue room hosts normie waves.
 * @param venueId - The venue.
 * @param livePhase - The deployment's release phase (LIVE_PHASE).
 */
export function hostsNormieWaves(venueId: string, livePhase: number): boolean {
  return livePhase >= NPC_PHASE2 && NORMIE_WAVE_VENUES.includes(venueId);
}

/** One room's normie waves. */
export class NormieWaves {
  /** npcId -> when it leaves on its own. */
  private readonly present = new Map<string, number>();
  /** npcId -> when it is removed (walking to the exit). */
  private readonly leaving = new Map<string, number>();
  private lastWaveAtMs = Number.NEGATIVE_INFINITY;
  private seq = 0;

  /**
   * @param cfg - Thresholds and limits (tests shrink the timers).
   */
  constructor(private readonly cfg: NormieWaveConfig = DEFAULT_NORMIE_WAVES) {}

  /** Normies in the room that are not leaving. */
  get presentCount(): number {
    return this.present.size;
  }

  /**
   * True for a normie of this room that is still in it (present or leaving).
   * @param npcId - An npcId.
   */
  has(npcId: string): boolean {
    return this.present.has(npcId) || this.leaving.has(npcId);
  }

  /**
   * Advance one tick.
   * @param input - Clock, mood, room occupancy, free spots and the rng.
   * @returns What the room must spawn, send to the exit and remove.
   */
  step(input: NormieStepInput): NormieStep {
    const { nowMs, moodBps, rng } = input;
    const remove: string[] = [];
    for (const [id, at] of this.leaving) {
      if (nowMs >= at) {
        this.leaving.delete(id);
        remove.push(id);
      }
    }

    const leave: Array<{ npcId: string; reason: LeaveReason }> = [];
    const calm = moodBps < this.cfg.calmBps;
    for (const [id, leaveAt] of this.present) {
      if (calm || nowMs >= leaveAt) {
        leave.push({ npcId: id, reason: calm ? 'mood' : 'timeout' });
        this.startLeaving(id, nowMs);
      }
    }

    const spawn: Array<{ npcId: string; spotId: string; animId: string }> = [];
    const waveOver = this.present.size === 0 && this.leaving.size === 0;
    const cooled = nowMs - this.lastWaveAtMs >= this.cfg.cooldownMs;
    if (moodBps >= this.cfg.peakBps && waveOver && cooled) {
      const want = this.cfg.minSize + rng.int(this.cfg.maxSize - this.cfg.minSize + 1);
      const room = this.cfg.roomCap - (input.npcCount - remove.length);
      const size = Math.min(want, room, this.cfg.maxPerInstance, input.freeSpots.length);
      if (size > 0) {
        this.lastWaveAtMs = nowMs;
        const span = this.cfg.maxStayMs - this.cfg.minStayMs;
        for (let k = 0; k < size; k++) {
          const spot = input.freeSpots[k]!;
          const npcId = `npc-normie-${++this.seq}`;
          this.present.set(npcId, nowMs + this.cfg.minStayMs + rng.int(span + 1));
          spawn.push({ npcId, spotId: spot.spotId, animId: spot.animId });
        }
      }
    }
    return { spawn, leave, remove };
  }

  /**
   * A player wants the normie's seat: the normie leaves now (exit liquidity
   * gives way). The room applies the leave itself.
   * @param npcId - The normie on the seat.
   * @param nowMs - The time.
   * @returns True if it was a present normie of this room.
   */
  yieldSpot(npcId: string, nowMs: number): boolean {
    if (!this.present.has(npcId)) return false;
    this.startLeaving(npcId, nowMs);
    return true;
  }

  private startLeaving(npcId: string, nowMs: number): void {
    this.present.delete(npcId);
    this.leaving.set(npcId, nowMs + this.cfg.leaveWalkMs);
  }
}
