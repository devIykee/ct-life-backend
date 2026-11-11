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

/** The phase-1 archetypes (spec NPC table, M2). */
export const PHASE1_ARCHETYPES = [
  'town_crier',
  'giveaway_guy',
  'reply_guy',
  'perp_degen_npc',
  'rekt_guy',
  'wallet_tracker',
  'doomposter',
  'spaces_host',
  'ore_miner',
] as const;

/**
 * The phase-2 archetypes: every other NPC of the spec table, with the ids
 * of `contract/ids/archetypes.json`. `vc` and `doxxed_founder` keep their
 * own brains; the rest run the shared ambient brain until their spec
 * loops land (Sybil clones, Rug Dev launches, Normie waves, ...).
 */
export const PHASE2_ARCHETYPES = [
  'alpha_caller',
  'cabal_insider',
  'rug_dev',
  'sniper_bot',
  'sleuth',
  'auditor',
  'vc',
  'farmer',
  'sybil_farmer',
  'fake_rich_larp',
  'dubai_relocator',
  'ai_agent',
  'drainer',
  'community_mod',
  'thread_boy',
  'engagement_farmer',
  'normie',
  'doxxed_founder',
  'prediction_shark_npc',
  'laser_eyes_maxi',
  'chain_tribalist',
] as const;

/** Venue dressing: line-less NPCs that hold the spot the room gives them. */
export const DRESSING_ARCHETYPES = ['barista', 'patron'] as const;

/**
 * Brain ids from before the registry ids existed (M5 #67). Nothing persists
 * them (NPC state lives only in the room), but `createBrain` still accepts
 * them and returns the brain of the registry id, whose `archetype` is the
 * registry id.
 */
export const LEGACY_ARCHETYPE_ALIASES = {
  vc_npc: 'vc',
  builder_npc: 'doxxed_founder',
} as const;

/** An archetype id of `contract/ids/archetypes.json`. */
export type RegistryArchetype =
  | (typeof PHASE1_ARCHETYPES)[number]
  | (typeof PHASE2_ARCHETYPES)[number]
  | (typeof DRESSING_ARCHETYPES)[number];

export type NpcArchetype = RegistryArchetype | keyof typeof LEGACY_ARCHETYPE_ALIASES;

/**
 * The registry id for an archetype, mapping the legacy brain ids.
 * @param archetype - A registry id or a legacy brain id.
 * @returns The registry id.
 */
export function canonicalArchetype(archetype: NpcArchetype): RegistryArchetype {
  return archetype in LEGACY_ARCHETYPE_ALIASES
    ? LEGACY_ARCHETYPE_ALIASES[archetype as keyof typeof LEGACY_ARCHETYPE_ALIASES]
    : (archetype as RegistryArchetype);
}

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
  /**
   * Spot ids (spots.json, `venueId.spotId`) of this venue's stand/npc spots
   * that no other NPC holds right now. The ambient brain wanders between
   * them. Optional: a room that does not fill it gets NPCs that stay home.
   */
  readonly standSpots?: readonly string[];
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

/** Per-NPC options the room passes when it creates a brain. */
export interface BrainOptions {
  /**
   * Line ids the NPC may speak, `<archetype>.<index>` into
   * `npc_lines.<archetype>` (the room passes only lines without `{slots}`,
   * since it does not fill lineParams yet). Used by the ambient brain;
   * when empty it sends the archetype id and the client picks a line from
   * that archetype's set.
   */
  readonly lineIds?: readonly string[];
  /**
   * The anim the NPC holds on its home spot when that is a seat or a
   * terminal (`act_sit`, `act_type`). An ambient NPC with one stays on the
   * spot and keeps the anim while it talks. Used by the normie waves.
   */
  readonly homeAnim?: string;
}

/**
 * Create a brain for the given archetype.
 * @param archetype - A registry id, or a legacy brain id (`vc_npc`, `builder_npc`).
 * @param opts - Per-NPC options (line ids for the ambient brain).
 * @returns A fresh brain in its starting state.
 */
export function createBrain(archetype: NpcArchetype, opts: BrainOptions = {}): NpcBrain {
  const id = canonicalArchetype(archetype);
  switch (id) {
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
    case 'vc':
      return new VcBrain();
    case 'doxxed_founder':
      return new DoxxedFounderBrain();
    case 'barista':
    case 'patron':
      return new StationaryBrain();
    // Phase-2 NPCs without a bespoke loop yet: idle, wander, talk.
    case 'farmer':
    case 'sybil_farmer':
      return new AmbientBrain(id, opts.lineIds, { idleAnim: 'act_farm' });
    case 'rug_dev':
    case 'auditor':
      return new AmbientBrain(id, opts.lineIds, { idleAnim: 'act_type' });
    case 'thread_boy':
    case 'engagement_farmer':
    case 'alpha_caller':
      return new AmbientBrain(id, opts.lineIds, { idleAnim: 'act_phone_scroll' });
    case 'ai_agent':
      // Trades from its terminal-cafe spot; it does not walk around.
      return new AmbientBrain(id, opts.lineIds, { idleAnim: 'act_type', wanders: false });
    case 'cabal_insider':
    case 'sniper_bot':
    case 'sleuth':
    case 'fake_rich_larp':
    case 'dubai_relocator':
    case 'drainer':
    case 'community_mod':
    case 'normie':
      return new AmbientBrain(
        id,
        opts.lineIds,
        opts.homeAnim ? { idleAnim: opts.homeAnim, talkAnim: opts.homeAnim, wanders: false } : {},
      );
    case 'prediction_shark_npc':
    case 'laser_eyes_maxi':
    case 'chain_tribalist':
      return new AmbientBrain(id, opts.lineIds);
  }
}

// --- Ambient (shared phase-2 brain) ---------------------------------
//
// Loop: IDLE at the current spot -> every 20-40 s TALK one line from
// the NPC's own set; between lines, sometimes WANDER to a free stand/npc
// spot of the venue. Each output is held for its whole dwell, so the
// anim, line and spot do not flicker between ticks. Event-driven loops
// (spec table) replace this per archetype later.

interface AmbientStyle {
  /** Anim while idling (anims.json). Default `loco_idle`. */
  readonly idleAnim?: string;
  /** False keeps the NPC on its home spot. Default true. */
  readonly wanders?: boolean;
  /** Anim while talking (anims.json). Default `loco_idle`. */
  readonly talkAnim?: string;
}

export class AmbientBrain implements NpcBrain {
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;
  /** The spot the NPC walked to; null means its home spot. */
  private spotId: string | null = null;
  private nextTalkAtMs = 0;
  private current: BrainOutput | null = null;
  private readonly lineIds: readonly string[];
  private readonly idleAnimId: string;
  private readonly wanders: boolean;
  private readonly talkAnimId: string;

  /**
   * @param archetype - The registry id the brain reports.
   * @param lineIds - Line ids it may speak (see BrainOptions.lineIds).
   * @param style - Idle anim and whether it wanders.
   */
  constructor(
    readonly archetype: RegistryArchetype,
    lineIds: readonly string[] = [],
    style: AmbientStyle = {},
  ) {
    this.lineIds = lineIds;
    this.idleAnimId = style.idleAnim ?? 'loco_idle';
    this.wanders = style.wanders ?? true;
    this.talkAnimId = style.talkAnim ?? 'loco_idle';
  }

  /** Back to the starting state, for a re-spawn. */
  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
    this.spotId = null;
    this.nextTalkAtMs = 0;
    this.current = null;
  }

  /**
   * Advance one tick.
   * @param ctx - Clock, rng and the venue as the room sees it.
   * @returns The output to apply to the NPC's state.
   */
  tick(ctx: TickCtx): BrainOutput {
    // Hold the current output for its dwell; an idle gives way to a line
    // that is due, so the lines keep their 20-40 s rhythm.
    const talkDue = this.current !== null && ctx.nowMs >= this.nextTalkAtMs;
    if (
      this.current !== null &&
      ctx.nowMs < this.dwellUntilMs &&
      !(talkDue && this.state === 'idle')
    ) {
      return { ...this.current, dwellMs: this.dwellUntilMs - ctx.nowMs };
    }
    if (this.current === null) {
      // First tick: stagger the first line so a venue's NPCs do not all
      // speak on the same second.
      this.nextTalkAtMs = ctx.nowMs + 5_000 + ctx.rng.int(15_000);
      return this.enter('idle', this.spotId, null, this.idleAnimId, 5_000, ctx);
    }
    if (ctx.nowMs >= this.nextTalkAtMs) {
      this.nextTalkAtMs = ctx.nowMs + 20_000 + ctx.rng.int(20_000); // 20-40 s
      return this.enter('talk', this.spotId, this.pickLine(ctx.rng), this.talkAnimId, 4_000, ctx);
    }
    const free = this.wanders ? (ctx.venue.standSpots ?? []) : [];
    const walkMs = 6_000;
    const roomToWalk = this.nextTalkAtMs - ctx.nowMs > walkMs;
    if (free.length > 0 && roomToWalk && this.state !== 'wander' && ctx.rng.chance(0.4)) {
      const target = free[ctx.rng.int(free.length)] ?? null;
      if (target !== null && target !== this.spotId) {
        this.spotId = target;
        return this.enter('wander', target, null, 'loco_walk', walkMs, ctx);
      }
    }
    return this.enter('idle', this.spotId, null, this.idleAnimId, 5_000 + ctx.rng.int(5_000), ctx);
  }

  /**
   * World events do not change the ambient loop yet.
   * @param _event - The event.
   * @param ctx - The tick context.
   * @returns The current output.
   */
  notify(_event: NpcEvent, ctx: TickCtx): BrainOutput {
    // No event reactions yet; keep doing what it is doing.
    return this.current ?? idleAnim(ctx.venue, ctx.rng);
  }

  private enter(
    state: NpcState,
    spotId: string | null,
    lineId: string | null,
    animId: string,
    dwellMs: number,
    ctx: TickCtx,
  ): BrainOutput {
    this.state = state;
    this.dwellUntilMs = ctx.nowMs + dwellMs;
    this.current = {
      state,
      targetSpotId: spotId,
      lineId,
      emoteId: null,
      animId,
      dwellMs,
      followUserId: null,
    };
    return this.current;
  }

  private pickLine(rng: Rng): string {
    if (this.lineIds.length === 0) return this.archetype;
    return this.lineIds[rng.int(this.lineIds.length)] ?? this.archetype;
  }
}

/**
 * Venue dressing: an NPC that stays at the spot the room gave it.
 *
 * Baristas, laptop patrons, coffee drinkers and Space audiences exist to
 * make a venue look lived in, so they hold their spot and never wander.
 * The seat or counter anim comes from the room's spawn plan, so this brain
 * leaves animId null rather than guessing.
 */
class StationaryBrain implements NpcBrain {
  readonly archetype = 'patron' as const;
  state: NpcState = 'act';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'act';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (ctx.nowMs < this.dwellUntilMs) return this.hold(null);
    this.dwellUntilMs = ctx.nowMs + 8_000 + ctx.rng.int(12_000); // 8-20s
    // A rare glance up, so they are not completely static.
    return this.hold(ctx.rng.int(100) < 4 ? 'emote_nod' : null, ctx.venue.currentSpotId);
  }

  notify(_event: NpcEvent, _ctx: TickCtx): BrainOutput {
    // Dressing does not react to world events; it keeps the venue busy.
    return this.hold(null);
  }

  private hold(emoteId: string | null, spotId: string | null = null): BrainOutput {
    return {
      state: 'act',
      targetSpotId: spotId,
      lineId: null,
      emoteId,
      // The seat or counter anim comes from the room's spawn plan.
      animId: null,
      dwellMs: Math.max(0, this.dwellUntilMs - Date.now()),
      followUserId: null,
    };
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

// --- VC (M5 #67; was `vc_npc`) -----------------------------------------
//
// Lives in VC Row. The VC trades between investors and project
// founders: every 30-90 s the VC will "hunt" a project owner
// (random richest player) and pitch a line. On a launch event
// the VC immediately calls dibs.

class VcBrain implements NpcBrain {
  readonly archetype = 'vc' as const;
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
      this.pendingEvent = null;
      this.state = 'talk';
      this.dwellUntilMs = ctx.nowMs + 4_000;
      return {
        state: 'talk',
        targetSpotId: 'vc_row',
        lineId: 'vc_dibs',
        emoteId: null,
        animId: 'loco_idle',
        dwellMs: 4_000,
        followUserId: null,
      };
    }
    if (ctx.nowMs >= this.dwellUntilMs) {
      // Hunt the richest project owner.
      const target = ctx.venue.richest[0]?.userId ?? null;
      this.followUserId = target;
      this.state = target ? 'follow' : 'idle';
      this.dwellUntilMs = ctx.nowMs + 30_000 + ctx.rng.int(60_000);
      const line = target ? 'vc_pitch' : 'vc_idle';
      return {
        state: this.state,
        targetSpotId: 'vc_row',
        lineId: line,
        emoteId: null,
        animId: 'loco_walk',
        dwellMs: 4_000,
        followUserId: target,
      };
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 1000,
      followUserId: this.followUserId,
    };
  }

  notify(event: NpcEvent, _ctx: TickCtx): BrainOutput {
    if (event.kind === 'launch') {
      this.pendingEvent = event;
      this.dwellUntilMs = 0;
    }
    return {
      state: this.state,
      targetSpotId: _ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 100,
      followUserId: this.followUserId,
    };
  }
}

// --- Doxxed Founder (M5 #67; was `builder_npc`) ------------------------
//
// Lives in Hackathon House. The builder is permanently wandering
// between project HQs and occasionally shouting about hiring or
// a launch. On a launch event the builder shouts and a brief
// reaction emote plays.

class DoxxedFounderBrain implements NpcBrain {
  readonly archetype = 'doxxed_founder' as const;
  state: NpcState = 'idle';
  dwellUntilMs = 0;
  followUserId: string | null = null;

  reset(): void {
    this.state = 'idle';
    this.dwellUntilMs = 0;
    this.followUserId = null;
  }

  tick(ctx: TickCtx): BrainOutput {
    if (ctx.nowMs >= this.dwellUntilMs) {
      const isWander = ctx.rng.int(2) === 0;
      this.state = isWander ? 'wander' : 'talk';
      this.dwellUntilMs = ctx.nowMs + 20_000 + ctx.rng.int(40_000);
      // Real spot ids first (the room drops anything that is not a spot
      // of this venue and keeps the NPC home).
      const stand = ctx.venue.standSpots ?? [];
      const spots =
        stand.length > 0
          ? stand
          : ctx.venue.walkableSpots.length > 0
            ? ctx.venue.walkableSpots
            : ['builder_hq_1', 'builder_hq_2'];
      const targetSpot = spots[ctx.rng.int(spots.length)] ?? null;
      return {
        state: this.state,
        targetSpotId: isWander ? targetSpot : ctx.venue.currentSpotId,
        lineId: isWander ? null : ctx.rng.int(2) === 0 ? 'builder_hiring' : 'builder_ship',
        emoteId: null,
        animId: isWander ? 'loco_walk' : 'loco_idle',
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

  notify(event: NpcEvent, ctx: TickCtx): BrainOutput {
    if (event.kind === 'launch') {
      return {
        state: 'react',
        targetSpotId: ctx.venue.currentSpotId,
        lineId: 'builder_ship',
        emoteId: 'emote_wave',
        animId: 'react_moon_jump',
        dwellMs: 3_000,
        followUserId: null,
      };
    }
    return {
      state: this.state,
      targetSpotId: ctx.venue.currentSpotId,
      lineId: null,
      emoteId: null,
      animId: 'loco_idle',
      dwellMs: 100,
      followUserId: null,
    };
  }
}
