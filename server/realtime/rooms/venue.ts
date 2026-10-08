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
import { SeededRng } from '../../../packages/npc-brain/src/rng.js';
import { SimulatedClock } from '../../../packages/npc-brain/src/clock.js';
import { VenueState, NpcState, PlayerState } from '../../../contract/realtime/states.js';
import { z } from 'zod';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { loadConfig } from '../../shared/config/config.js';

const MoveMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite().optional(),
});

const SitMessage = z.object({
  spotId: z.string().min(1),
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

const MAX_PLAYERS = 50;
const PATCH_HZ = 10;
const MOVE_MAX_SPEED_M_PER_S = 6;
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
  static maxClients = MAX_PLAYERS;
  static patchRate = PATCH_HZ * 1000; // ms between patches
  /**
   *
   */
  static onAuth(_token: string, _options: unknown): Promise<unknown> {
    return Promise.resolve(_options);
  }

  declare state: VenueState;
  private spotsCfg!: VenueConfig;
  private brains: Map<string, NpcBrain> = new Map();
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
    this.spotsCfg = this.loadVenueConfig();
    this.state = new VenueState();
    const opts = _options as { venueId?: string } | undefined;
    this.state.venueId = String(opts?.venueId ?? 'unknown');
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
    const player = new PlayerState();
    player.userId = claims.sub ?? '';
    player.name = String((options as { name?: string })?.name ?? '');
    player.skrName = String((options as { skrName?: string })?.skrName ?? '');
    player.isSeeker = Boolean((options as { isSeeker?: boolean })?.isSeeker);
    player.tribeId = String((options as { tribeId?: string })?.tribeId ?? '');
    player.minerTier = String((options as { minerTier?: string })?.minerTier ?? 'none');
    const lookArr = (options as { look?: string[] })?.look;
    if (Array.isArray(lookArr) && lookArr.length === 7) {
      player.look = lookArr;
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
      client.send('rejected', { type: 'sit', code: 'NOT_FOUND' });
      return;
    }
    const spot = venue.spots.find((s) => s.id === parsed.data.spotId);
    if (!spot) {
      client.send('rejected', { type: 'sit', code: 'SPOT_NOT_FOUND' });
      return;
    }
    if (this.spotOccupants.has(parsed.data.spotId)) {
      client.send('rejected', { type: 'sit', code: 'SPOT_TAKEN' });
      return;
    }
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    if (player.spotId) this.spotOccupants.delete(player.spotId);
    player.spotId = parsed.data.spotId;
    player.anim = spot.kind === 'stage' ? 'act_type' : 'act_sit';
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
    const archetypes: NpcArchetype[] = this.npcArchetypesFor(this.state.venueId);
    for (let i = 0; i < archetypes.length; i++) {
      const archetype = archetypes[i]!;
      const npc = new NpcState();
      const npcId = `npc-${i}-${archetype}`;
      npc.archetypeId = archetype;
      this.state.npcs.set(npcId, npc);
      this.brains.set(npcId, createBrain(archetype));
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

  private tickNpcs(_dt: number): void {
    const venue: VenueCtx = {
      instanceId: this.state.instanceId,
      moodBps: 0,
      richest: this.richestPlayers(),
      recentEvents: [],
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
    for (const [npcId, brain] of this.brains) {
      const out: BrainOutput = brain.tick(ctx);
      const npc = this.state.npcs.get(npcId);
      if (!npc) continue;
      npc.state = out.state;
      npc.spotId = out.targetSpotId ?? npc.spotId;
      npc.lineId = out.lineId ?? '';
      npc.animId = out.animId ?? 'loco_idle';
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
      throw new Error('INVALID_TOKEN');
    }
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
