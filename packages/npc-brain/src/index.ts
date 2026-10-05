/**
 * NPC brain — pure state machines.
 *
 * Each archetype is a deterministic state machine over the shared
 * states (idle, wander, goto, act, talk, react, follow, leave). The
 * brain does no I/O: it does not touch the DB, the realtime room,
 * or the WebSocket. The venue room drives ticks at 1 Hz (per the
 * contract) and feeds the brain via `tick(brain, ctx, dt)`. The
 * brain returns a `BrainOutput` describing what should be visible
 * to the players (a state, a spot to move to, a line to speak, an
 * emote).
 *
 * Layering: this package is pure TypeScript. It depends on the
 * domain interfaces (Clock, Rng) and on a small `VenueCtx` shape
 * that the realtime room fills in. It does NOT import from
 * server/, server/shared, or anywhere in the transport layer.
 *
 * The tests in this file run on a SimulatedClock and a SeededRng,
 * so each archetype's behavior is fully deterministic.
 */
import type { Clock } from './clock.js';
import type { Rng } from './rng.js';

export type NpcState = 'idle' | 'wander' | 'goto' | 'act' | 'talk' | 'react' | 'follow' | 'leave';

export type NpcArchetype =
  | 'town_crier'
  | 'giveaway_guy'
  | 'reply_guy'
  | 'perp_degen_npc'
  | 'rekt_guy'
  | 'wallet_tracker'
  | 'doomposter'
  | 'spaces_host'
  | 'ore_miner';

export interface VenueCtx {
  /** The venue instance id. */
  readonly instanceId: string;
  /** The current Mood (SOL 24h change, basis points). -10000 to +10000. */
  readonly moodBps: number;
  /** The richest players in the venue, by net worth (descending). */
  readonly richest: readonly { readonly userId: string; readonly netWorthCents: number }[];
  /** The most recent event payloads the brain should consider. */
  readonly recentEvents: readonly NpcEvent[];
  /** The spot the NPC is currently at (spot id from spots.json). */
  readonly currentSpotId: string | null;
  /** The target user id, if the NPC is following someone. */
  readonly followUserId: string | null;
  /** Free walkable spots the NPC may target. */
  readonly walkableSpots: readonly string[];
  /** NPC's "drained" state, set after a successful tap of Giveaway Guy. */
  readonly drainedUntilMs: number | null;
  /** True if the player who tapped Giveaway Guy paid. */
  readonly giveDropToastPending: boolean;
}

export type NpcEvent =
  | { readonly kind: 'launch'; readonly coin: string; readonly spotId: string }
  | { readonly kind: 'rug'; readonly coin: string; readonly spotId: string }
  | {
      readonly kind: 'liquidation';
      readonly perpId: string;
      readonly userId: string;
      readonly coin: string;
      readonly lossCents: number;
      readonly spotId: string;
    }
  | { readonly kind: 'motherlode'; readonly amount: number; readonly spotId: string }
  | { readonly kind: 'moodChange'; readonly bps: number };

export interface BrainOutput {
  /** New state. */
  readonly state: NpcState;
  /** Target spot if `state` is `goto` / `wander`; null otherwise. */
  readonly targetSpotId: string | null;
  /** NPC will speak this line. */
  readonly lineId: string | null;
  /** Emote ID. */
  readonly emoteId: string | null;
  /** Anim clip to play (per anims.json). */
  readonly animId: string | null;
  /** Milliseconds the brain intends to stay in this state. The room
   * uses this to schedule the next tick. */
  readonly dwellMs: number;
  /** If `state === 'follow'`, the player to follow. */
  readonly followUserId: string | null;
}

/** Context the brain needs. The room provides it. */
export interface TickCtx {
  readonly clock: Clock;
  readonly rng: Rng;
  readonly nowMs: number;
  readonly dtMs: number;
  readonly venue: VenueCtx;
}

/** Every archetype brain has the same shape. */
export interface NpcBrain {
  readonly archetype: NpcArchetype;
  readonly state: NpcState;
  readonly dwellUntilMs: number;
  readonly followUserId: string | null;
  /** Advance one tick. Returns the next BrainOutput. */
  tick(ctx: TickCtx): BrainOutput;
  /** Apply an external stimulus (e.g. an event broadcast). */
  notify(event: NpcEvent, ctx: TickCtx): BrainOutput;
  /** Reset to IDLE for re-spawn. */
  reset(): void;
}

/** Create a brain for the given archetype. */
export function createBrain(archetype: NpcArchetype): NpcBrain {
  switch (archetype) {
    case 'town_crier':
      return new TownCrierBrain();
    case 'giveaway_guy':
      return new GiveawayGuyBrain();
    case 'reply_guy':
      return new ReplyGuyBrain();
    case 'perp_degen_npc':
      return new PerpDegenBrain();
    case 'rekt_guy':
      return new RektGuyBrain();
    case 'wallet_tracker':
      return new WalletTrackerBrain();
    case 'doomposter':
      return new DoomposterBrain();
    case 'spaces_host':
      return new SpacesHostBrain();
    case 'ore_miner':
      return new OreMinerBrain();
  }
}

// --- Helpers ---------------------------------------------------------

function idleAnim(venue: VenueCtx, rng: Rng): BrainOutput {
  const dwell = 5_000 + rng.int(11_000); // 5-15s
  return {
    state: 'idle',
    targetSpotId: venue.currentSpotId,
    lineId: null,
    emoteId: null,
    animId: 'loco_idle',
    dwellMs: dwell,
    followUserId: null,
  };
}

// --- Town Crier ------------------------------------------------------
//
// Loop: IDLE -> TALK every 60-180 s, IDLE otherwise. On a server
// event, TALK immediately with the line for the event.

class TownCrierBrain implements NpcBrain {
  readonly archetype = 'town_crier' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;
  private pendingEvent: NpcEvent | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
    this.pendingEvent = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (this.pendingEvent) {
      const ev = this.pendingEvent;
      this.pendingEvent = null;
      return this.talkFor(ev, ctx);
    }
    if (ctx.nowMs >= this.dwellUntilMs) {
      // Time to talk.
      const dwell = 3_000;
      this.dwellUntilMs = ctx.nowMs + 60_000 + ctx.rng.int(120_000);
      this.state = 'talk';
      const line = this.randomCrierLine(ctx.rng);
      return {
        state: 'talk',
        targetSpotId: ctx.venue.currentSpotId,
        lineId: line,
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: dwell,
        followUserId: null,
      };
    }
    return idleAnim(ctx.venue, ctx.rng);
  }

  notify(event: NpcEvent, _ctx: TickCtx): BrainOutput {
    // Town Crier queues the event and speaks it on the next tick.
    this.pendingEvent = event;
    this.dwellUntilMs = 0;
    return {
      state: 'idle',
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 100,
      followUserId: null,
    };
  }

  private talkFor(ev: NpcEvent, ctx: TickCtx): BrainOutput {
    const line = this.lineForEvent(ev, ctx.rng);
    void ctx; // ctx is used for the line; this.state is mutated below
    this.state = 'talk';
    this.dwellUntilMs = ctx.nowMs + 3_000;
    return {
      state: 'talk',
      targetSpotId: ctx.venue.currentSpotId,
      lineId: line,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 3_000,
      followUserId: null,
    };
  }

  private randomCrierLine(rng: Rng): string {
    const lines = [
      'crier_long_liquidation',
      'crier_coin_moon',
      'crier_rug',
      'crier_motherlode',
      'crier_exploit',
      'crier_new_launch',
      'crier_tribe_control',
      'crier_turnaround',
      'crier_rich_list',
      'crier_peak_normies',
      'crier_mood_down',
      'crier_smart_close',
      'crier_rekt',
      'crier_graduation',
      'crier_air_thin',
      'crier_sleuth_thread',
    ];
    return lines[rng.int(lines.length)] ?? 'crier_long_liquidation';
  }

  private lineForEvent(ev: NpcEvent, _rng: Rng): string {
    void _rng;
    switch (ev.kind) {
      case 'liquidation':
        return 'crier_long_liquidation';
      case 'motherlode':
        return 'crier_motherlode';
      case 'rug':
        return 'crier_rug';
      case 'launch':
        return 'crier_new_launch';
      case 'moodChange':
        return ev.bps < -200 ? 'crier_mood_down' : 'crier_peak_normies';
    }
  }
}

// --- Giveaway Guy ---------------------------------------------------
//
// Loop: GOTO square_center -> TALK every 30 s. On tap, drain $50
// and toast_drained. Locked out for 10 minutes after a successful
// tap.

class GiveawayGuyBrain implements NpcBrain {
  readonly archetype = 'giveaway_guy' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (ctx.venue.drainedUntilMs !== null && ctx.nowMs < ctx.venue.drainedUntilMs) {
      return idleAnim(ctx.venue, ctx.rng);
    }
    if (this.state === 'idle') {
      // Goto square_center.
      this.state = 'goto';
      this.dwellUntilMs = ctx.nowMs + 5_000;
      return {
        state: 'goto',
        targetSpotId: 'square_center',
        lineId: null,
        emoteId: null,
        animId: 'loco_walk',
        dwellMs: 5_000,
        followUserId: null,
      };
    }
    if (this.state === 'goto' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return {
        state: 'talk',
        targetSpotId: 'square_center',
        lineId: 'giveaway_pitch',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 3_000,
        followUserId: null,
      };
    }
    if (this.state === 'talk' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'idle';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return idleAnim(ctx.venue, ctx.rng);
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }

  notify(_event: NpcEvent, _ctx: TickCtx): BrainOutput {
    return {
      state: this.state,
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }
}

// --- Reply Guy ------------------------------------------------------
//
// Loop: FOLLOW the richest player; every 20 s, TALK + an emote.
// If the target leaves, pick the next richest.

class ReplyGuyBrain implements NpcBrain {
  readonly archetype = 'reply_guy' as const;
  state: NpcState = 'follow';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'follow';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    const richest = ctx.venue.richest[0]?.userId ?? null;
    if (this.followUserId === null || this.followUserId !== richest) {
      this.followUserId = richest;
      this.dwellUntilMs = ctx.nowMs + 5_000;
      return {
        state: 'follow',
        targetSpotId: ctx.venue.currentSpotId,
        lineId: null,
        emoteId: null,
        animId: 'loco_walk',
        dwellMs: 5_000,
        followUserId: this.followUserId,
      };
    }
    if (ctx.nowMs >= this.dwellUntilMs) {
      this.dwellUntilMs = ctx.nowMs + 20_000;
      return {
        state: 'talk',
        targetSpotId: ctx.venue.currentSpotId,
        lineId: 'reply_gm',
        emoteId: 'emote_wave',
        animId: 'loco_idle',
        dwellMs: 3_000,
        followUserId: this.followUserId,
      };
    }
    return {
      state: 'follow',
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_walk',
      dwellMs: 1000,
      followUserId: this.followUserId,
    };
  }

  notify(_event: NpcEvent, _ctx: TickCtx): BrainOutput {
    return {
      state: this.state,
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: this.followUserId,
    };
  }
}

// --- Perp Degen -----------------------------------------------------
//
// Loop: GOTO terminal -> ACT frantic_type 60-120 s -> 70% REACT
// liquidated -> LEAVE -> (respawn: GOTO, ACT cry at rekt_clinic) -
// 30% REACT moon_jump -> TALK -> repeat. Triggered by liquidations.

class PerpDegenBrain implements NpcBrain {
  readonly archetype = 'perp_degen_npc' as const;
  state: NpcState = 'goto';
  dwellUntilMs = 0;
  followUserId: string | null = null;
  private phase: 'trade' | 'rekt' | 'moon' = 'trade';

  reset(): void {
    this.state = 'goto';
    this.dwellUntilMs = 0;
    this.followUserId = null;
    this.phase = 'trade';
    void this; // M3+ will use this for the next phase swap window
  }

  tick(ctx: TickCtx): BrainOutput {
    if (this.phase === 'trade') {
      if (this.state === 'goto') {
        this.state = 'act';
        this.dwellUntilMs = ctx.nowMs + 60_000 + ctx.rng.int(60_000);
        return {
          state: 'act',
          targetSpotId: 'perp_terminal',
          lineId: null,
          emoteId: null,
          animId: 'act_frantic_type',
          dwellMs: 1000,
          followUserId: null,
        };
      }
      if (this.state === 'act' && ctx.nowMs >= this.dwellUntilMs) {
        // 70% rekt, 30% moon.
        this.phase = ctx.rng.chance(0.7) ? 'rekt' : 'moon';
        if (this.phase === 'rekt') {
          this.state = 'react';
          this.dwellUntilMs = ctx.nowMs + 5_000;
          void this;
          return {
            state: 'react',
            targetSpotId: 'perp_terminal',
            lineId: null,
            emoteId: null,
            animId: 'react_liquidated',
            dwellMs: 5_000,
            followUserId: null,
          };
        } else {
          this.state = 'react';
          this.dwellUntilMs = ctx.nowMs + 3_000;
          void this;
          return {
            state: 'react',
            targetSpotId: 'perp_terminal',
            lineId: 'perp_max_long',
            emoteId: 'emote_moon',
            animId: 'react_moon_jump',
            dwellMs: 3_000,
            followUserId: null,
          };
        }
      }
    }
    if (this.phase === 'rekt') {
      if (this.state === 'react' && ctx.nowMs >= this.dwellUntilMs) {
        this.state = 'leave';
        this.dwellUntilMs = ctx.nowMs + 5_000;
        return {
          state: 'leave',
          targetSpotId: 'rekt_clinic',
          lineId: null,
          emoteId: null,
          animId: 'loco_walk',
          dwellMs: 5_000,
          followUserId: null,
        };
      }
      if (this.state === 'leave' && ctx.nowMs >= this.dwellUntilMs) {
        // Respawn at rekt_clinic for cry.
        this.state = 'act';
        this.dwellUntilMs = ctx.nowMs + 30_000;
        this.phase = 'trade';
        return {
          state: 'act',
          targetSpotId: 'rekt_clinic',
          lineId: 'perp_its_so_over',
          emoteId: null,
          animId: 'act_cry',
          dwellMs: 30_000,
          followUserId: null,
        };
      }
    }
    if (this.phase === 'moon' && this.state === 'react' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 4_000;
      return {
        state: 'talk',
        targetSpotId: 'perp_terminal',
        lineId: 'perp_to_the_moon',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    if (this.state === 'talk' && ctx.nowMs >= this.dwellUntilMs) {
      this.phase = 'trade';
      this.state = 'goto';
      return {
        state: 'goto',
        targetSpotId: 'perp_terminal',
        lineId: null,
        emoteId: null,
        animId: 'loco_walk',
        dwellMs: 5_000,
        followUserId: null,
      };
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }

  notify(event: NpcEvent, ctx: TickCtx): BrainOutput {
    if (event.kind === 'liquidation') {
      this.phase = 'rekt';
      this.state = 'react';
      this.dwellUntilMs = ctx.nowMs + 5_000;
      return {
        state: 'react',
        targetSpotId: ctx.venue.currentSpotId,
        lineId: null,
        emoteId: null,
        animId: 'react_liquidated',
        dwellMs: 5_000,
        followUserId: null,
      };
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }
}

// --- Rekt Guy --------------------------------------------------------
//
// Sits in the rekt_clinic, ACT cry, TALK "stimmy" every 60-180 s.

class RektGuyBrain implements NpcBrain {
  readonly archetype = 'rekt_guy' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (this.state === 'idle' && ctx.nowMs >= this.dwellUntilMs) {
      // Cry
      this.state = 'act';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return {
        state: 'act',
        targetSpotId: 'rekt_clinic',
        lineId: null,
        emoteId: null,
        animId: 'act_cry',
        dwellMs: 30_000,
        followUserId: null,
      };
    }
    if (this.state === 'act' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 60_000 + ctx.rng.int(120_000);
      return {
        state: 'talk',
        targetSpotId: 'rekt_clinic',
        lineId: 'rekt_stimmy',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    if (this.state === 'talk' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'idle';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return idleAnim(ctx.venue, ctx.rng);
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }

  notify(_event: NpcEvent, _ctx: TickCtx): BrainOutput {
    return {
      state: this.state,
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }
}

// --- Wallet Tracker --------------------------------------------------
//
// Sits at the cafe, broadcasts the biggest wins of the last hour.

class WalletTrackerBrain implements NpcBrain {
  readonly archetype = 'wallet_tracker' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (this.state === 'idle' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 60_000;
      return {
        state: 'talk',
        targetSpotId: 'cafe_terminal',
        lineId: 'wallet_turnaround',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    if (this.state === 'talk' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'idle';
      this.dwellUntilMs = ctx.nowMs + 60_000;
      return idleAnim(ctx.venue, ctx.rng);
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }

  notify(_event: NpcEvent, _ctx: TickCtx): BrainOutput {
    return {
      state: this.state,
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }
}

// --- Doomposter ------------------------------------------------------
//
// Only spawns when Mood < -2%. Despawns when Mood turns positive.

class DoomposterBrain implements NpcBrain {
  readonly archetype = 'doomposter' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (ctx.venue.moodBps > -200) {
      // Mood is positive; leave.
      this.state = 'leave';
      this.dwellUntilMs = ctx.nowMs + 5_000;
      return {
        state: 'leave',
        targetSpotId: 'venue_exit',
        lineId: null,
        emoteId: null,
        animId: 'loco_walk',
        dwellMs: 5_000,
        followUserId: null,
      };
    }
    if (this.state === 'idle' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return {
        state: 'talk',
        targetSpotId: ctx.venue.currentSpotId,
        lineId: 'doom_bear',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    if (this.state === 'talk' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'idle';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return idleAnim(ctx.venue, ctx.rng);
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }

  notify(_event: NpcEvent, _ctx: TickCtx): BrainOutput {
    return {
      state: this.state,
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }
}

// --- Spaces Host -----------------------------------------------------
//
// Opens an NPC Space when no player-hosted Space is live. Closes
// when one is.

class SpacesHostBrain implements NpcBrain {
  readonly archetype = 'spaces_host' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (this.state === 'idle' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return {
        state: 'talk',
        targetSpotId: 'spaces_studio',
        lineId: 'spaces_gm',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    if (this.state === 'talk' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'idle';
      this.dwellUntilMs = ctx.nowMs + 30_000;
      return idleAnim(ctx.venue, ctx.rng);
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }

  notify(_event: NpcEvent, _ctx: TickCtx): BrainOutput {
    return {
      state: this.state,
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }
}

// --- Ore Miner -------------------------------------------------------
//
// Sits at the refinery, broadcasts the motherlode count, TALK every
// 60 s.

class OreMinerBrain implements NpcBrain {
  readonly archetype = 'ore_miner' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (this.state === 'idle' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 60_000;
      return {
        state: 'talk',
        targetSpotId: 'ore_refinery',
        lineId: 'ore_board',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    if (this.state === 'talk' && ctx.nowMs >= this.dwellUntilMs) {
      this.state = 'idle';
      this.dwellUntilMs = ctx.nowMs + 60_000;
      return idleAnim(ctx.venue, ctx.rng);
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }

  notify(event: NpcEvent, ctx: TickCtx): BrainOutput {
    if (event.kind === 'motherlode') {
      return {
        state: 'talk',
        targetSpotId: ctx.venue.currentSpotId,
        lineId: 'ore_motherlode',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: null,
    };
  }
}
