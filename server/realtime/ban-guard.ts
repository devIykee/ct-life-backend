/**
 * Ban enforcement for a room. One guard per room instance:
 *
 *   - `attach()` subscribes to BAN_CHANNEL; on a ban every session of that user in
 *     this room is closed (code 4003, reason ACCOUNT_BANNED). Every room type uses it,
 *     so a ban cuts street, venue, home, city, market, space, video call and vehicles.
 *   - `track()` records session -> user the moment the token is verified, before any
 *     further await, so a ban that lands mid-join still finds the session.
 *   - `confirm()` runs right before the join completes: it refuses a user banned
 *     during the join (recent-ban set, then the Redis flag / database).
 */
import type { Client, Room } from 'colyseus';
import { BAN_CHANNEL } from '../application/moderation.js';
import { assertJoinAllowed } from './player.js';

/** How long a ban event is remembered for joins that were already in flight. */
const RECENT_MS = 5 * 60_000;

export class BanGuard {
  private readonly users = new Map<string, string>();
  private readonly recent = new Map<string, number>();
  private readonly onBan = (msg: unknown): void => {
    const id = (msg as { userId?: string } | null)?.userId;
    if (typeof id === 'string') this.ban(id);
  };

  /**
   * @param room - The room this guard protects.
   */
  constructor(private readonly room: Room) {}

  /** Start listening for bans (call from onCreate). */
  async attach(): Promise<void> {
    await this.room.presence?.subscribe(BAN_CHANNEL, this.onBan);
  }

  /** Stop listening (call from onDispose). */
  async detach(): Promise<void> {
    await this.room.presence?.unsubscribe(BAN_CHANNEL, this.onBan);
  }

  /**
   * Remember who a session is, immediately after the token check.
   * @param client - The joining client.
   * @param userId - The verified user.
   */
  track(client: Client, userId: string): void {
    if (userId !== '') this.users.set(client.sessionId, userId);
  }

  /**
   * Forget a session (call from onLeave).
   * @param client - The leaving client.
   */
  untrack(client: Client): void {
    this.users.delete(client.sessionId);
  }

  /**
   * Handle a ban event: remember it for in-flight joins and close live sessions.
   * @param userId - The banned player.
   */
  ban(userId: string): void {
    const now = Date.now();
    for (const [id, at] of this.recent) if (now - at > RECENT_MS) this.recent.delete(id);
    this.recent.set(userId, now);
    this.kickUser(userId);
  }

  /**
   * Close every session of a user in this room.
   * @param userId - The banned player.
   */
  kickUser(userId: string): void {
    for (const client of [...this.room.clients]) {
      if (this.users.get(client.sessionId) === userId) client.leave(4003, 'ACCOUNT_BANNED');
    }
  }

  /**
   * Last check before a join completes. Call with no await between it and the step that
   * makes the player visible in the room.
   * @param userId - The verified user.
   * @throws Error `ACCOUNT_BANNED`.
   */
  async confirm(userId: string): Promise<void> {
    if (userId === '') return;
    const at = this.recent.get(userId);
    if (at !== undefined && Date.now() - at <= RECENT_MS) throw new Error('ACCOUNT_BANNED');
    await assertJoinAllowed(userId);
    // A ban event can land while assertJoinAllowed was awaiting.
    const late = this.recent.get(userId);
    if (late !== undefined && Date.now() - late <= RECENT_MS) throw new Error('ACCOUNT_BANNED');
  }
}
