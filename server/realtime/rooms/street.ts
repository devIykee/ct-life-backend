/**
 * Street room.
 *
 * One room per district (filterBy district) for players walking between
 * venues on CT Island. Same PlayerState and the same move / say / emote /
 * talking messages as the venue room, but x/z are island metres.
 *
 * Bounds: the district polygon from `contract/ids/districts.json`,
 * widened by a 30 m border so players near a district edge are visible
 * from both sides while the client hands over rooms, and always inside
 * the island outline. The room refuses to open until its polygon is set.
 *
 * Speed: the same distance budget as venues (6.5 m/s + 0.5 m slack,
 * clamp and `corrected`). The first move after joining is checked
 * against the player's last known island position from any street or
 * vehicle room, so changing district or getting out of a car does not
 * teleport-check against stale data. After `vehicle_exit` the first move
 * at the vehicle's last position is accepted without the walking rule.
 *
 * A player with no recent position anywhere (fresh login, or more than
 * 30 s since their last move in any room) is placed by their first
 * in-bounds move. They are not shown to others until then. Venue rooms
 * on CT Island record positions too, so walking out of a venue is
 * checked like any other move.
 */
import { Room, Client } from 'colyseus';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { StreetState, type PlayerState } from '../../../contract/realtime/states.js';
import {
  authenticateJoin,
  loadPlayerState,
  filterSay,
  newMessageId,
  SAY_COOLDOWN_MS,
  EMOTE_COOLDOWN_MS,
} from '../player.js';
import {
  DISTRICTS,
  POS_FRESH_MS,
  POS_HASH,
  VEHICLE_EXIT_CHANNEL,
  decodePos,
  distanceToPolygon,
  encodePos,
  getIslandGeometry,
  newAnchor,
  onLand,
  stepMove,
  TokenBucket,
  type DistrictId,
  type IslandPos,
  type MoveAnchor,
  type Polygon,
} from '../movement.js';

const MoveMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite().optional(),
});
const EmoteMessage = z.object({ emoteId: z.string().min(1) });
const SayMessage = z.object({ text: z.string().min(1).max(140) });
const TalkingMessage = z.object({ on: z.boolean() });

/** How far outside its polygon a district room still tracks a player. */
export const STREET_BORDER_M = 30;
/** How long a vehicle exit grant stays usable. */
const EXIT_GRANT_MS = 15_000;
/** How close the first move after an exit must be to the vehicle. */
const EXIT_GRANT_RADIUS_M = 5;
/** Minimum gap between writes of a player's position to presence. */
const POS_WRITE_MS = 250;

interface StreetSession {
  userId: string;
  player: PlayerState;
  /** Null until the server knows where the player is. */
  anchor: MoveAnchor | null;
  placed: boolean;
  bucket: TokenBucket;
  lastEmoteAt: number;
  lastSayAt: number;
  posWrittenAt: number;
}

export class StreetRoom extends Room {
  declare state: StreetState;
  private polygon: Polygon = [];
  private island: readonly Polygon[] = [];
  private anims: readonly string[] = [];
  private sessions = new Map<string, StreetSession>();
  /** userId -> vehicle exit position, from the vehicles room. */
  private exitGrants = new Map<string, IslandPos>();
  private onExit = (data: unknown): void => this.handleVehicleExit(data);

  /**
   * @param options - `{ district }`, one of DISTRICTS.
   */
  override async onCreate(options: unknown): Promise<void> {
    const district = String((options as { district?: string })?.district ?? '');
    if (!(DISTRICTS as readonly string[]).includes(district)) {
      throw new Error(`Unknown district: ${district}`);
    }
    const geo = getIslandGeometry();
    const poly = geo.districts[district as DistrictId] ?? [];
    if (poly.length < 3 || geo.island.length === 0) {
      throw new Error(`District bounds not set: ${district}`);
    }
    this.polygon = poly;
    this.island = geo.island;
    this.anims = this.loadAnims();
    this.maxClients = 100;
    this.patchRate = 100;
    this.state = new StreetState();
    this.state.district = district;
    this.state.instanceId = this.roomId ? this.roomId : 'inst-' + Date.now().toString(36);
    this.onMessage('move', (client, msg) => this.handleMove(client, msg));
    this.onMessage('emote', (client, msg) => this.handleEmote(client, msg));
    this.onMessage('say', (client, msg) => this.handleSay(client, msg));
    this.onMessage('talking', (client, msg) => this.handleTalking(client, msg));
    await this.presence?.subscribe(VEHICLE_EXIT_CHANNEL, this.onExit);
  }

  /**
   *
   */
  override async onDispose(): Promise<void> {
    await this.presence?.unsubscribe(VEHICLE_EXIT_CHANNEL, this.onExit);
  }

  /**
   *
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const userId = await authenticateJoin(options);
    const player = await this.loadPlayer(userId);
    const last = await this.readPos(userId);
    const now = Date.now();
    const fresh = last !== null && now - last.at <= POS_FRESH_MS;
    this.sessions.set(client.sessionId, {
      userId,
      player,
      anchor: fresh ? newAnchor(last.x, last.z, last.at) : null,
      placed: false,
      bucket: new TokenBucket(10, 5),
      lastEmoteAt: 0,
      lastSayAt: 0,
      posWrittenAt: 0,
    });
    client.send('welcome', { serverNow: now, instanceId: this.state.instanceId });
  }

  /**
   *
   */
  override onLeave(client: Client): void {
    const s = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    if (!s) return;
    if (s.placed) this.writePos(s, Date.now(), true);
    if (![...this.sessions.values()].some((o) => o.userId === s.userId)) {
      this.exitGrants.delete(s.userId);
    }
  }

  // --- Messages ----------------------------------------------------

  private handleMove(client: Client, msg: unknown): void {
    const parsed = MoveMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'move', code: 'VALIDATION_FAILED' });
      return;
    }
    const s = this.sessions.get(client.sessionId);
    const now = Date.now();
    if (!s || !s.bucket.take(now)) return;
    const { x, z } = parsed.data;

    let pos: { x: number; z: number; clamped: boolean; dist: number };
    const grant = this.exitGrants.get(s.userId);
    if (
      grant &&
      now - grant.at <= EXIT_GRANT_MS &&
      Math.hypot(x - grant.x, z - grant.z) <= EXIT_GRANT_RADIUS_M
    ) {
      // First step out of a vehicle: skip the walking rule once.
      this.exitGrants.delete(s.userId);
      s.anchor = newAnchor(x, z, now);
      pos = { x, z, clamped: false, dist: 0 };
    } else if (s.anchor === null) {
      // No known position: the first in-bounds move places the player.
      if (!this.inBounds(x, z)) {
        client.send('rejected', { type: 'move', code: 'OUT_OF_BOUNDS' });
        return;
      }
      s.anchor = newAnchor(x, z, now);
      pos = { x, z, clamped: false, dist: 0 };
    } else {
      pos = stepMove(s.anchor, x, z, now);
    }

    if (!this.inBounds(pos.x, pos.z)) {
      // The anchor still follows the player (they may be walking in from
      // the next district); they are just not shown here yet.
      client.send('rejected', {
        type: 'move',
        code: 'OUT_OF_BOUNDS',
        ...(s.placed ? { x: s.player.x, z: s.player.z } : {}),
      });
      return;
    }
    if (pos.clamped) client.send('corrected', { x: pos.x, z: pos.z });
    s.player.x = pos.x;
    s.player.z = pos.z;
    if (parsed.data.rotY !== undefined) s.player.rotY = parsed.data.rotY;
    // Street x/z are already island metres; mirror them for clients that read ix/iz.
    s.player.ix = pos.x;
    s.player.iz = pos.z;
    s.player.irotY = s.player.rotY;
    s.player.anim = pos.dist > 0 ? 'loco_walk' : 'loco_idle';
    if (!s.placed) {
      s.placed = true;
      this.state.players.set(client.sessionId, s.player);
    }
    this.writePos(s, now, false);
  }

  private handleEmote(client: Client, msg: unknown): void {
    const parsed = EmoteMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'emote', code: 'VALIDATION_FAILED' });
      return;
    }
    if (!this.anims.includes(parsed.data.emoteId)) {
      client.send('rejected', { type: 'emote', code: 'UNKNOWN_EMOTE' });
      return;
    }
    const s = this.sessions.get(client.sessionId);
    if (!s) return;
    const now = Date.now();
    if (now - s.lastEmoteAt < EMOTE_COOLDOWN_MS) {
      client.send('rejected', { type: 'emote', code: 'RATE_LIMITED' });
      return;
    }
    s.lastEmoteAt = now;
    s.player.emoteId = parsed.data.emoteId;
    s.player.emoteAt = now;
  }

  private handleSay(client: Client, msg: unknown): void {
    const parsed = SayMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'say', code: 'VALIDATION_FAILED' });
      return;
    }
    const s = this.sessions.get(client.sessionId);
    if (!s) return;
    const now = Date.now();
    if (now - s.lastSayAt < SAY_COOLDOWN_MS) {
      client.send('rejected', { type: 'say', code: 'RATE_LIMITED' });
      return;
    }
    s.lastSayAt = now;
    this.broadcast(
      'said',
      {
        messageId: newMessageId(),
        userId: s.userId,
        sessionId: client.sessionId,
        text: filterSay(parsed.data.text),
        at: now,
      },
      { except: client },
    );
  }

  private handleTalking(client: Client, msg: unknown): void {
    const parsed = TalkingMessage.safeParse(msg);
    if (!parsed.success) return;
    const s = this.sessions.get(client.sessionId);
    if (s) s.player.talking = parsed.data.on;
  }

  /**
   * A player got out of a vehicle somewhere on the island. Only kept for
   * players in this room; later joiners get the same position from
   * presence instead.
   * @param data - `{ userId, x, z, at }` from the vehicles room.
   */
  private handleVehicleExit(data: unknown): void {
    const d = data as Partial<IslandPos & { userId: string }> | null;
    if (!d || typeof d.userId !== 'string') return;
    if (![d.x, d.z, d.at].every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    if (![...this.sessions.values()].some((s) => s.userId === d.userId)) return;
    this.exitGrants.set(d.userId, { x: d.x!, z: d.z!, at: d.at! });
  }

  // --- Helpers -----------------------------------------------------

  private inBounds(x: number, z: number): boolean {
    return onLand(this.island, x, z) && distanceToPolygon(this.polygon, x, z) <= STREET_BORDER_M;
  }

  private async readPos(userId: string): Promise<IslandPos | null> {
    try {
      return decodePos(await this.presence?.hget(POS_HASH, userId));
    } catch {
      return null;
    }
  }

  private writePos(s: StreetSession, now: number, force: boolean): void {
    if (!force && now - s.posWrittenAt < POS_WRITE_MS) return;
    s.posWrittenAt = now;
    const value = encodePos({ x: s.player.x, z: s.player.z, at: now });
    void Promise.resolve(this.presence?.hset(POS_HASH, s.userId, value)).catch(() => {
      // Presence is best effort; the next move writes again.
    });
  }

  /**
   * Load the joining player's profile. Overridden in tests.
   * @param userId - The authenticated user.
   * @returns The player state to publish once placed.
   */
  protected loadPlayer(userId: string): Promise<PlayerState> {
    return loadPlayerState(userId);
  }

  private loadAnims(): readonly string[] {
    const raw = JSON.parse(
      readFileSync(join(process.cwd(), 'contract', 'ids', 'anims.json'), 'utf8'),
    ) as { anims: string[] };
    return raw.anims;
  }
}
