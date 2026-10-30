/**
 * Vehicles room.
 *
 * One island-wide room for every car, scooter, helicopter, drone and
 * Roadstar, so a fast vehicle never hands over rooms. Each client only
 * receives the vehicles within 250 m of them (dropped again past 300 m),
 * plus the one they drive; interest is refreshed at 1 Hz.
 *
 * Server-owned parked vehicles: one per bay in `contract/ids/parking.json`
 * (id = bay id). A bay car left elsewhere for 10 minutes goes back to its
 * bay once nobody is within 150 m of it or the bay.
 *
 * A client's position comes from the street rooms (presence hash
 * `ctl:pos`) or, while driving, from their vehicle. Clients send no
 * position of their own here.
 *
 * Messages:
 *   - vehicle_enter { id, kind?, x?, y?, z?, yaw?, steal? }: vehicle must be free
 *     and within 4 m of the player. An id the server does not know yet is
 *     registered where the client says (client-parked cars). A roadstar
 *     (the hovercar) needs the vehicle.hovercar entitlement (NOT_ENTITLED).
 *     A jailed player cannot enter (JAILED).
 *     Stealing: an NPC traffic car (id `traffic_*`) or another player's parked
 *     vehicle needs `steal: true` (else STEAL_REQUIRED). It adds heat, one steal
 *     per 15 s per player, never transfers ownership (a player's vehicle goes back
 *     to where its owner left it on exit, or after 3 minutes), and the roadstar
 *     can never be stolen (VEHICLE_NOT_STEALABLE). A vehicle someone is driving
 *     is never takeable (VEHICLE_TAKEN). The owner gets `vehicle_stolen`.
 *   - vehicle_move { id, x, y, z, yaw, pitch, roll, speed, flags? }: driver
 *     only, 10 Hz. Distance budget at the kind's speed cap (clamped, with
 *     `vehicle_corrected`), y up to 214 m, inside the island outline plus
 *     a 50 m margin over the water.
 *   - vehicle_exit { id, x, z, yaw }: final parked pose. The street rooms
 *     then accept the player's first move at that spot.
 *   - vehicle_hit { victim, velocity }: relayed to the victim only, after
 *     proximity, speed and rate checks. Adds a little heat to the driver.
 */
import { Room, Client } from 'colyseus';
import { StateView } from '@colyseus/schema';
import { VehiclesState, VehicleState } from '../../../contract/realtime/states.js';
import {
  VehicleEnterMessage,
  VehicleExitMessage,
  VehicleHitMessage,
  VehicleMoveMessage,
  VEHICLE_MAX_SPEED_M_PER_S,
  VEHICLE_KINDS,
  VEHICLE_MAX_Y_M,
  type VehicleKind,
} from '../../../contract/realtime/messages.js';
import { authenticateJoin } from '../player.js';
import { createLogger } from '../../shared/logger/logger.js';
import {
  POS_HASH,
  VEHICLE_EXIT_CHANNEL,
  WALK_SPEED_M_PER_S,
  decodePos,
  distanceToLand,
  encodePos,
  getIslandGeometry,
  getParkingBays,
  TokenBucket,
  type IslandPos,
  type ParkingBay,
  type Polygon,
} from '../movement.js';
import { BanGuard } from '../ban-guard.js';

export const INTEREST_ADD_M = 250;
export const INTEREST_DROP_M = 300;
/** Matches the client offer range: a car whose centre is up to ~4.4 m away is offered, plus door walk-up. */
const ENTER_RADIUS_M = 6;
const EXIT_RADIUS_M = 6;
/** How far a parked car's stored pose may trail the pose a client reports and still be corrected on entry. */
const PARKED_DRIFT_M = 30;
const MIN_Y_M = -20;
/** How far over the water past the island outline a vehicle may go. */
const WATER_MARGIN_M = 50;
/** A stored street position older than this cannot be used to enter or be hit. */
const POS_STALE_MS = 5_000;
const HIT_RADIUS_M = 8;
const HIT_MIN_SPEED_M_PER_S = 3;
const VICTIM_COOLDOWN_MS = 1_500;
/** Cap on client-registered vehicles (server-owned bay cars are extra). */
const MAX_VEHICLES = 400;
/** A bay car left elsewhere this long goes back to its bay... */
const BAY_RETURN_MS = 10 * 60_000;
/** ...once nobody is this close to it or to the bay. */
const BAY_RETURN_CLEAR_M = 150;
const MAX_SPAWNED_PER_USER = 2;
/** Client-registered vehicles nobody has driven for this long are removed. */
const SPAWNED_IDLE_MS = 10 * 60_000;
const POS_SWEEP_EVERY_TICKS = 60;
/** Ids that start with this are NPC traffic cars (the client simulates them). */
export const TRAFFIC_ID_PREFIX = 'traffic_';
/** One steal per player per this long. */
const STEAL_COOLDOWN_MS = 15_000;
/** A player's vehicle stolen this long goes back to where its owner left it. */
const STEAL_MAX_MS = 3 * 60_000;
/** A driver earns heat for a hit at most this often. */
const HIT_HEAT_EVERY_MS = 10_000;
const STEAL_HEAT = { npc: 8, player: 15 } as const;
const HIT_HEAT = 3;

/** What the room needs from the application layer (swappable in tests). */
export interface VehicleCrimeHooks {
  isJailed(userId: string): Promise<boolean>;
  raiseHeat(
    userId: string,
    delta: number,
    source: 'steal_npc' | 'steal_player' | 'vehicle_hit',
    refId: string,
  ): Promise<void>;
}

const defaultHooks: VehicleCrimeHooks = {
  async isJailed(userId) {
    try {
      const [{ buildContext }, { isJailed }] = await Promise.all([
        import('../../application/context.js'),
        import('../../application/heat.js'),
      ]);
      return await isJailed(buildContext(), userId);
    } catch {
      return false; // fail open; the REST gates still hold
    }
  },
  async raiseHeat(userId, delta, source, refId) {
    try {
      const [{ buildContext }, { raiseHeat }] = await Promise.all([
        import('../../application/context.js'),
        import('../../application/heat.js'),
      ]);
      await raiseHeat(buildContext(), userId, delta, source, refId);
    } catch {
      // Heat is best effort; a failed write must not break driving.
    }
  },
};
let hooks: VehicleCrimeHooks = defaultHooks;

/**
 * Test hook: replace the jail / heat calls.
 * @param h - The hooks, or null to restore the real ones.
 */
export function setVehicleCrimeHooks(h: VehicleCrimeHooks | null): void {
  hooks = h ?? defaultHooks;
}
const POS_KEEP_MS = 5 * 60_000;

interface VehicleSession {
  client: Client;
  userId: string;
  view: StateView;
  driving: string | null;
  moveBucket: TokenBucket;
  actionBucket: TokenBucket;
}

interface VehicleMeta {
  /** userId that registered it, or null for server-owned vehicles. */
  spawnedBy: string | null;
  /** The bay a server-owned vehicle belongs to. */
  bay: ParkingBay | null;
  spawnedAt: number;
  driverSession: string | null;
  /** Last accepted move time and remaining distance budget (metres). */
  at: number;
  budget: number;
  idleSince: number;
  /** Set while someone is driving a vehicle they stole. */
  stolen: {
    /** The owning player (the vehicle goes back to them), or null for an NPC traffic car. */
    from: string | null;
    at: number;
    origin: { x: number; y: number; z: number; yaw: number };
  } | null;
}

export class VehiclesRoom extends Room {
  private readonly ban = new BanGuard(this);
  declare state: VehiclesState;
  private island: readonly Polygon[] = [];
  private sessions = new Map<string, VehicleSession>();
  private meta = new Map<string, VehicleMeta>();
  private lastHitAt = new Map<string, number>();
  private lastStealAt = new Map<string, number>();
  private lastHitHeatAt = new Map<string, number>();
  private ticks = 0;

  /**
   *
   */
  override async onCreate(_options: unknown): Promise<void> {
    await this.ban.attach();
    const geo = getIslandGeometry();
    if (geo.island.length === 0) throw new Error('Island outline not set');
    this.island = geo.island;
    this.maxClients = 1_000;
    this.patchRate = 100;
    this.state = new VehiclesState();
    this.seedBays(Date.now());
    this.onMessage('vehicle_enter', (c, m) => void this.handleEnter(c, m));
    this.onMessage('vehicle_move', (c, m) => this.handleMove(c, m));
    this.onMessage('vehicle_exit', (c, m) => this.handleExit(c, m));
    this.onMessage('vehicle_hit', (c, m) => void this.handleHit(c, m));
    this.setSimulationInterval(() => void this.tick(Date.now()), 1000);
  }

  /**
   *
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const userId = await authenticateJoin(options);
    this.ban.track(client, userId);
    await this.ban.confirm(userId);
    const view = new StateView();
    client.view = view;
    this.sessions.set(client.sessionId, {
      client,
      userId,
      view,
      driving: null,
      // Clients send a driving pose every 100 ms: refill at that rate so the last pose before an exit is not dropped.
      moveBucket: new TokenBucket(20, 12),
      actionBucket: new TokenBucket(2, 3),
    });
    client.send('welcome', { serverNow: Date.now(), instanceId: this.roomId || 'vehicles' });
  }

  /**
   *
   */
  override onLeave(client: Client): void {
    this.ban.untrack(client);
    const s = this.sessions.get(client.sessionId);
    this.sessions.delete(client.sessionId);
    if (s?.driving) this.release(s, Date.now());
  }

  // --- Messages ----------------------------------------------------

  private async handleEnter(client: Client, msg: unknown): Promise<void> {
    const parsed = VehicleEnterMessage.safeParse(msg);
    const reject = (code: string, extra: Record<string, number> = {}): void => {
      createLogger()
        .child({ room: 'vehicles' })
        .info(
          { code, vehicleId: parsed.data?.id, kind: parsed.data?.kind, ...extra },
          'vehicle_enter rejected',
        );
      client.send('rejected', { type: 'vehicle_enter', code, id: parsed.data?.id });
    };
    if (!parsed.success) return reject('VALIDATION_FAILED');
    const s = this.sessions.get(client.sessionId);
    if (!s) return;
    if (!s.actionBucket.take(Date.now())) return reject('RATE_LIMITED');
    if (s.driving) return reject('ALREADY_DRIVING');
    const m = parsed.data;
    const traffic = m.id.startsWith(TRAFFIC_ID_PREFIX);
    // The hovercar is never stolen: refuse before any lookup.
    const known = this.state.vehicles.get(m.id);
    if ((known?.kind ?? m.kind) === 'roadstar' && this.isStealTarget(s.userId, m.id, traffic)) {
      return reject('VEHICLE_NOT_STEALABLE');
    }
    if (await hooks.isJailed(s.userId)) return reject('JAILED');
    // Checked before the awaits and again on the re-read vehicle below:
    // a kind that becomes roadstar meanwhile was never verified.
    const hovercarOk =
      (this.state.vehicles.get(m.id)?.kind ?? m.kind) === 'roadstar'
        ? await this.ownsHovercar(s.userId)
        : null;
    if (hovercarOk === false) return reject('NOT_ENTITLED');
    const where = await this.readPos(s.userId);
    // Re-read everything after the await; another message may have landed.
    const now = Date.now();
    if (!this.sessions.has(client.sessionId)) return;
    if (s.driving) return reject('ALREADY_DRIVING');
    if (!where || now - where.at > POS_STALE_MS) return reject('POSITION_UNKNOWN');
    // The stored position can lag the player by up to its age at walking pace.
    const reach = ENTER_RADIUS_M + WALK_SPEED_M_PER_S * Math.min(1, (now - where.at) / 1000);

    let v = this.state.vehicles.get(m.id);
    let repark = false;
    const kind = v ? v.kind : m.kind;
    if (kind === 'roadstar' && this.isStealTarget(s.userId, m.id, traffic)) {
      return reject('VEHICLE_NOT_STEALABLE');
    }
    if (kind === 'roadstar' && hovercarOk !== true) return reject('NOT_ENTITLED');
    // Someone else's parked vehicle or an NPC traffic car is a steal.
    const stealing = this.isStealTarget(s.userId, m.id, traffic);
    const previousOwner = v && !traffic ? (this.meta.get(m.id)?.spawnedBy ?? null) : null;
    if (v) {
      if (v.driver !== '') return reject('VEHICLE_TAKEN');
      const fromStored = Math.hypot(v.x - where.x, v.z - where.z);
      if (fromStored > reach) {
        // The stored pose of a parked car can trail the real one (a dropped last move before the exit): when the
        // player stands by the car the client reports, and that is close to the stored pose, the client's is right.
        const fromReported =
          m.x !== undefined && m.z !== undefined
            ? Math.hypot(m.x - where.x, m.z - where.z)
            : Infinity;
        const drift =
          m.x !== undefined && m.z !== undefined ? Math.hypot(m.x - v.x, m.z - v.z) : Infinity;
        if (fromReported > reach || drift > PARKED_DRIFT_M) {
          return reject('VEHICLE_TOO_FAR', {
            fromStored: Math.round(fromStored),
            fromReported: Math.round(fromReported),
            drift: Math.round(drift),
            posAgeMs: now - where.at,
          });
        }
        repark = true; // applied once every check below has passed
      }
    } else {
      if (!m.kind || m.x === undefined || m.z === undefined) return reject('NOT_FOUND');
      const d = Math.hypot(m.x - where.x, m.z - where.z);
      if (d > reach) {
        return reject('VEHICLE_TOO_FAR', { fromReported: Math.round(d), posAgeMs: now - where.at });
      }
    }
    if (stealing) {
      if (m.steal !== true) return reject('STEAL_REQUIRED');
      if (now - (this.lastStealAt.get(s.userId) ?? 0) < STEAL_COOLDOWN_MS) {
        return reject('RATE_LIMITED');
      }
    }
    if (!v) {
      if (!this.makeRoomFor(s.userId)) return reject('VEHICLE_LIMIT');
      v = new VehicleState();
      v.id = m.id;
      v.kind = m.kind!;
      v.x = m.x!;
      v.y = Math.min(VEHICLE_MAX_Y_M, Math.max(MIN_Y_M, m.y ?? 0));
      v.z = m.z!;
      v.yaw = m.yaw ?? 0;
      this.state.vehicles.set(m.id, v);
      this.meta.set(m.id, {
        spawnedBy: s.userId,
        bay: null,
        spawnedAt: now,
        driverSession: null,
        at: now,
        budget: 0,
        idleSince: now,
        stolen: null,
      });
    }
    const meta = this.meta.get(m.id)!;
    if (stealing) {
      // Ownership never moves: `spawnedBy` stays with the owner. The thief only drives.
      meta.stolen = {
        from: previousOwner,
        at: now,
        origin: { x: v.x, y: v.y, z: v.z, yaw: v.yaw },
      };
      this.lastStealAt.set(s.userId, now);
      void hooks.raiseHeat(
        s.userId,
        previousOwner ? STEAL_HEAT.player : STEAL_HEAT.npc,
        previousOwner ? 'steal_player' : 'steal_npc',
        m.id,
      );
      if (previousOwner) {
        this.notifyUser(previousOwner, 'vehicle_stolen', {
          vehicleId: m.id,
          kind: v.kind,
          by: s.userId,
          at: now,
        });
      }
    }
    if (repark && m.x !== undefined && m.z !== undefined) {
      v.x = m.x;
      v.z = m.z;
      if (m.y !== undefined) v.y = Math.min(VEHICLE_MAX_Y_M, Math.max(MIN_Y_M, m.y));
      if (m.yaw !== undefined) v.yaw = m.yaw;
    }
    v.driver = s.userId;
    meta.driverSession = client.sessionId;
    meta.at = now;
    meta.budget = 1;
    s.driving = m.id;
    if (!s.view.has(v)) s.view.add(v);
  }

  /**
   * Whether entering this vehicle would be a steal: an NPC traffic car, or a
   * vehicle another player registered (an unknown id is never a player's).
   * Server-owned bay cars are public parking and not a steal.
   */
  private isStealTarget(userId: string, id: string, traffic: boolean): boolean {
    if (traffic) return true;
    const owner = this.meta.get(id)?.spawnedBy ?? null;
    return owner !== null && owner !== userId;
  }

  /** Send a message to every session of a user in this room. */
  private notifyUser(userId: string, type: string, payload: Record<string, unknown>): void {
    for (const o of this.sessions.values()) if (o.userId === userId) o.client.send(type, payload);
  }

  /**
   * The roadstar (hovercar) needs the player's vehicle.hovercar
   * entitlement. The wallet is re-synced here (throttled to once a
   * minute) so a sold pass stops working even if the seller never
   * calls GET /v1/me/entitlements.
   */
  private async ownsHovercar(userId: string): Promise<boolean> {
    const [{ buildContext }, { hasEntitlement, syncFromWallet, HOVERCAR }] = await Promise.all([
      import('../../application/context.js'),
      import('../../application/entitlements.js'),
    ]);
    const ctx = buildContext();
    await syncFromWallet(ctx, userId);
    return hasEntitlement(ctx, userId, HOVERCAR);
  }

  private handleMove(client: Client, msg: unknown): void {
    const parsed = VehicleMoveMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'vehicle_move', code: 'VALIDATION_FAILED' });
      return;
    }
    const s = this.sessions.get(client.sessionId);
    const now = Date.now();
    if (!s || !s.moveBucket.take(now)) return;
    const m = parsed.data;
    const v = this.state.vehicles.get(m.id);
    const meta = this.meta.get(m.id);
    if (!v || !meta || s.driving !== m.id) {
      client.send('rejected', { type: 'vehicle_move', code: 'NOT_DRIVER', id: m.id });
      return;
    }
    if (distanceToLand(this.island, m.x, m.z) > WATER_MARGIN_M) {
      client.send('rejected', { type: 'vehicle_move', code: 'OUT_OF_BOUNDS', id: m.id });
      client.send('vehicle_corrected', { id: v.id, x: v.x, y: v.y, z: v.z });
      return;
    }
    const cap = VEHICLE_MAX_SPEED_M_PER_S[v.kind as VehicleKind] ?? 20;
    const p = this.step(
      v,
      meta,
      m.x,
      Math.min(VEHICLE_MAX_Y_M, Math.max(MIN_Y_M, m.y)),
      m.z,
      now,
      cap,
    );
    if (p.clamped || m.y > VEHICLE_MAX_Y_M || m.y < MIN_Y_M) {
      client.send('vehicle_corrected', { id: v.id, x: p.x, y: p.y, z: p.z });
    }
    v.x = p.x;
    v.y = p.y;
    v.z = p.z;
    v.yaw = m.yaw;
    v.pitch = m.pitch;
    v.roll = m.roll;
    v.speed = Math.min(cap, m.speed);
    if (m.flags !== undefined) v.flags = m.flags;
  }

  private handleExit(client: Client, msg: unknown): void {
    const parsed = VehicleExitMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'vehicle_exit', code: 'VALIDATION_FAILED' });
      return;
    }
    const s = this.sessions.get(client.sessionId);
    const m = parsed.data;
    const v = this.state.vehicles.get(m.id);
    if (!s || !v || s.driving !== m.id) {
      client.send('rejected', { type: 'vehicle_exit', code: 'NOT_DRIVER', id: m.id });
      return;
    }
    // The parked pose may differ a little from the last move (it rolled
    // to a stop); anything further is ignored and it parks where it was.
    if (Math.hypot(m.x - v.x, m.z - v.z) <= EXIT_RADIUS_M) {
      v.x = m.x;
      v.z = m.z;
    }
    v.yaw = m.yaw;
    this.release(s, Date.now());
  }

  private async handleHit(client: Client, msg: unknown): Promise<void> {
    const parsed = VehicleHitMessage.safeParse(msg);
    if (!parsed.success) {
      client.send('rejected', { type: 'vehicle_hit', code: 'VALIDATION_FAILED' });
      return;
    }
    const s = this.sessions.get(client.sessionId);
    if (!s) return;
    const now = Date.now();
    if (!s.actionBucket.take(now)) return;
    const m = parsed.data;
    const v = s.driving ? this.state.vehicles.get(s.driving) : undefined;
    if (!v) {
      client.send('rejected', { type: 'vehicle_hit', code: 'NOT_DRIVER' });
      return;
    }
    if (m.victim === s.userId) return;
    const victims = [...this.sessions.values()].filter((o) => o.userId === m.victim);
    if (victims.length === 0) return;
    if (now - (this.lastHitAt.get(m.victim) ?? 0) < VICTIM_COOLDOWN_MS) return;
    const cap = VEHICLE_MAX_SPEED_M_PER_S[v.kind as VehicleKind] ?? 20;
    const vel = m.velocity;
    const impact = Math.hypot(vel.x, vel.y, vel.z);
    if (v.speed < HIT_MIN_SPEED_M_PER_S || impact > Math.min(cap, v.speed + 5)) return;
    const where = await this.readPos(m.victim);
    const at = Date.now();
    if (!where || at - where.at > POS_STALE_MS) return;
    const reach = HIT_RADIUS_M + WALK_SPEED_M_PER_S * Math.min(2, (at - where.at) / 1000);
    if (Math.hypot(v.x - where.x, v.z - where.z) > reach) return;
    if (at - (this.lastHitAt.get(m.victim) ?? 0) < VICTIM_COOLDOWN_MS) return;
    this.lastHitAt.set(m.victim, at);
    const payload = { victim: m.victim, velocity: vel, by: s.userId, vehicleId: v.id, at };
    for (const o of victims) o.client.send('vehicle_hit', payload);
    if (at - (this.lastHitHeatAt.get(s.userId) ?? 0) >= HIT_HEAT_EVERY_MS) {
      this.lastHitHeatAt.set(s.userId, at);
      void hooks.raiseHeat(s.userId, HIT_HEAT, 'vehicle_hit', m.victim);
    }
  }

  // --- Tick: interest, presence, cleanup ----------------------------

  /**
   * 1 Hz housekeeping. Public for tests.
   * @param now - Server time in ms.
   */
  async tick(now: number): Promise<void> {
    this.ticks++;
    let all: Record<string, string> = {};
    try {
      all = ((await this.presence?.hgetall(POS_HASH)) as Record<string, string>) ?? {};
    } catch {
      // Keep going with drivers only.
    }
    // Drivers publish their position so the street rooms and vehicle_enter see it.
    for (const s of this.sessions.values()) {
      const v = s.driving ? this.state.vehicles.get(s.driving) : undefined;
      if (v) {
        const p = { x: v.x, z: v.z, at: now };
        all[s.userId] = encodePos(p);
        this.writePos(s.userId, p);
      }
    }
    // A stolen player vehicle is handed back after STEAL_MAX_MS even if still driven.
    for (const s of this.sessions.values()) {
      const meta = s.driving ? this.meta.get(s.driving) : undefined;
      if (s.driving && meta?.stolen?.from && now - meta.stolen.at > STEAL_MAX_MS) {
        s.client.send('vehicle_returned', { vehicleId: s.driving, reason: 'timeout', at: now });
        this.release(s, now, 'timeout');
      }
    }
    for (const s of this.sessions.values()) {
      const me = decodePos(all[s.userId]);
      const known = me !== null && now - me.at <= 10_000;
      for (const v of this.state.vehicles.values()) {
        const own = v.id === s.driving;
        const d = known ? Math.hypot(v.x - me.x, v.z - me.z) : Infinity;
        const has = s.view.has(v);
        if (!has && (own || d <= INTEREST_ADD_M)) s.view.add(v);
        else if (has && !own && d > INTEREST_DROP_M) s.view.remove(v);
      }
    }
    const observers = Object.values(all)
      .map(decodePos)
      .filter((p): p is IslandPos => p !== null && now - p.at <= 10_000);
    for (const [id, meta] of this.meta) {
      const v = this.state.vehicles.get(id);
      if (!v || v.driver !== '') continue;
      if (meta.spawnedBy !== null && now - meta.idleSince > SPAWNED_IDLE_MS) {
        this.despawn(id);
      } else if (meta.bay && now - meta.idleSince > BAY_RETURN_MS) {
        this.returnToBay(v, meta.bay, observers);
      }
    }
    if (this.ticks % POS_SWEEP_EVERY_TICKS === 0) {
      for (const [userId, raw] of Object.entries(all)) {
        const p = decodePos(raw);
        if (!p || now - p.at > POS_KEEP_MS) {
          void Promise.resolve(this.presence?.hdel(POS_HASH, userId)).catch(() => undefined);
        }
      }
    }
  }

  // --- Helpers -----------------------------------------------------

  /**
   * Move toward a point within the vehicle's distance budget.
   * @returns The accepted point and whether it was clamped.
   */
  private step(
    v: VehicleState,
    meta: VehicleMeta,
    x: number,
    y: number,
    z: number,
    now: number,
    cap: number,
  ): { x: number; y: number; z: number; clamped: boolean } {
    const budget = Math.min(cap + 1, meta.budget + (cap * Math.max(0, now - meta.at)) / 1000);
    const dx = x - v.x;
    const dy = y - v.y;
    const dz = z - v.z;
    const dist = Math.hypot(dx, dy, dz);
    meta.at = now;
    if (dist <= budget) {
      meta.budget = budget - dist;
      return { x, y, z, clamped: false };
    }
    meta.budget = 0;
    const k = budget / dist;
    return { x: v.x + dx * k, y: v.y + dy * k, z: v.z + dz * k, clamped: true };
  }

  /** Driver leaves (exit or disconnect): park it and hand the spot to the street rooms. */
  private release(s: VehicleSession, now: number, why: 'exit' | 'timeout' = 'exit'): void {
    const id = s.driving!;
    s.driving = null;
    const v = this.state.vehicles.get(id);
    const meta = this.meta.get(id);
    if (!v || !meta) return;
    v.driver = '';
    v.speed = 0;
    meta.driverSession = null;
    meta.idleSince = now;
    const p = { x: v.x, z: v.z, at: now };
    this.writePos(s.userId, p);
    void Promise.resolve(
      this.presence?.publish(VEHICLE_EXIT_CHANNEL, { userId: s.userId, ...p }),
    ).catch(() => undefined);
    this.returnStolen(id, v, meta, why);
  }

  /**
   * End a steal: a player's vehicle goes back to where its owner left it. An
   * NPC traffic car just stays where it was parked.
   */
  private returnStolen(
    id: string,
    v: VehicleState,
    meta: VehicleMeta,
    reason: 'exit' | 'timeout',
  ): void {
    const st = meta.stolen;
    meta.stolen = null;
    if (!st?.from) return;
    v.x = st.origin.x;
    v.y = st.origin.y;
    v.z = st.origin.z;
    v.yaw = st.origin.yaw;
    v.pitch = 0;
    v.roll = 0;
    v.flags = 0;
    meta.idleSince = Date.now();
    this.notifyUser(st.from, 'vehicle_returned', { vehicleId: id, reason, at: Date.now() });
  }

  /**
   * Enforce the per-user and global vehicle caps before registering one.
   * @param userId - The player registering a vehicle.
   * @returns False when no slot can be freed.
   */
  private makeRoomFor(userId: string): boolean {
    const mine = [...this.meta.entries()]
      .filter(([, m]) => m.spawnedBy === userId)
      .sort((a, b) => a[1].spawnedAt - b[1].spawnedAt);
    if (mine.length >= MAX_SPAWNED_PER_USER) {
      const parked = mine.find(([id]) => this.state.vehicles.get(id)?.driver === '');
      if (!parked) return false;
      this.despawn(parked[0]);
    }
    let spawned = 0;
    for (const m of this.meta.values()) if (m.spawnedBy !== null) spawned++;
    return spawned < MAX_VEHICLES;
  }

  /**
   * Park one server-owned vehicle on each bay from parking.json.
   * @param now - Server time in ms.
   */
  private seedBays(now: number): void {
    for (const bay of getParkingBays()) {
      const ok =
        typeof bay.id === 'string' &&
        bay.id !== '' &&
        (VEHICLE_KINDS as readonly string[]).includes(bay.kind) &&
        [bay.x, bay.y, bay.z, bay.yaw].every((n) => Number.isFinite(n));
      if (!ok || this.state.vehicles.has(bay.id)) continue;
      const v = new VehicleState();
      v.id = bay.id;
      v.kind = bay.kind;
      v.x = bay.x;
      v.y = bay.y;
      v.z = bay.z;
      v.yaw = bay.yaw;
      this.state.vehicles.set(bay.id, v);
      this.meta.set(bay.id, {
        spawnedBy: null,
        bay,
        spawnedAt: now,
        driverSession: null,
        at: now,
        budget: 0,
        idleSince: now,
        stolen: null,
      });
    }
  }

  /**
   * Put an abandoned bay car back on its bay, unless someone would see it jump.
   * @param v - The vehicle.
   * @param bay - Its bay.
   * @param observers - Recent player positions.
   */
  private returnToBay(v: VehicleState, bay: ParkingBay, observers: IslandPos[]): void {
    if (Math.hypot(v.x - bay.x, v.z - bay.z) < 2) return;
    const seen = observers.some(
      (o) =>
        Math.hypot(o.x - v.x, o.z - v.z) < BAY_RETURN_CLEAR_M ||
        Math.hypot(o.x - bay.x, o.z - bay.z) < BAY_RETURN_CLEAR_M,
    );
    if (seen) return;
    v.x = bay.x;
    v.y = bay.y;
    v.z = bay.z;
    v.yaw = bay.yaw;
    v.pitch = 0;
    v.roll = 0;
    v.flags = 0;
  }

  private despawn(id: string): void {
    const v = this.state.vehicles.get(id);
    if (v) for (const s of this.sessions.values()) if (s.view.has(v)) s.view.remove(v);
    this.state.vehicles.delete(id);
    this.meta.delete(id);
  }

  private async readPos(userId: string): Promise<IslandPos | null> {
    try {
      return decodePos(await this.presence?.hget(POS_HASH, userId));
    } catch {
      return null;
    }
  }

  private writePos(userId: string, p: IslandPos): void {
    void Promise.resolve(this.presence?.hset(POS_HASH, userId, encodePos(p))).catch(
      () => undefined,
    );
  }

  /** Stop listening for bans. */
  override async onDispose(): Promise<void> {
    await this.ban.detach();
  }
}
