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
 * Join spot: the entrance spot, except for a client rejoining a venue
 * placed on CT Island after a drop. Its join options may carry
 * `{ x, z, island: true }` (island metres); the player starts there if
 * that point is inside a walkable rectangle and no farther than they
 * could have walked since the server last accepted a move from them
 * (`withinRejoinReach` against `ctl:pos`). Otherwise the entrance, as
 * before, without an error.
 *
 * Spot sit/stand: spots are looked up from spots.json. SPOT_TAKEN
 * if another player already occupies the spot.
 *
 * Membership for voice: every joined session is counted in the shared
 * `ctl:venue:members:<instanceId>` hash (see ../venue-presence.ts), and
 * `POST /v1/rtc/token {kind: 'venue', id: instanceId}` mints a LiveKit
 * token only for a user counted there.
 *
 * NPC brain: each venue runs at 1 Hz. The brain is fed the
 * `VenueCtx` (mood, richest players, recent events) and the room
 * applies the `BrainOutput` to the NpcState for that NPC. Who spawns
 * where is in ../npc-roster.ts (phase-2 NPCs only at LIVE_PHASE >= 2,
 * at most 12 per instance).
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
import { BEEF_CHANNEL } from '../../application/beef-events.js';
import {
  applyOutfitMessage,
  authenticateJoin,
  loadPlayerState,
  filterSay,
  loadSayPolicy,
  newMessageId,
  SAY_COOLDOWN_MS,
  EMOTE_COOLDOWN_MS,
} from '../player.js';
import {
  OUTFIT_CHANNEL,
  POS_HASH,
  decodePos,
  encodePos,
  getIslandGeometry,
  islandToVenue,
  newAnchor,
  stepMove,
  TokenBucket,
  venueToIsland,
  withinRejoinReach,
  type IslandPos,
  type MoveAnchor,
  type VenuePlacement,
} from '../movement.js';
import { BanGuard } from '../ban-guard.js';
import { MAX_NPCS_PER_INSTANCE, npcArchetypesFor, npcSpawnPlan } from '../npc-roster.js';
import { hostsNormieWaves, NormieWaves, type FreeSpot, type LeaveReason } from '../normie-waves.js';
import { loadConfig } from '../../shared/config/config.js';
import {
  clearVenueMembers,
  markVenueJoin,
  markVenueLeave,
  touchVenueMembers,
  VENUE_MEMBERS_TOUCH_MS,
} from '../venue-presence.js';

const MoveMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite().optional(),
  /** x/z/rotY are island coordinates; the server converts them. */
  island: z.boolean().optional(),
});

/** Minimum gap between writes of a player's island position to presence. */
const POS_WRITE_MS = 250;

/** Optional island spot in the join options of a client rejoining after a drop. */
const JoinPos = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  island: z.literal(true),
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

/** How often the venue re-reads the world pulse. */
const PULSE_REFRESH_MS = 15_000;
/** The Debate Arena venue, where CT Beef matches are argued (unlock A6). */
const ARENA_VENUE_ID = 'ratio_arena';

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
    readonly anim?: string;
  }>;
}

interface VenueConfig {
  readonly venues: Record<string, VenueSpots>;
  readonly anims: readonly string[];
  /** archetype -> line ids (`<archetype>.<index>`) of its slot-free lines. */
  readonly lineIds: ReadonlyMap<string, readonly string[]>;
  /** Normie lines for leaving when the market dumps (`normie.<index>`). */
  readonly normieDumpLineIds: readonly string[];
}

/** Spot kinds a normie can sit or type at, after the free stand spots. */
const NORMIE_SEAT_KINDS = new Set(['seat', 'terminal']);

/** Spot kinds an NPC can stand on (home spots and ambient wandering). */
const NPC_SPOT_KINDS = new Set(['npc', 'standing', 'stand']);

export class VenueRoom extends Room {
  private readonly ban = new BanGuard(this);
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
  /** Market-peak normie waves; null in venues without them (../normie-waves.ts). */
  private normies: NormieWaves | null = null;
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
  /** sessionId -> wall time of the last presence write (throttle). */
  private posWrittenAt = new Map<string, number>();
  /** sessionId -> time of the last accepted move; only set once the player has moved here. */
  private movedAt = new Map<string, number>();
  /** sessionId -> userId, for sessions counted in the voice member hash. */
  private members = new Map<string, string>();
  private brainClock: SimulatedClock = new SimulatedClock();
  private rng = new SeededRng(0xc0ffee ^ (Date.now() & 0xffffffff));

  private onOutfit = (data: unknown): void => applyOutfitMessage(this.state.players, data);
  /** Debate Arena only: sessionId -> when the current talking span started (unlock A6). */
  private talkSince = new Map<string, number>();
  /** Debate Arena only: relays beef_update / beef_result to the room. */
  private onBeef = (data: unknown): void => {
    const m = data as { type?: unknown; payload?: unknown } | null;
    if (m && (m.type === 'beef_update' || m.type === 'beef_result') && m.payload) {
      this.broadcast(m.type, m.payload);
    }
  };

  /**
   * Stop listening for outfit changes and bans.
   */
  override async onDispose(): Promise<void> {
    await this.presence?.unsubscribe(OUTFIT_CHANNEL, this.onOutfit);
    if (this.isArena()) await this.presence?.unsubscribe(BEEF_CHANNEL, this.onBeef);
    await this.ban.detach();
    if (this.presence) clearVenueMembers(this.presence, this.state.instanceId);
  }

  /**
   *
   */
  override async onCreate(_options: unknown): Promise<void> {
    await this.ban.attach();
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
    // The api tells every room when a player's outfit changes (shift start/end, uniform equip).
    await this.presence?.subscribe(OUTFIT_CHANNEL, this.onOutfit);
    // Debate Arena: beef phase changes and results for spectators (unlock A6).
    if (this.isArena()) await this.presence?.subscribe(BEEF_CHANNEL, this.onBeef);
    // Spawn NPC brains per venue archetype.
    this.spawnNpcBrains();
    // 1 Hz NPC tick.
    this.brainClock.set(Date.now());
    this.setSimulationInterval((dt) => this.tickNpcs(dt), 1000);
    // Keep the voice member hash from expiring under a long-lived room.
    this.clock.setInterval(() => {
      if (this.presence) touchVenueMembers(this.presence, this.state.instanceId);
    }, VENUE_MEMBERS_TOUCH_MS);
  }

  /**
   * @param client - The joining client.
   * @param options - `{ token, venueId, x?, z?, island? }`; `x`/`z` with
   *   `island: true` is the spot a client rejoining after a drop stands on.
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    // Identity and look come from the database, never from join options.
    const userId = await authenticateJoin(options);
    this.ban.track(client, userId);
    // Police custody: a jailed player may only be in CT Jail. Fails open if the
    // database cannot be reached; the REST gates still hold.
    if (this.state.venueId !== 'ct_jail' && (await isInPoliceCustody(userId))) {
      throw new Error('JAILED');
    }
    const player = await loadPlayerState(userId);
    const last = this.placement ? await this.readPos(userId) : null;
    // Last check, no await before the player is stored.
    await this.ban.confirm(userId);

    // Place the player on their own spot when rejoining after a drop, else
    // on the venue's entrance spot. Joining a second venue (or a street
    // room) while still in another is allowed; rooms do not de-duplicate users.
    const venueSpots = this.spotsCfg.venues[this.state.venueId];
    const entrance = venueSpots?.spots.find((s) => s.id.endsWith('.entrance'));
    const fallback = venueSpots?.walkable[0];
    const rejoin = this.rejoinSpot(last, options, Date.now());
    if (rejoin) {
      [player.x, player.z] = rejoin;
    } else if (entrance && typeof entrance.x === 'number' && typeof entrance.z === 'number') {
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
    // Count the session for voice before the client hears it joined, so its
    // first POST /v1/rtc/token already finds it. Best effort: a Redis error
    // costs this player venue voice, never the join.
    if (this.presence) {
      try {
        await markVenueJoin(this.presence, this.state.instanceId, userId);
        this.members.set(client.sessionId, userId);
      } catch {
        // Presence is best effort.
      }
    }
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
    this.ban.untrack(client);
    const player = this.state.players.get(client.sessionId);
    if (player && player.spotId) {
      this.spotOccupants.delete(player.spotId);
    }
    // Hand the street rooms the spot the player walked out from, with the
    // time of their last accepted move (not now: a dropped socket is noticed late).
    const movedAt = this.movedAt.get(client.sessionId);
    if (player && movedAt !== undefined) this.writePos(player, movedAt);
    this.posWrittenAt.delete(client.sessionId);
    this.movedAt.delete(client.sessionId);
    const member = this.members.get(client.sessionId);
    if (member !== undefined && this.presence) {
      this.members.delete(client.sessionId);
      const instanceId = this.state.instanceId;
      void markVenueLeave(this.presence, instanceId, member)
        .then((left) => (left === 0 ? this.removeFromVoice(instanceId, member) : undefined))
        .catch(() => {
          // Best effort; the hash expires on its own and the token is short.
        });
    }
    this.state.players.delete(client.sessionId);
    this.anchors.delete(client.sessionId);
    this.moveBuckets.delete(client.sessionId);
    this.lastEmoteAt.delete(client.sessionId);
    this.lastSayAt.delete(client.sessionId);
    if (player) this.endTalkSpan(client.sessionId, player.userId);
  }

  /**
   * Disconnect a user who has left this instance from its LiveKit rooms, so
   * leaving (or being banned out) also ends what they hear. LiveKit checks a
   * token only on connect, so without this a connected listener would stay.
   * @param instanceId - The venue room id.
   * @param userId - The LiveKit identity.
   */
  protected async removeFromVoice(instanceId: string, userId: string): Promise<void> {
    const { buildContext } = await import('../../application/context.js');
    const ctx = buildContext();
    // `proximity` rooms are street voice now (`proximity:<district>:<instanceId>`,
    // removed by the street room), so only the venue room is left here.
    await ctx.livekit.removeParticipant(ctx, { kind: 'venue', id: instanceId, identity: userId });
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
    const inside = (x: number, z: number): boolean => this.inWalkable(x, z);
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
    this.movedAt.set(client.sessionId, now);
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
   * @param x - Venue-local x.
   * @param z - Venue-local z.
   * @returns True when the point is inside one of the venue's walkable rectangles.
   */
  private inWalkable(x: number, z: number): boolean {
    const rects = this.spotsCfg.venues[this.state.venueId]?.walkable ?? [];
    return rects.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
  }

  /**
   * The venue-local spot a client rejoining after a drop may start on: its
   * island spot from the join options, when this venue is placed on CT
   * Island, the spot is walkable here and within walking reach of the
   * player's last accepted position.
   * @param last - The player's last accepted island position, or null.
   * @param options - The join options.
   * @param now - Server time, ms.
   * @returns Venue-local [x, z], or null to use the entrance.
   */
  private rejoinSpot(
    last: IslandPos | null,
    options: unknown,
    now: number,
  ): readonly [number, number] | null {
    const p = this.placement;
    if (!p || !last) return null;
    const asked = JoinPos.safeParse(options);
    if (!asked.success) return null;
    const { x, z: iz } = asked.data;
    if (!withinRejoinReach(last, x, iz, now)) return null;
    const [lx, lz] = islandToVenue(p, x, iz);
    return this.inWalkable(lx, lz) ? [lx, lz] : null;
  }

  private async readPos(userId: string): Promise<IslandPos | null> {
    try {
      return decodePos(await this.presence?.hget(POS_HASH, userId));
    } catch {
      return null;
    }
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
   * @param at - Time of the move that put them there, ms.
   */
  private writePos(player: PlayerState, at: number): void {
    if (!this.placement) return;
    const value = encodePos({ x: player.ix, z: player.iz, at });
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
    // A normie on the seat gives it up (exit liquidity always makes way).
    if (this.normies !== null) {
      for (const [npcId, npc] of this.state.npcs) {
        if (npc.spotId === parsed.data.spotId && this.normies.yieldSpot(npcId, Date.now())) {
          this.sendNormieOut(npcId, Date.now(), 'yield');
        }
      }
    }
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
    if (this.isArena()) this.reportArena(player.userId, 'emote', 1);
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
    const payload = {
      messageId: newMessageId(),
      userId: player.userId,
      sessionId: client.sessionId,
      text,
      at: now,
    };
    void this.deliverSay(client, player.userId, payload);
  }

  /**
   * Fan a `said` out to everyone except the speaker and anyone who blocked them
   * (or whom they blocked). A muted speaker is told and nothing is sent. If the
   * policy cannot be read the message is dropped (fail closed).
   */
  private async deliverSay(
    client: Client,
    userId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const policy = await loadSayPolicy(userId);
      if (policy.muted) {
        client.send('rejected', { type: 'say', code: 'ACCOUNT_MUTED' });
        return;
      }
      if (this.isArena()) this.reportArena(userId, 'say', 1);
      for (const c of this.clients) {
        if (c.sessionId === client.sessionId) continue;
        const other = this.state.players.get(c.sessionId)?.userId;
        if (other !== undefined && policy.blocked.has(other)) continue;
        c.send('said', payload);
      }
    } catch {
      // fail closed
    }
  }

  private handleTalking(client: Client, msg: unknown): void {
    const parsed = TalkingMessage.safeParse(msg);
    if (!parsed.success) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.talking = parsed.data.on;
    if (!this.isArena()) return;
    if (parsed.data.on) {
      if (!this.talkSince.has(client.sessionId)) this.talkSince.set(client.sessionId, Date.now());
    } else {
      this.endTalkSpan(client.sessionId, player.userId);
    }
  }

  // --- Debate Arena activity (unlock A6) ---------------------------

  private isArena(): boolean {
    return this.state.venueId === ARENA_VENUE_ID;
  }

  /** Close a talking span and report its seconds (capped per span server-side). */
  private endTalkSpan(sessionId: string, userId: string): void {
    const since = this.talkSince.get(sessionId);
    if (since === undefined) return;
    this.talkSince.delete(sessionId);
    const seconds = Math.floor((Date.now() - since) / 1000);
    if (seconds > 0) this.reportArena(userId, 'talk', seconds);
  }

  /**
   * Count talk seconds, emotes and chat lines for a player in a live beef
   * match (a no-op otherwise). Fire and forget.
   */
  private reportArena(userId: string, kind: 'talk' | 'emote' | 'say', amount: number): void {
    void (async (): Promise<void> => {
      const [{ buildContext }, { recordArenaActivity }, { beefConfig }] = await Promise.all([
        import('../../application/context.js'),
        import('../../application/beef-activity.js'),
        import('../../application/beef-rules.js'),
      ]);
      const ctx = buildContext();
      const n =
        kind === 'talk' ? Math.min(amount, beefConfig(ctx).crowd.maxTalkSpanSeconds) : amount;
      await recordArenaActivity(ctx.redis.main, userId, kind, n);
    })().catch(() => {
      // Activity is best effort.
    });
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
    const livePhase = this.livePhase();
    if (hostsNormieWaves(this.state.venueId, livePhase)) this.normies = new NormieWaves();
    // Venues with a seating plan put each NPC on a fixed spot.
    const plan = npcSpawnPlan(this.state.venueId, livePhase);
    if (plan.length > 0) {
      const valid = this.venueSpotIds();
      for (let i = 0; i < plan.length; i++) {
        const seat = plan[i]!;
        if (this.state.npcs.size >= MAX_NPCS_PER_INSTANCE) break;
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
        this.brains.set(npcId, this.brainFor(seat.archetype));
      }
      return;
    }
    const archetypes: NpcArchetype[] = npcArchetypesFor(this.state.venueId, livePhase).slice(
      0,
      MAX_NPCS_PER_INSTANCE,
    );
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
      this.brains.set(npcId, this.brainFor(archetype));
    }
  }

  /**
   * A brain for one NPC, with the line ids of its archetype's set.
   * @param archetype - The NPC's archetype.
   */
  private brainFor(archetype: NpcArchetype): NpcBrain {
    return createBrain(archetype, { lineIds: this.spotsCfg.lineIds.get(archetype) ?? [] });
  }

  /**
   * The deployment's release phase (LIVE_PHASE). Phase 1 if the config
   * cannot be read, which spawns only the phase-1 NPCs.
   */
  private livePhase(): number {
    try {
      return loadConfig().livePhase;
    } catch {
      return 1;
    }
  }

  /**
   * Spots in this venue an NPC can be stationed at, in config order.
   * @returns Global spot ids of the standing kinds, or [] if the venue has none.
   */
  private npcHomeSpotIds(): string[] {
    return (this.spotsCfg.venues[this.state.venueId]?.spots ?? [])
      .filter((sp) => NPC_SPOT_KINDS.has(sp.kind))
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
    const standSpots = this.npcHomeSpotIds();
    for (const [npcId, brain] of this.brains) {
      // The stand/npc spots no other NPC holds right now (ambient wandering).
      const held = new Set<string>();
      for (const [otherId, other] of this.state.npcs) if (otherId !== npcId) held.add(other.spotId);
      const free = standSpots.filter((id) => !held.has(id));
      const out: BrainOutput = brain.tick({ ...ctx, venue: { ...venue, standSpots: free } });
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
    this.stepNormies(ctx.nowMs);
  }

  // --- Normie waves -----------------------------------------------

  /**
   * Spawn, send out and remove normies for this tick (../normie-waves.ts).
   * @param nowMs - The tick time.
   */
  private stepNormies(nowMs: number): void {
    if (this.normies === null) return;
    const step = this.normies.step({
      nowMs,
      moodBps: this.moodBps,
      npcCount: this.state.npcs.size,
      freeSpots: this.freeNormieSpots(),
      rng: this.rng,
    });
    for (const id of step.remove) this.removeNpc(id);
    for (const l of step.leave) this.sendNormieOut(l.npcId, nowMs, l.reason);
    for (const s of step.spawn) {
      const npc = new NpcState();
      npc.archetypeId = 'normie';
      npc.state = 'idle';
      npc.spotId = s.spotId;
      npc.animId = s.animId;
      npc.startedAt = nowMs;
      this.npcHomeSpots.set(s.npcId, s.spotId);
      this.npcHomeAnims.set(s.npcId, s.animId);
      this.state.npcs.set(s.npcId, npc);
      this.brains.set(
        s.npcId,
        createBrain('normie', {
          lineIds: this.spotsCfg.lineIds.get('normie') ?? [],
          homeAnim: s.animId === 'loco_idle' ? undefined : s.animId,
        }),
      );
    }
  }

  /**
   * Spots a normie can take: free stand/npc spots first, then seats and
   * terminals, skipping any spot a player or another NPC holds.
   * @returns Free spots with the anim a normie holds there.
   */
  private freeNormieSpots(): FreeSpot[] {
    const held = new Set<string>(this.spotOccupants.keys());
    for (const npc of this.state.npcs.values()) held.add(npc.spotId);
    const spots = (this.spotsCfg.venues[this.state.venueId]?.spots ?? []).filter(
      (sp) => !held.has(sp.id),
    );
    const stand = spots
      .filter((sp) => NPC_SPOT_KINDS.has(sp.kind))
      .map((sp) => ({ spotId: sp.id, animId: 'loco_idle' }));
    const seats = spots
      .filter((sp) => NORMIE_SEAT_KINDS.has(sp.kind))
      .map((sp) => ({
        spotId: sp.id,
        animId: sp.anim ?? (sp.kind === 'terminal' ? 'act_type' : 'act_sit'),
      }));
    return [...stand, ...seats];
  }

  /**
   * A normie walks to the exit; the wave removes it once it gets there.
   * @param npcId - The normie.
   * @param nowMs - The time.
   * @param reason - `mood`: the market dropped (it says a dump line).
   */
  private sendNormieOut(npcId: string, nowMs: number, reason: LeaveReason): void {
    const npc = this.state.npcs.get(npcId);
    this.brains.delete(npcId);
    this.npcHomeSpots.delete(npcId);
    this.npcHomeAnims.delete(npcId);
    if (!npc) return;
    const valid = this.venueSpotIds();
    const exit = [`${this.state.venueId}.exit`, `${this.state.venueId}.entrance`].find((id) =>
      valid.has(id),
    );
    const dump = this.spotsCfg.normieDumpLineIds;
    npc.state = 'leave';
    if (exit !== undefined) npc.spotId = exit;
    npc.animId = 'loco_walk';
    npc.lineId = reason === 'mood' && dump.length > 0 ? dump[this.rng.int(dump.length)]! : '';
    npc.emoteId = '';
    npc.targetUserId = '';
    npc.startedAt = nowMs;
  }

  /**
   * Drop an NPC from the room state and its brain.
   * @param npcId - The NPC.
   */
  private removeNpc(npcId: string): void {
    this.state.npcs.delete(npcId);
    this.brains.delete(npcId);
    this.npcHomeSpots.delete(npcId);
    this.npcHomeAnims.delete(npcId);
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
    const lines = JSON.parse(
      readFileSync(join(repoRoot, 'contract', 'config', 'npc_lines.json'), 'utf8'),
    ) as Record<string, unknown>;
    return {
      venues: spots.venues,
      anims: anims.anims,
      lineIds: slotFreeLineIds(lines),
      normieDumpLineIds: matchingLineIds(lines, 'normie', /\b(down|red|dip|cliff|dump)/i),
    };
  }
}

/**
 * Line ids the NPCs can speak without lineParams: `<archetype>.<index>` for
 * every line of `npc_lines.<archetype>` that has no `{slot}` (the room does
 * not fill lineParams yet, and the client skips a line it cannot fill).
 * @param lines - contract/config/npc_lines.json.
 * @returns archetype -> line ids.
 */
export function slotFreeLineIds(lines: Record<string, unknown>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [archetype, set] of Object.entries(lines)) {
    if (!Array.isArray(set)) continue;
    const ids: string[] = [];
    set.forEach((line, i) => {
      if (typeof line === 'string' && !line.includes('{')) ids.push(`${archetype}.${i}`);
    });
    out.set(archetype, ids);
  }
  return out;
}

/**
 * Slot-free line ids of one archetype whose text matches a pattern.
 * @param lines - contract/config/npc_lines.json.
 * @param archetype - The archetype.
 * @param pattern - What the line must say.
 * @returns `<archetype>.<index>` ids.
 */
export function matchingLineIds(
  lines: Record<string, unknown>,
  archetype: string,
  pattern: RegExp,
): string[] {
  const set = lines[archetype];
  if (!Array.isArray(set)) return [];
  const out: string[] = [];
  set.forEach((line, i) => {
    if (typeof line === 'string' && !line.includes('{') && pattern.test(line)) {
      out.push(`${archetype}.${i}`);
    }
  });
  return out;
}

/**
 * Whether the player is serving a police stay in CT Jail.
 * @param userId - The player.
 */
async function isInPoliceCustody(userId: string): Promise<boolean> {
  try {
    const [{ buildContext }, { isJailed }] = await Promise.all([
      import('../../application/context.js'),
      import('../../application/heat.js'),
    ]);
    return await isJailed(buildContext(), userId);
  } catch {
    return false;
  }
}
