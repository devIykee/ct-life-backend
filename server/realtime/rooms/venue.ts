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
 *   - move    10 / s sustained, bursts of 5 pass (network jitter)
 *   - emote    1 / s
 *   - say      1 / 2 s
 *
 * Speed: distance budget refilled at 6.5 m/s plus 0.5 m slack, measured
 * from the last accepted move (see ../movement.ts). A move past the
 * budget is clamped, applied, and the client gets `corrected {x, z}`.
 *
 * Island coordinates: `move { ..., island: true }` sends x/z/rotY in
 * island metres; the server converts them with the venue's placement
 * from `contract/ids/districts.json` and replies (`corrected`,
 * `rejected`) in the same frame. Every player also carries `ix/iz/irotY`
 * (island pose), and accepted moves are recorded for the street rooms.
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
import { VenueState, NpcState, type PlayerState } from '../../../contract/realtime/states.js';
import { z } from 'zod';
import { getMoodBps, getRecentEvents } from '../../application/world-pulse.js';
import {
  authenticateJoin,
  loadPlayerState,
  filterSay,
  newMessageId,
  SAY_COOLDOWN_MS,
  EMOTE_COOLDOWN_MS,
} from '../player.js';
import {
  POS_HASH,
  encodePos,
  getIslandGeometry,
  islandToVenue,
  newAnchor,
  stepMove,
  TokenBucket,
  venueToIsland,
  type MoveAnchor,
  type VenuePlacement,
} from '../movement.js';

const MoveMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite().optional(),
  /** x/z/rotY are island coordinates; the server converts them. */
  island: z.boolean().optional(),
});

/** Minimum gap between writes of a player's island position to presence. */
const POS_WRITE_MS = 250;

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

/** How often the venue re-reads the world pulse. */
const PULSE_REFRESH_MS = 15_000;

interface VenueSpots {
  readonly walkable: ReadonlyArray<{
    readonly x0: number;
    readonly z0: number;
    readonly x1: number;
    readonly z1: number;
  }>;
  readonly spots: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly x?: number;
    readonly z?: number;
    readonly rotY?: number;
  }>;
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
  /** sessionId -> last accepted position and remaining move budget. */
  private anchors = new Map<string, MoveAnchor>();
  private moveBuckets = new Map<string, TokenBucket>();
  private lastEmoteAt = new Map<string, number>();
  private lastSayAt = new Map<string, number>();
  /** Where this venue sits on CT Island, or null if it is not placed. */
  private placement: VenuePlacement | null = null;
  /** sessionId -> last presence write; only set once the player has moved here. */
  private posWrittenAt = new Map<string, number>();
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
    this.placement = getIslandGeometry().venues?.[venueId] ?? null;
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
    // Identity and look come from the database, never from join options.
    const userId = await authenticateJoin(options);
    const player = await loadPlayerState(userId);

    // Place the player on the venue's entrance spot. Joining a second
    // venue (or a street room) while still in another is allowed; rooms
    // do not de-duplicate users.
    const venueSpots = this.spotsCfg.venues[this.state.venueId];
    const entrance = venueSpots?.spots.find((s) => s.id.endsWith('.entrance'));
    const fallback = venueSpots?.walkable[0];
    if (entrance && typeof entrance.x === 'number' && typeof entrance.z === 'number') {
      player.x = entrance.x;
      player.z = entrance.z;
      if (typeof entrance.rotY === 'number') player.rotY = entrance.rotY;
    } else if (fallback) {
      player.x = (fallback.x0 + fallback.x1) / 2;
      player.z = (fallback.z0 + fallback.z1) / 2;
    }
    this.anchors.set(client.sessionId, newAnchor(player.x, player.z, Date.now()));
    this.moveBuckets.set(client.sessionId, new TokenBucket(10, 5));
    this.syncIsland(player);

    this.state.players.set(client.sessionId, player);
    // Welcome the joiner.
    const p = this.placement;
    client.send('welcome', {
      serverNow: Date.now(),
      instanceId: this.state.instanceId,
      ...(p ? { island: { x: p.origin[0], y: p.origin[1], z: p.origin[2], yaw: p.yaw } } : {}),
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
    // Hand the street rooms the spot the player walked out from.
    if (player && this.posWrittenAt.has(client.sessionId)) this.writePos(player, Date.now());
    this.posWrittenAt.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.anchors.delete(client.sessionId);
    this.moveBuckets.delete(client.sessionId);
    this.lastEmoteAt.delete(client.sessionId);
    this.lastSayAt.delete(client.sessionId);
  }

  // --- Message handlers -------------------------------------------

  private handleMove(client: Client, msg: unknown): void {
    const parsed = MoveMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'move', code: 'VALIDATION_FAILED' });
      return;
    }
    const now = Date.now();
    if (!this.moveBuckets.get(client.sessionId)?.take(now)) return;
    const player = this.state.players.get(client.sessionId);
    const anchor = this.anchors.get(client.sessionId);
    if (!player || !anchor) return;
    // Island-frame moves are converted to the venue's own frame; replies
    // go back in the frame the client used.
    const island = parsed.data.island === true;
    const p = this.placement;
    if (island && !p) {
      client.send('rejected', { type: 'move', code: 'VALIDATION_FAILED' });
      return;
    }
    const [tx, tz] = island
      ? islandToVenue(p!, parsed.data.x, parsed.data.z)
      : [parsed.data.x, parsed.data.z];
    const out = (x: number, z: number): { x: number; z: number; island?: true } => {
      if (!island) return { x, z };
      const [ix, iz] = venueToIsland(p!, x, z);
      return { x: ix, z: iz, island: true };
    };
    const rects = this.spotsCfg.venues[this.state.venueId]?.walkable ?? [];
    const inside = (x: number, z: number): boolean =>
      rects.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
    if (!inside(tx, tz)) {
      client.send('rejected', { type: 'move', code: 'OUT_OF_BOUNDS', ...out(player.x, player.z) });
      return;
    }
    // Clamp to the distance budget. The clamped point lies on the segment
    // from the last accepted point, which can cross a gap between two
    // rectangles; keep the player where they were in that case.
    const prev = { ...anchor };
    const step = stepMove(anchor, tx, tz, now);
    if (step.clamped && !inside(step.x, step.z)) {
      Object.assign(anchor, prev, { at: now });
      client.send('corrected', out(player.x, player.z));
      return;
    }
    if (step.clamped) client.send('corrected', out(step.x, step.z));
    player.x = step.x;
    player.z = step.z;
    const dist = step.dist;
    if (parsed.data.rotY !== undefined) {
      player.rotY = island && p ? parsed.data.rotY - (p.yaw * Math.PI) / 180 : parsed.data.rotY;
    }
    this.syncIsland(player);
    if (now - (this.posWrittenAt.get(client.sessionId) ?? 0) >= POS_WRITE_MS) {
      this.posWrittenAt.set(client.sessionId, now);
      this.writePos(player, now);
    }
    // If seated, stand up.
    if (player.spotId) {
      this.spotOccupants.delete(player.spotId);
      player.spotId = '';
    }
    player.anim = dist > 0 ? 'loco_walk' : 'loco_idle';
  }

  /**
   * Fill the player's island pose from their venue pose.
   * @param player - The player to update.
   */
  private syncIsland(player: PlayerState): void {
    const p = this.placement;
    if (!p) return;
    const [ix, iz] = venueToIsland(p, player.x, player.z);
    player.ix = ix;
    player.iz = iz;
    player.irotY = player.rotY + (p.yaw * Math.PI) / 180;
  }

  /**
   * Record the player's island position for the street and vehicles rooms.
   * @param player - The player.
   * @param now - Server time in ms.
   */
  private writePos(player: PlayerState, now: number): void {
    if (!this.placement) return;
    const value = encodePos({ x: player.ix, z: player.iz, at: now });
    void Promise.resolve(this.presence?.hset(POS_HASH, player.userId, value)).catch(() => {
      // Presence is best effort.
    });
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
    const text = filterSay(parsed.data.text);
    const now = Date.now();
    const last = this.lastSayAt.get(client.sessionId) ?? 0;
    if (now - last < SAY_COOLDOWN_MS) {
      client.send('rejected', { type: 'say', code: 'RATE_LIMITED' });
      return;
    }
    this.lastSayAt.set(client.sessionId, now);
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    const id = newMessageId();
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
          {
            archetype: 'wallet_tracker',
            spotId: 'terminal_cafe.pulse_screen',
            animId: 'loco_idle',
          },
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
