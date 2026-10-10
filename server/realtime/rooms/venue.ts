/**
 * Venue room.
 *
 * One Colyseus room per venue instance. Up to 50 clients, 10 Hz
 * patch rate. Move, sit, stand, emote, say, talking, npc_tap.
 *
 * Auth: the JWT is verified in `onAuth` against the same RS256 key
 * the REST API uses. The claims are stashed on `this.state.players`
 * keyed by sessionId.
 *
 * Rate limits (per session, enforced in the message handlers):
 *   - move    10 / s
 *   - emote    1 / s
 *   - say      1 / 2 s
 *
 * Velocity cap: 6 m/s on move. Speeds above the cap are clamped and
 * the message is rejected.
 *
 * Walkable validation: every move's `(x, z)` is checked against
 * the venue's walkable rectangles from `contract/ids/spots.json`.
 * A move outside any rectangle is rejected.
 *
 * Spot sit/stand: spots are looked up from spots.json. SPOT_TAKEN
 * if another player already occupies the spot.
 *
 * NPC brain: each venue runs at 1 Hz. The brain is fed the
 * `VenueCtx` (mood, richest players, recent events) and the room
 * applies the `BrainOutput` to the NpcState for that NPC.
 */
import { Room, Client } from 'colyseus';
import { type JWTPayload } from 'jose';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createBrain,
  type NpcArchetype,
  type NpcBrain,
  type TickCtx,
  type VenueCtx,
  type BrainOutput,
} from '../../../packages/npc-brain/src/index.js';
import type { NpcEvent } from '../../../packages/npc-brain/src/index.js';
import { SeededRng } from '../../../packages/npc-brain/src/rng.js';
import { SimulatedClock } from '../../../packages/npc-brain/src/clock.js';
import { VenueState, NpcState, PlayerState } from '../../../contract/realtime/states.js';
import { z } from 'zod';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { loadConfig } from '../../shared/config/config.js';
import { getMoodBps, getRecentEvents } from '../../application/world-pulse.js';

/** Contract order of PlayerState.look. */
const LOOK_SLOTS = [
  'skinTone',
  'headId',
  'hairId',
  'topId',
  'bottomId',
  'shoesId',
  'accId',
] as const;

const LOOK_FALLBACK = ['0', '0', '0', '0', '0', '0', '0'];

/**
 * Flatten a stored character look into the room's string[7].
 *
 * `characters.look` is jsonb holding the contract `Look` object, but
 * PlayerState.look is a string[7] in contract order. Without this the
 * object fails an Array.isArray check and every player is broadcast
 * wearing the placeholder look.
 * @param raw - The jsonb value read from characters.look.
 * @returns The seven look ids in contract order.
 */
function lookToArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // Legacy rows that already stored an array.
    return raw.length === LOOK_SLOTS.length ? raw.map((v) => String(v)) : [...LOOK_FALLBACK];
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return LOOK_SLOTS.map((k, i) => {
      const v = o[k];
      return typeof v === 'string' && v !== '' ? v : LOOK_FALLBACK[i]!;
    });
  }
  return [...LOOK_FALLBACK];
}

const MoveMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite().optional(),
});

const SitMessage = z.object({
  spotId: z.string().min(1),
  requestId: z.string().optional(), // B36: optional request ID for client-side matching
});

const StandMessage = z.object({}).optional();

const EmoteMessage = z.object({
  emoteId: z.string().min(1),
});

const SayMessage = z.object({
  text: z.string().min(1).max(140),
});

const TalkingMessage = z.object({
  on: z.boolean(),
});

const NpcTapMessage = z.object({
  npcId: z.string().min(1),
});

const MOVE_MAX_SPEED_M_PER_S = 6;
/** How often the venue re-reads the world pulse. */
const PULSE_REFRESH_MS = 15_000;
const SAY_MAX_LENGTH = 140;
const SAY_COOLDOWN_MS = 2_000;
const EMOTE_COOLDOWN_MS = 1_000;

const LINK_REGEX = /(?:https?:\/\/|www\.)[^\s]+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s-]?\d{3}[\s-]?\d{4}/g;

interface VenueSpots {
  readonly walkable: ReadonlyArray<{
    readonly x0: number;
    readonly z0: number;
    readonly x1: number;
    readonly z1: number;
  }>;
  readonly spots: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
}

interface VenueConfig {
  readonly venues: Record<string, VenueSpots>;
  readonly anims: readonly string[];
}

export class VenueRoom extends Room {
  /**
   *
   */
  static onAuth(_token: string, _options: unknown): Promise<unknown> {
    return Promise.resolve(_options);
  }

  declare state: VenueState;
  private spotsCfg!: VenueConfig;
  private brains: Map<string, NpcBrain> = new Map();
  /** npcId -> the spot the NPC belongs to when it has nowhere else to be. */
  private npcHomeSpots: Map<string, string> = new Map();
  /** npcId -> the anim the NPC plays while it holds its home spot. */
  private npcHomeAnims: Map<string, string> = new Map();
  /** Latest world pulse, refreshed off the tick so the tick stays sync. */
  private moodBps = 0;
  private recentEvents: NpcEvent[] = [];
  private pulseAt = 0;
  private spotOccupants: Map<string, string> = new Map(); // spotId -> sessionId
  private lastMoveAt = new Map<string, number>();
  private lastEmoteAt = new Map<string, number>();
  private lastSayAt = new Map<string, number>();
  private lastX = new Map<string, number>();
  private lastZ = new Map<string, number>();
  private brainClock: SimulatedClock = new SimulatedClock();
  private rng = new SeededRng(0xc0ffee ^ (Date.now() & 0xffffffff));

  /**
   *
   */
  override async onCreate(_options: unknown): Promise<void> {
    this.maxClients = 50;
    this.patchRate = 100;
    this.spotsCfg = this.loadVenueConfig();
    this.state = new VenueState();
    const opts = _options as { venueId?: string } | undefined;
    const venueId = String(opts?.venueId ?? 'unknown');

    // Validate venueId exists in spots config
    if (!this.spotsCfg.venues[venueId]) {
      throw new Error(`Unknown venueId: ${venueId}`);
    }

    this.state.venueId = venueId;
    this.state.instanceId = this.roomId ? this.roomId : 'inst-' + Date.now().toString(36);
    // Message handlers. 'welcome' is server-to-client only (sent in onJoin).
    this.onMessage('move', (client, msg) => this.handleMove(client, msg));
    this.onMessage('sit', (client, msg) => this.handleSit(client, msg));
    this.onMessage('stand', (client, _msg) => this.handleStand(client));
    this.onMessage('emote', (client, msg) => this.handleEmote(client, msg));
    this.onMessage('say', (client, msg) => this.handleSay(client, msg));
    this.onMessage('talking', (client, msg) => this.handleTalking(client, msg));
    this.onMessage('npc_tap', (client, msg) => this.handleNpcTap(client, msg));
    // Spawn NPC brains per venue archetype.
    this.spawnNpcBrains();
    // 1 Hz NPC tick.
    this.brainClock.set(Date.now());
    this.setSimulationInterval((dt) => this.tickNpcs(dt), 1000);
  }

  /**
   *
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const tokenStr = String((options as { token?: string })?.token ?? '');
    // B5 fix: Reject if no token provided and not in dev mode
    if (tokenStr === '' && !loadConfig().auth.devAuthEnabled) {
      throw new Error('AUTH_REQUIRED');
    }
    const claims = await this.verifyToken(tokenStr);
    const userId = claims.sub ?? '';

    // B5 fix: Fetch player data from DB, never trust join options
    const playerData = await this.fetchPlayerProfile(userId);

    const player = new PlayerState();
    player.userId = userId;
    player.name = playerData.name;
    player.skrName = playerData.skrName;
    player.isSeeker = playerData.isSeeker;
    player.tribeId = playerData.tribeId;
    player.minerTier = playerData.minerTier;
    if (Array.isArray(playerData.look) && playerData.look.length === 7) {
      player.look = playerData.look;
    }

    // B10 fix: Place player at venue entrance spot
    const venueSpots = this.spotsCfg.venues[this.state.venueId];
    if (venueSpots) {
      const entranceSpot = venueSpots.spots.find((s: { id: string }) =>
        s.id.endsWith('.entrance')
      );
      if (entranceSpot) {
        // Parse entrance position from spots.json (simplified - assumes x,z in walkable[0])
        const walkable = venueSpots.walkable[0];
        if (walkable) {
          player.x = walkable.x0;
          player.z = walkable.z0;
        }
      }
    }

    this.state.players.set(client.sessionId, player);
    // Welcome the joiner.
    client.send('welcome', {
      serverNow: Date.now(),
      instanceId: this.state.instanceId,
    });
  }

  /**
   *
   */
  override onLeave(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (player && player.spotId) {
      this.spotOccupants.delete(player.spotId);
    }
    this.state.players.delete(client.sessionId);
    this.lastMoveAt.delete(client.sessionId);
    this.lastEmoteAt.delete(client.sessionId);
    this.lastSayAt.delete(client.sessionId);
    this.lastX.delete(client.sessionId);
    this.lastZ.delete(client.sessionId);
  }

  // --- Message handlers -------------------------------------------

  private handleMove(client: Client, msg: unknown): void {
    const parsed = MoveMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'move', code: 'VALIDATION_FAILED' });
      return;
    }
    const now = Date.now();
    const last = this.lastMoveAt.get(client.sessionId) ?? 0;
    if (now - last < 90) return; // 10/s cap
    this.lastMoveAt.set(client.sessionId, now);
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    // Velocity cap. Compare to last known position.
    const lastX = this.lastX.get(client.sessionId) ?? player.x;
    const lastZ = this.lastZ.get(client.sessionId) ?? player.z;
    const dx = parsed.data.x - lastX;
    const dz = parsed.data.z - lastZ;
    const dist = Math.hypot(dx, dz);
    const dt = Math.max(1, now - last);
    const speed = (dist / dt) * 1000;
    if (speed > MOVE_MAX_SPEED_M_PER_S) {
      client.send('rejected', { type: 'move', code: 'SPEED_EXCEEDED' });
      return;
    }
    // Walkable validation.
    const rects = this.spotsCfg.venues[this.state.venueId]?.walkable ?? [];
    const inside = rects.some(
      (r) =>
        parsed.data.x >= r.x0 &&
        parsed.data.x <= r.x1 &&
        parsed.data.z >= r.z0 &&
        parsed.data.z <= r.z1,
    );
    if (!inside) {
      client.send('rejected', { type: 'move', code: 'OUT_OF_BOUNDS' });
      return;
    }
    player.x = parsed.data.x;
    player.z = parsed.data.z;
    if (parsed.data.rotY !== undefined) player.rotY = parsed.data.rotY;
    // If seated, stand up.
    if (player.spotId) {
      this.spotOccupants.delete(player.spotId);
      player.spotId = '';
    }
    player.anim = dist > 0 ? 'loco_walk' : 'loco_idle';
    this.lastX.set(client.sessionId, parsed.data.x);
    this.lastZ.set(client.sessionId, parsed.data.z);
  }

  private handleSit(client: Client, msg: unknown): void {
    const parsed = SitMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'sit', code: 'VALIDATION_FAILED' });
      return;
    }
    const venue = this.spotsCfg.venues[this.state.venueId];
    if (!venue) {
      // B36 fix: Include spotId and requestId in rejection
      client.send('rejected', {
        type: 'sit',
        code: 'NOT_FOUND',
        spotId: parsed.data.spotId,
        requestId: parsed.data.requestId,
      });
      return;
    }
    const spot = venue.spots.find((s) => s.id === parsed.data.spotId);
    if (!spot) {
      client.send('rejected', {
        type: 'sit',
        code: 'SPOT_NOT_FOUND',
        spotId: parsed.data.spotId,
        requestId: parsed.data.requestId,
      });
      return;
    }
    if (this.spotOccupants.has(parsed.data.spotId)) {
      client.send('rejected', {
        type: 'sit',
        code: 'SPOT_TAKEN',
        spotId: parsed.data.spotId,
        requestId: parsed.data.requestId,
      });
      return;
    }
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (player.spotId) this.spotOccupants.delete(player.spotId);
    player.spotId = parsed.data.spotId;
    // B33 fix: Use spot.anim if present, otherwise fallback based on kind
    player.anim =
      (spot as { anim?: string }).anim ?? (spot.kind === 'stage' ? 'act_type' : 'act_sit');
    this.spotOccupants.set(parsed.data.spotId, client.sessionId);
  }

  private handleStand(client: Client): void {
    StandMessage.parse({});
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (player.spotId) {
      this.spotOccupants.delete(player.spotId);
      player.spotId = '';
    }
    player.anim = 'loco_idle';
  }

  private handleEmote(client: Client, msg: unknown): void {
    const parsed = EmoteMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'emote', code: 'VALIDATION_FAILED' });
      return;
    }
    if (!this.spotsCfg.anims.includes(parsed.data.emoteId)) {
      client.send('rejected', { type: 'emote', code: 'UNKNOWN_EMOTE' });
      return;
    }
    const now = Date.now();
    const last = this.lastEmoteAt.get(client.sessionId) ?? 0;
    if (now - last < EMOTE_COOLDOWN_MS) {
      client.send('rejected', { type: 'emote', code: 'RATE_LIMITED' });
      return;
    }
    this.lastEmoteAt.set(client.sessionId, now);
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.emoteId = parsed.data.emoteId;
    player.emoteAt = now;
  }

  private handleSay(client: Client, msg: unknown): void {
    const parsed = SayMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'say', code: 'VALIDATION_FAILED' });
      return;
    }
    let text = parsed.data.text.slice(0, SAY_MAX_LENGTH);
    text = text.replace(LINK_REGEX, '[link]').replace(PHONE_REGEX, '[phone]');
    // Profanity filter: a minimal stub. Production wires a real
    // dictionary; M2 just lower-cases and trims to a printable set.
    text = text.replace(/[^\x20-\x7e]/g, '');
    const now = Date.now();
    const last = this.lastSayAt.get(client.sessionId) ?? 0;
    if (now - last < SAY_COOLDOWN_MS) {
      client.send('rejected', { type: 'say', code: 'RATE_LIMITED' });
      return;
    }
    this.lastSayAt.set(client.sessionId, now);
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const id =
      'msg-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    // Broadcast to every other client in the room; block-aware
    // filtering happens in M5. M2 fans out to everyone.
    this.broadcast(
      'said',
      {
        messageId: id,
        userId: player.userId,
        sessionId: client.sessionId,
        text,
        at: now,
      },
      { except: client },
    );
  }

  private handleTalking(client: Client, msg: unknown): void {
    const parsed = TalkingMessage.safeParse(msg);
    if (!parsed.success) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.talking = parsed.data.on;
  }

  private handleNpcTap(client: Client, msg: unknown): void {
    const parsed = NpcTapMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'npc_tap', code: 'VALIDATION_FAILED' });
      return;
    }
    const npc = this.state.npcs.get(parsed.data.npcId);
    if (!npc) {
      client.send('rejected', { type: 'npc_tap', code: 'NPC_NOT_FOUND' });
      return;
    }
    if (npc.archetypeId === 'giveaway_guy') {
      // Costs $50 cash. The M2 wiring just toasts; the ledger
      // debit is wired in the REST endpoint POST /v1/needs/actions
      // extension (M3) and arrives as a 'toast_drained' on the
      // city room.
      this.broadcast('toast', {
        to: client.sessionId,
        textId: 'toast_drained',
      });
    }
  }

  // --- NPC brains -------------------------------------------------

  private spawnNpcBrains(): void {
    // Each venue has a small set of archetypes. For M2 we spawn
    // a single NPC per archetype at a fixed seed spot; M3+ spawns
    // the right count per venue layout.
    const plan = this.npcSpawnPlan(this.state.venueId);
    if (plan.length > 0) {
      const valid = this.venueSpotIds();
      for (let i = 0; i < plan.length; i++) {
        const seat = plan[i]!;
        // Never publish a spot the client cannot resolve.
        if (!valid.has(seat.spotId)) continue;
        const npc = new NpcState();
        const npcId = `npc-${i}-${seat.archetype}`;
        npc.archetypeId = seat.archetype;
        npc.spotId = seat.spotId;
        npc.animId = seat.animId;
        this.npcHomeSpots.set(npcId, seat.spotId);
        this.npcHomeAnims.set(npcId, seat.animId);
        this.state.npcs.set(npcId, npc);
        this.brains.set(npcId, createBrain(seat.archetype));
      }
      return;
    }
    const archetypes: NpcArchetype[] = this.npcArchetypesFor(this.state.venueId);
    // Give every NPC a home spot up front. Spawning them with spotId ''
    // left the client to guess, and it used the entrance, which is also
    // where players spawn, so arriving players landed inside a crowd.
    const homeSpots = this.npcHomeSpotIds();
    for (let i = 0; i < archetypes.length; i++) {
      const archetype = archetypes[i]!;
      const npc = new NpcState();
      const npcId = `npc-${i}-${archetype}`;
      npc.archetypeId = archetype;
      const home = homeSpots.length > 0 ? homeSpots[i % homeSpots.length]! : '';
      npc.spotId = home;
      npc.animId = 'loco_idle';
      if (home !== '') this.npcHomeSpots.set(npcId, home);
      this.state.npcs.set(npcId, npc);
      this.brains.set(npcId, createBrain(archetype));
    }
  }

  /**
   * Spots in this venue an NPC can be stationed at, in config order.
   * @returns Global spot ids of the standing kinds, or [] if the venue has none.
   */
  private npcHomeSpotIds(): string[] {
    const kinds = new Set(['npc', 'standing', 'stand']);
    return (this.spotsCfg.venues[this.state.venueId]?.spots ?? [])
      .filter((sp) => kinds.has(sp.kind))
      .map((sp) => sp.id);
  }

  /**
   * Every spot id belonging to this venue.
   * @returns A set used to reject spot ids that belong to another venue.
   */
  private venueSpotIds(): Set<string> {
    return new Set((this.spotsCfg.venues[this.state.venueId]?.spots ?? []).map((sp) => sp.id));
  }

  /**
   * B17 venue patrons: who stands where, per the FE seating table.
   *
   * Spot ids are the global ids from spots.json and the anims come from
   * anims.json, so the client can walk a seated NPC to the seat's approach
   * point. Venues without a plan fall back to the round-robin below.
   * @param venueId - The venue being created.
   * @returns The spawn plan, or [] when the venue has none.
   */
  private npcSpawnPlan(
    venueId: string,
  ): Array<{ archetype: NpcArchetype; spotId: string; animId: string }> {
    switch (venueId) {
      case 'terminal_cafe':
        return [
          { archetype: 'barista', spotId: 'terminal_cafe.counter', animId: 'loco_idle' },
          { archetype: 'patron', spotId: 'terminal_cafe.terminal_1', animId: 'act_type' },
          { archetype: 'patron', spotId: 'terminal_cafe.terminal_2', animId: 'act_type' },
          { archetype: 'patron', spotId: 'terminal_cafe.terminal_3', animId: 'act_type' },
          // The twin-monitor desks are the traders' side of the room.
          { archetype: 'patron', spotId: 'terminal_cafe.terminal_5', animId: 'act_type' },
          { archetype: 'patron', spotId: 'terminal_cafe.table_1', animId: 'act_sit' },
          { archetype: 'patron', spotId: 'terminal_cafe.table_2', animId: 'act_sit' },
          // The wallet tracker keeps its own brain and its own terminal.
          { archetype: 'wallet_tracker', spotId: 'terminal_cafe.pulse_screen', animId: 'loco_idle' },
        ];
      case 'spaces_studio':
        return [
          { archetype: 'spaces_host', spotId: 'spaces_studio.stage_host', animId: 'loco_idle' },
          { archetype: 'patron', spotId: 'spaces_studio.stage_4', animId: 'act_sit' },
          { archetype: 'patron', spotId: 'spaces_studio.stage_5', animId: 'act_sit' },
          { archetype: 'patron', spotId: 'spaces_studio.seat_1', animId: 'act_sit' },
          { archetype: 'patron', spotId: 'spaces_studio.seat_2', animId: 'act_sit' },
          { archetype: 'patron', spotId: 'spaces_studio.seat_3', animId: 'act_sit' },
          { archetype: 'patron', spotId: 'spaces_studio.seat_4', animId: 'act_sit' },
        ];
      default:
        return [];
    }
  }

  private npcArchetypesFor(venueId: string): NpcArchetype[] {
    switch (venueId) {
      case 'timeline_square':
        return ['town_crier', 'giveaway_guy', 'reply_guy', 'doomposter', 'spaces_host'];
      case 'perp_pit':
        return ['perp_degen_npc'];
      case 'rekt_clinic':
        return ['rekt_guy'];
      case 'terminal_cafe':
        return ['wallet_tracker'];
      case 'ore_refinery':
        return ['ore_miner'];
      default:
        return [];
    }
  }

  /**
   * Refresh the cached world pulse. Called from the tick without awaiting
   * so a slow read never stalls the simulation; the brains use the last
   * known values until it lands.
   */
  private refreshPulse(): void {
    const now = Date.now();
    if (now - this.pulseAt < PULSE_REFRESH_MS) return;
    this.pulseAt = now;
    const anchor = this.npcHomeSpots.values().next().value ?? '';
    void (async (): Promise<void> => {
      const { buildContext } = await import('../../application/context.js');
      const ctx = buildContext();
      const [mood, events] = await Promise.all([getMoodBps(ctx), getRecentEvents(ctx, anchor)]);
      this.moodBps = mood;
      this.recentEvents = events;
    })().catch(() => {
      // Keep the last known pulse; the brains must not stall on a read.
    });
  }

  private tickNpcs(_dt: number): void {
    this.refreshPulse();
    const venue: VenueCtx = {
      instanceId: this.state.instanceId,
      moodBps: this.moodBps,
      richest: this.richestPlayers(),
      recentEvents: this.recentEvents,
      currentSpotId: null,
      followUserId: null,
      walkableSpots: (this.spotsCfg.venues[this.state.venueId]?.walkable ?? []).map(
        (r) => `${r.x0},${r.z0}`,
      ),
      drainedUntilMs: null,
      giveDropToastPending: false,
    };
    const ctx: TickCtx = {
      clock: this.brainClock,
      rng: this.rng,
      nowMs: Date.now(),
      dtMs: 1000,
      venue,
    };
    // Brains can name a spot from another venue (spaces_host asked for
    // 'spaces_studio', doomposter for 'venue_exit'). The client can only
    // resolve spots of the room it is in, so anything else falls back to
    // the NPC's home spot.
    const validSpots = this.venueSpotIds();
    for (const [npcId, brain] of this.brains) {
      const out: BrainOutput = brain.tick(ctx);
      const npc = this.state.npcs.get(npcId);
      if (!npc) continue;
      npc.state = out.state;
      const target = out.targetSpotId;
      npc.spotId =
        target !== null && target !== undefined && validSpots.has(target)
          ? target
          : (this.npcHomeSpots.get(npcId) ?? npc.spotId);
      npc.lineId = out.lineId ?? '';
      npc.animId = out.animId ?? this.npcHomeAnims.get(npcId) ?? 'loco_idle';
      npc.emoteId = out.emoteId ?? '';
      npc.targetUserId = out.followUserId ?? '';
      npc.startedAt = ctx.nowMs;
    }
  }

  private richestPlayers(): Array<{ userId: string; netWorthCents: number }> {
    return Array.from(this.state.players.values())
      .map((p) => ({ userId: p.userId, netWorthCents: 0 }))
      .sort((a, b) => b.netWorthCents - a.netWorthCents)
      .slice(0, 5);
  }

  // --- Auth --------------------------------------------------------

  private async verifyToken(token: string): Promise<JWTPayload> {
    // B5 fix: Actually verify the JWT instead of returning unverified claim
    if (token === '') {
      // Dev mode: synthesize a fake claim from a random ID
      // Only allowed when devAuthEnabled is true (checked in onJoin)
      return { sub: `dev-${Math.floor(Math.random() * 1e9).toString(36)}` } as JWTPayload;
    }
    try {
      const jwtIssuer = createJwtIssuer();
      const claims = await jwtIssuer.verifyAccess(token);
      return claims;
    } catch (err) {
      throw new Error('INVALID_TOKEN', { cause: err });
    }
  }

  // B5: Fetch player profile from DB, never trust join options
  private async fetchPlayerProfile(userId: string): Promise<{
    name: string;
    skrName: string;
    isSeeker: boolean;
    tribeId: string;
    minerTier: string;
    look: string[];
  }> {
    const { buildContext } = await import('../../application/context.js');
    const ctx = buildContext();
    const result = await ctx.db.withConnection(async (c) => {
      return c.query(
        `SELECT c.alias, u.skr_name, u.is_seeker, u.miner_tier, c.tribe_id, c.look
         FROM characters c
         JOIN users u ON u.id = c.user_id
         WHERE c.user_id = $1
         LIMIT 1`,
        [userId],
      );
    });

    if (result.rowCount === 0) {
      // No character yet, return defaults
      return {
        name: 'Anon',
        skrName: '',
        isSeeker: false,
        tribeId: '',
        minerTier: 'none',
        look: [...LOOK_FALLBACK],
      };
    }

    const row = result.rows[0];
    return {
      name: row.alias || 'Anon',
      skrName: row.skr_name || '',
      isSeeker: row.is_seeker || false,
      tribeId: row.tribe_id || '',
      minerTier: row.miner_tier || 'none',
      look: lookToArray(row.look),
    };
  }

  // --- Config loaders ---------------------------------------------

  private loadVenueConfig(): VenueConfig {
    const repoRoot = join(process.cwd());
    const spots = JSON.parse(
      readFileSync(join(repoRoot, 'contract', 'ids', 'spots.json'), 'utf8'),
    ) as { venues: Record<string, VenueSpots> };
    const anims = JSON.parse(
      readFileSync(join(repoRoot, 'contract', 'ids', 'anims.json'), 'utf8'),
    ) as { anims: string[] };
    return { venues: spots.venues, anims: anims.anims };
  }
}
