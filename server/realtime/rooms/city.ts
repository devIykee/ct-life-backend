/**
 * City room.
 *
 * One Colyseus room per game, 1 Hz patch rate, 1,000 client cap
 * (sharded in M3). Carries online count, Mood, active events, and
 * targeted messages to the joined player (dms, payment_confirmed,
 * liquidated, kicked, call_invite, space_update).
 *
 * M2 ships a stub: every player joins, gets the welcome, and the
 * city just broadcasts `event` periodically so clients can render
 * the activity feed. The full event engine is wired in M3 by the
 * workers.
 */
import { Room, Client } from 'colyseus';
import { CityState } from '../../../contract/realtime/states.js';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { loadConfig } from '../../shared/config/config.js';
import { getMoodBps } from '../../application/world-pulse.js';
import {
  shouldDeliverBroadcast,
  subscribeUserMessages,
  type UserMessage,
} from '../../application/realtime-bus.js';
import { createRedis } from '../../shared/redis/client.js';
import { assertJoinAllowed } from '../player.js';

const PATCH_HZ = 1;
const MAX_PLAYERS = 1_000;

/** How often the city re-reads the market mood. */
const MOOD_REFRESH_MS = 15_000;

export class CityRoom extends Room {
  static maxClients = MAX_PLAYERS;
  static patchRate = PATCH_HZ * 1000;
  declare state: CityState;
  /** Last mood refresh, so the 1 Hz tick does not hammer the database. */
  private moodAt = 0;
  /** userId -> sessionIds, so a targeted message reaches every tab. */
  private sessionsByUser: Map<string, Set<string>> = new Map();
  private userIdBySession: Map<string, string> = new Map();
  private busSub: { quit: () => Promise<unknown> } | null = null;
  private lastMoodSent = 0;
  /**
   *
   */
  override async onCreate(_options: unknown): Promise<void> {
    this.state = new CityState();
    this.state.online = 0;
    this.state.mood = 0;
    this.state.metaId = 'meta_v1';
    this.moodAt = 0;
    this.setSimulationInterval((dt) => this.tick(dt), 1000);
    // The city room is where a connected player is reachable, so it is the
    // delivery point for every targeted message the API publishes.
    try {
      this.busSub = subscribeUserMessages(createRedis().main, (msg) => this.deliver(msg));
    } catch {
      // Without Redis the room still works; it just cannot forward.
    }
  }
  /**
   * B5 fix: Verify JWT token before allowing join
   */
  override async onJoin(client: Client, options: unknown): Promise<void> {
    const tokenStr = String((options as { token?: string })?.token ?? '');
    // B5 fix: Reject if no token provided and not in dev mode
    if (tokenStr === '' && !loadConfig().auth.devAuthEnabled) {
      throw new Error('AUTH_REQUIRED');
    }
    // B5 fix: Verify the token and get userId from claims, not options
    if (tokenStr !== '') {
      try {
        const jwtIssuer = createJwtIssuer();
        const claims = await jwtIssuer.verifyAccess(tokenStr);
        const userId = claims.sub ?? '';
        await assertJoinAllowed(userId);
        if (userId !== '') {
          this.userIdBySession.set(client.sessionId, userId);
          const set = this.sessionsByUser.get(userId) ?? new Set<string>();
          set.add(client.sessionId);
          this.sessionsByUser.set(userId, set);
        }
      } catch (err) {
        if ((err as Error).message === 'ACCOUNT_BANNED') throw err;
        throw new Error('INVALID_TOKEN', { cause: err });
      }
    }
    this.state.online = this.clients.length;
    client.send('welcome', { serverNow: Date.now(), instanceId: this.roomId ?? 'city' });
  }
  /**
   * Forward one published message to its recipient.
   *
   * userId '*' is a broadcast, which is how world events reach the city.
   * @param msg - The published message.
   */
  private deliver(msg: UserMessage): void {
    if (msg.userId === '*') {
      if (msg.exclude === undefined && msg.authedOnly !== true) {
        this.broadcast(msg.type, msg.payload);
        return;
      }
      // Scoped broadcast (presence): per session, skipping excluded users.
      for (const client of this.clients) {
        if (shouldDeliverBroadcast(msg, this.userIdBySession.get(client.sessionId))) {
          client.send(msg.type, msg.payload);
        }
      }
      return;
    }
    const sessions = this.sessionsByUser.get(msg.userId);
    if (!sessions) return;
    for (const sessionId of sessions) {
      const client = this.clients.find((c) => c.sessionId === sessionId);
      client?.send(msg.type, msg.payload);
    }
  }

  /**
   * Drop the session from the delivery map.
   * @param client - The leaving client.
   */
  override onLeave(client: Client): void {
    const userId = this.userIdBySession.get(client.sessionId);
    this.userIdBySession.delete(client.sessionId);
    if (userId !== undefined) {
      const set = this.sessionsByUser.get(userId);
      set?.delete(client.sessionId);
      if (set && set.size === 0) this.sessionsByUser.delete(userId);
    }
    this.state.online = this.clients.length;
  }

  /** Close the bus subscription with the room. */
  override async onDispose(): Promise<void> {
    await this.busSub?.quit();
  }

  private tick(_dt: number): void {
    // mood was a sine wave, so it carried no information. It is now the
    // in-game market's volume-weighted 5m move, read off the tick so a
    // slow query never stalls the room.
    const now = Date.now();
    if (now - this.moodAt < MOOD_REFRESH_MS) return;
    this.moodAt = now;
    void (async (): Promise<void> => {
      const { buildContext } = await import('../../application/context.js');
      const mood = await getMoodBps(buildContext());
      this.state.mood = mood;
      // Tell the city when the market actually turns, rather than on every
      // read. 100 bps is a 1% move.
      if (Math.abs(mood - this.lastMoodSent) >= 100) {
        this.lastMoodSent = mood;
        this.broadcast('event', {
          eventId: 'evt_mood_change',
          params: { bps: String(mood) },
          at: Date.now(),
        });
      }
    })().catch(() => {
      // Keep the last known mood.
    });
  }
}
