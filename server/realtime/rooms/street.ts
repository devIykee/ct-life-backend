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
 *
 * Street voice (capability `streetVoice`, read once per room): every joined
 * session is counted in `ctl:street:members:<district>:<instanceId>` (see
 * ../street-presence.ts) before `welcome`, and `POST /v1/rtc/token
 * {kind: 'proximity', id: '<district>:<instanceId>'}` mints a token for the
 * LiveKit room `proximity:<district>:<instanceId>` only for a user counted
 * there. The last session of a user leaving (a ban closes sessions too)
 * removes them from that LiveKit room. Once a minute the room also removes
 * everyone connected to its voice room (per the LiveKit webhook) who is no
 * longer in the instance or is out of street voice minutes.
 *
 * Rejoin after a network drop: the join options may carry `x`, `z`
 * (island metres), the spot the client is standing on. With a recent
 * position on record, the session is anchored there instead if it is in
 * bounds and no farther than the player could have walked since the
 * server last accepted a move from them (see `withinRejoinReach`). A far,
 * out-of-bounds or malformed spot is ignored without an error, and the
 * session is anchored on the stored position as before.
 *
 * Map Travel arrival (capability `travel`, read once per room; docs/TRAVEL.md):
 * the join options may carry `tripId`. The player's single-use ticket
 * (`ctl:travel:<userId>`, written when the trip was booked) must name that
 * trip and this district; it opens at `arriveAt - arriveEarlySec` (earlier:
 * ServerError 4425 TRAVEL_NOT_ARRIVED, ticket kept) and closes at
 * `expiresAt` (later, used, foreign or wrong district: 4410
 * TRAVEL_TICKET_INVALID). On success the ticket is deleted atomically, the
 * trip must flip to `arrived` in one guarded UPDATE (still booked, not
 * expired) or the arrival is refused with 4410 and nothing is placed; then
 * the session is anchored and shown at the arrival point (a street spot
 * outside the destination door), `ctl:pos` is written there, and `welcome`
 * carries `travel {tripId, x, z, yaw}`. While a
 * user holds an open ticket, a join without it is refused with 4409
 * TRAVEL_IN_TRANSIT: a rider is nowhere until they arrive or cancel.
 */
import { Room, Client, ServerError } from 'colyseus';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { StreetState, type PlayerState } from '../../../contract/realtime/states.js';
import {
  authenticateJoinIdentity,
  applyOutfitMessage,
  loadPlayerState,
  filterSay,
  loadSayPolicy,
  newMessageId,
  SAY_COOLDOWN_MS,
  EMOTE_COOLDOWN_MS,
} from '../player.js';
import {
  DISTRICTS,
  POS_FRESH_MS,
  OUTFIT_CHANNEL,
  POLICE_CHANNEL,
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
  withinRejoinReach,
} from '../movement.js';
import { BanGuard } from '../ban-guard.js';
import { loadConfig } from '../../shared/config/config.js';
import { isCapabilityOn } from '../../application/capabilities.js';
import {
  consumeTicket,
  getTravelConfig,
  hasOpenTicket,
  TRAVEL_JOIN_CODES,
  type TicketRedis,
  type TravelTicket,
} from '../../application/travel.js';
import {
  clearStreetMembers,
  markStreetJoin,
  markStreetLeave,
  touchStreetMembers,
  STREET_MEMBERS_TOUCH_MS,
} from '../street-presence.js';

const MoveMessage = z.object({
  x: z.number().finite(),
  z: z.number().finite(),
  rotY: z.number().finite().optional(),
});
const EmoteMessage = z.object({ emoteId: z.string().min(1) });
const SayMessage = z.object({ text: z.string().min(1).max(140) });
const TalkingMessage = z.object({ on: z.boolean() });
/** Optional spot in the join options of a client rejoining after a drop (island metres). */
const JoinPos = z.object({ x: z.number().finite(), z: z.number().finite() });
/** Map Travel arrival: the booked trip whose ticket places the player. */
const JoinTrip = z.object({ tripId: z.string().uuid() });

/** How far outside its polygon a district room still tracks a player. */
export const STREET_BORDER_M = 30;
/** How long a vehicle exit grant stays usable. */
const EXIT_GRANT_MS = 15_000;
/** How close the first move after an exit must be to the vehicle. */
const EXIT_GRANT_RADIUS_M = 5;
/** Minimum gap between writes of a player's position to presence. */
const POS_WRITE_MS = 250;
/** How often the room checks who is connected to its voice room (presence and minutes). */
export const STREET_VOICE_SWEEP_MS = 60_000;

interface StreetSession {
  userId: string;
  player: PlayerState;
  /** Null until the server knows where the player is. */
  anchor: MoveAnchor | null;
  placed: boolean;
  bucket: TokenBucket;
  lastEmoteAt: number;
  lastSayAt: number;
  /** Wall time of the last presence write (throttle). */
  posWrittenAt: number;
  /** Time of the last accepted move; stored as the position's `at`. */
  movedAt: number;
}

export class StreetRoom extends Room {
  private readonly ban = new BanGuard(this);
  declare state: StreetState;
  private polygon: Polygon = [];
  private island: readonly Polygon[] = [];
  private anims: readonly string[] = [];
  private sessions = new Map<string, StreetSession>();
  /** Street voice is on for this room (capability `streetVoice` when it opened). */
  private voice = false;
  /** Map Travel arrivals are checked (capability `travel` when it opened). */
  private travel = false;
  /** sessionId -> userId of the sessions counted in the street voice member hash. */
  private members = new Map<string, string>();
  /** userId -> vehicle exit position, from the vehicles room. */
  private exitGrants = new Map<string, IslandPos>();
  private onExit = (data: unknown): void => this.handleVehicleExit(data);
  private onPolice = (data: unknown): void => this.handlePolice(data);
  private onOutfit = (data: unknown): void =>
    applyOutfitMessage({ forEach: (cb) => this.sessions.forEach((x) => cb(x.player)) }, data);

  /**
   * @param options - `{ district }`, one of DISTRICTS.
   */
  override async onCreate(options: unknown): Promise<void> {
    await this.ban.attach();
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
    await this.presence?.subscribe(POLICE_CHANNEL, this.onPolice);
    await this.presence?.subscribe(OUTFIT_CHANNEL, this.onOutfit);
    this.travel = this.travelOn();
    this.voice = this.streetVoiceOn();
    if (this.voice) {
      // Keep the voice member hash from expiring under a long-lived room.
      this.clock.setInterval(() => {
        if (this.presence) touchStreetMembers(this.presence, district, this.state.instanceId);
      }, STREET_MEMBERS_TOUCH_MS);
      this.clock.setInterval(() => void this.sweepVoiceMinutes(), STREET_VOICE_SWEEP_MS);
    }
  }

  /**
   *
   */
  override async onDispose(): Promise<void> {
    await this.ban.detach();
    await this.presence?.unsubscribe(VEHICLE_EXIT_CHANNEL, this.onExit);
    await this.presence?.unsubscribe(POLICE_CHANNEL, this.onPolice);
    await this.presence?.unsubscribe(OUTFIT_CHANNEL, this.onOutfit);
    if (this.voice && this.presence) {
      clearStreetMembers(this.presence, this.state.district, this.state.instanceId);
    }
    this.members.clear();
  }

  /**
   * @param client - The joining client.
   * @param options - `{ token, district, x?, z?, tripId? }`; `x`/`z` is the spot a
   *   client rejoining after a drop stands on (island metres); `tripId` is a
   *   Map Travel arrival.
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const identity = await authenticateJoinIdentity(options);
    const userId = identity.userId;
    // No await between the token check and track(): a ban published from here on finds us.
    this.ban.track(client, identity);
    const assertCurrent = this.ban.checkpoint(client);
    let arrival: TravelTicket | null;
    try {
      arrival = await this.travelArrival(userId, options, Date.now());
    } catch (e) {
      this.ban.untrack(client);
      throw e;
    }
    const player = await this.loadPlayer(userId);
    const last = await this.readPos(userId);
    const now = Date.now();
    const fresh = last !== null && now - last.at <= POS_FRESH_MS;
    // Last check, no await before the session is stored.
    await this.ban.confirm(client);
    assertCurrent();
    this.sessions.set(client.sessionId, {
      userId,
      player,
      anchor: arrival
        ? newAnchor(arrival.x, arrival.z, now)
        : fresh
          ? this.joinAnchor(last, options, now)
          : null,
      placed: false,
      bucket: new TokenBucket(10, 5),
      lastEmoteAt: 0,
      lastSayAt: 0,
      posWrittenAt: 0,
      movedAt: 0,
    });
    // Count the session for street voice before the client hears it joined, so its first
    // POST /v1/rtc/token already finds it. Best effort: a Redis error costs this player
    // street voice, never the join.
    let marked = false;
    try {
      if (this.voice && this.presence) {
        try {
          await markStreetJoin(
            this.presence,
            this.state.district,
            this.state.instanceId,
            userId,
            () => {
              marked = true;
            },
          );
        } catch {
          // Presence is best effort; cancellation checks below are not swallowed.
        }
        try {
          assertCurrent();
        } catch (error) {
          if (marked)
            await markStreetLeave(this.presence, this.state.district, this.state.instanceId, userId)
              .then((left) =>
                left === 0
                  ? this.removeFromVoice(this.state.district, this.state.instanceId, userId)
                  : undefined,
              )
              .catch(() => {
                /* The existing presence TTL remains the Redis-failure fallback. */
              });
          throw error;
        }
        if (marked) this.members.set(client.sessionId, userId);
      }
      assertCurrent();
      client.send('welcome', { serverNow: now, instanceId: this.state.instanceId });
    } catch (error) {
      if (this.sessions.get(client.sessionId)?.player === player) this.onLeave(client);
      throw error;
    }
    if (arrival) this.placeArrival(client, arrival, now);
    client.send('welcome', {
      serverNow: now,
      instanceId: this.state.instanceId,
      ...(arrival
        ? { travel: { tripId: arrival.tripId, x: arrival.x, z: arrival.z, yaw: arrival.yaw } }
        : {}),
    });
  }

  // --- Map Travel --------------------------------------------------

  /**
   * The ticket check of a join (nothing while `travel` is off).
   * @param userId - The joining user.
   * @param options - The join options (`tripId?`).
   * @param now - Server time, ms.
   * @returns The consumed ticket for an arrival, or null for an ordinary join.
   * @throws ServerError 4409 / 4410 / 4425 (TRAVEL_JOIN_CODES).
   */
  private async travelArrival(
    userId: string,
    options: unknown,
    now: number,
  ): Promise<TravelTicket | null> {
    if (!this.travel) return null;
    const redis = await this.travelRedis();
    const trip = JoinTrip.safeParse(options);
    if (trip.success) {
      const r = await consumeTicket(
        redis,
        getTravelConfig(),
        userId,
        trip.data.tripId,
        this.state.district,
        now,
      );
      if (!r.ok) throw new ServerError(TRAVEL_JOIN_CODES[r.code], r.code);
      // The database decides: the guarded UPDATE must flip the trip to `arrived` before the
      // player is placed. If it does not (cancelled, swept, expired, or the update failed),
      // the arrival is refused and the client joins normally: no ride, and a trip left
      // `booked` is refunded by the sweep.
      let arrived = false;
      try {
        arrived = await this.recordArrival(userId, r.ticket);
      } catch {
        arrived = false;
      }
      if (!arrived) {
        throw new ServerError(TRAVEL_JOIN_CODES.TRAVEL_TICKET_INVALID, 'TRAVEL_TICKET_INVALID');
      }
      return r.ticket;
    }
    if (await hasOpenTicket(redis, userId, now)) {
      throw new ServerError(TRAVEL_JOIN_CODES.TRAVEL_IN_TRANSIT, 'TRAVEL_IN_TRANSIT');
    }
    return null;
  }

  /** Show an arriving traveller at the ticket point and record it as their position. */
  private placeArrival(client: Client, t: TravelTicket, now: number): void {
    const s = this.sessions.get(client.sessionId);
    if (!s) return;
    s.player.x = t.x;
    s.player.z = t.z;
    s.player.rotY = t.yaw;
    s.player.ix = t.x;
    s.player.iz = t.z;
    s.player.irotY = t.yaw;
    s.player.anim = 'loco_idle';
    s.placed = true;
    s.movedAt = now;
    this.state.players.set(client.sessionId, s.player);
    this.writePos(s, now, true);
  }

  /**
   * Whether Map Travel is on for this deployment. Overridden in tests.
   * @returns True while `travel` is in CAPABILITIES_ON.
   */
  protected travelOn(): boolean {
    try {
      return isCapabilityOn({ config: loadConfig() }, 'travel');
    } catch {
      return false;
    }
  }

  /**
   * The Redis holding the travel tickets. Overridden in tests.
   * @returns The shared Redis client.
   */
  protected async travelRedis(): Promise<TicketRedis> {
    const { buildContext } = await import('../../application/context.js');
    return buildContext().redis.main as unknown as TicketRedis;
  }

  /**
   * Mark the trip arrived with the guarded UPDATE (the sweep then never refunds it).
   * Overridden in tests.
   * @param userId - The traveller.
   * @param t - The consumed ticket.
   * @returns True only when this call flipped a booked, unexpired trip to `arrived`.
   */
  protected async recordArrival(userId: string, t: TravelTicket): Promise<boolean> {
    const [{ buildContext }, { markArrived }] = await Promise.all([
      import('../../application/context.js'),
      import('../../application/travel.js'),
    ]);
    return markArrived(buildContext(), userId, t);
  }

  /**
   *
   */
  override onLeave(client: Client): void {
    this.ban.untrack(client);
    const s = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
    const member = this.members.get(client.sessionId);
    if (member !== undefined && this.presence) {
      this.members.delete(client.sessionId);
      const district = this.state.district;
      const instanceId = this.state.instanceId;
      void markStreetLeave(this.presence, district, instanceId, member)
        .then((left) =>
          left === 0 ? this.removeFromVoice(district, instanceId, member) : undefined,
        )
        .catch(() => {
          // Best effort; the hash expires on its own and the token is short.
        });
    }
    if (!s) return;
    // Stored with the time of the last accepted move, not now (see writePos).
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
    s.movedAt = now;
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
    const payload = {
      messageId: newMessageId(),
      userId: s.userId,
      sessionId: client.sessionId,
      text: filterSay(parsed.data.text),
      at: now,
    };
    void this.deliverSay(client, s.userId, payload);
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
      for (const c of this.clients) {
        if (c.sessionId === client.sessionId) continue;
        const other = this.sessions.get(c.sessionId)?.userId;
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

  /**
   * Fan a police event out to everyone in this room, but only in the room that
   * holds the pursued player, so bystanders see the same cruisers.
   * @param data - `{ type, targetUserId, payload }` from the police referee.
   */
  private handlePolice(data: unknown): void {
    const d = data as { type?: unknown; targetUserId?: unknown; payload?: unknown } | null;
    if (!d || typeof d.targetUserId !== 'string' || typeof d.payload !== 'object') return;
    if (d.type !== 'police_pursuit' && d.type !== 'police_pursuit_end') return;
    if (![...this.sessions.values()].some((s) => s.userId === d.targetUserId)) return;
    this.broadcast(d.type, d.payload);
  }

  // --- Street voice ------------------------------------------------

  /**
   * Whether street voice is on for this deployment. Overridden in tests.
   * @returns True while `streetVoice` is in CAPABILITIES_ON.
   */
  protected streetVoiceOn(): boolean {
    try {
      return isCapabilityOn({ config: loadConfig() }, 'streetVoice');
    } catch {
      return false;
    }
  }

  /**
   * Disconnect a user from this instance's street voice room, so leaving (or
   * being banned out, or running out of minutes) also ends what they hear.
   * LiveKit checks a token only on connect, so without this a connected
   * listener would stay.
   * @param district - The street room's district.
   * @param instanceId - The street room id.
   * @param userId - The LiveKit identity.
   */
  protected async removeFromVoice(
    district: string,
    instanceId: string,
    userId: string,
  ): Promise<void> {
    const { buildContext } = await import('../../application/context.js');
    const ctx = buildContext();
    await ctx.livekit.removeParticipant(ctx, {
      kind: 'proximity',
      id: `${district}:${instanceId}`,
      identity: userId,
    });
  }

  /**
   * The identities to disconnect from this instance's voice room: connected
   * per the LiveKit webhook (members or not) and no longer in the instance, or
   * past the per-player or the deployment's minutes. Overridden in tests.
   * @returns The LiveKit identities to remove.
   */
  protected async voiceRemovals(): Promise<string[]> {
    const { buildContext } = await import('../../application/context.js');
    const { streetVoiceRemovals } = await import('../../application/street-voice.js');
    return streetVoiceRemovals(
      buildContext(),
      this.state.district,
      this.state.instanceId,
      Date.now(),
    );
  }

  /**
   * Once a minute: disconnect whoever should not be in this instance's voice
   * room (left or kicked and still connected because a removal failed or a
   * kept token reconnected, or out of minutes). Their next token request is
   * refused and a reconnect with a kept token is removed by the webhook check.
   */
  protected async sweepVoiceMinutes(): Promise<void> {
    try {
      const remove = await this.voiceRemovals();
      const district = this.state.district;
      const instanceId = this.state.instanceId;
      await Promise.all(remove.map((u) => this.removeFromVoice(district, instanceId, u)));
    } catch {
      // Best effort; the next sweep tries again.
    }
  }

  // --- Helpers -----------------------------------------------------

  /**
   * Where a session with a fresh stored position starts: the client's own
   * spot from the join options when it passes the walking and bounds
   * checks, otherwise the stored position (today's behaviour).
   * @param last - The player's last accepted island position.
   * @param options - The join options.
   * @param now - Server time, ms.
   * @returns The session's movement anchor.
   */
  private joinAnchor(last: IslandPos, options: unknown, now: number): MoveAnchor {
    const asked = JoinPos.safeParse(options);
    if (asked.success) {
      const { x, z: zz } = asked.data;
      if (withinRejoinReach(last, x, zz, now) && this.inBounds(x, zz)) {
        return newAnchor(x, zz, now);
      }
    }
    return newAnchor(last.x, last.z, last.at);
  }

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

  /**
   * Record the player's position for the other rooms. `at` is the time of
   * the last accepted move, so a write on leave (which may come seconds
   * after a dropped socket) does not shrink the player's rejoin reach.
   * @param s - The session.
   * @param now - Wall time, for the write throttle.
   * @param force - Write even inside the throttle window.
   */
  private writePos(s: StreetSession, now: number, force: boolean): void {
    if (!force && now - s.posWrittenAt < POS_WRITE_MS) return;
    s.posWrittenAt = now;
    const value = encodePos({ x: s.player.x, z: s.player.z, at: s.movedAt });
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
