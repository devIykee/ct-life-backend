/**
 * Ban and account-deletion enforcement for a room. One guard per room instance:
 *
 *   - `attach()` subscribes to ban and deletion events; every session of that user in
 *     this room is closed (4003 ACCOUNT_BANNED or 4004 ACCOUNT_DELETED). Every room type uses it,
 *     so a ban cuts street, venue, home, city, market, space, video call and vehicles.
 *   - `track()` records session -> user the moment the token is verified, before any
 *     further await, so an event that lands mid-join still finds the session.
 *   - `confirm()` runs right before the join completes: it refuses a banned or deleted
 *     user (recent events, then the Redis flag / durable account state).
 */
import type { Client, Room } from 'colyseus';
import { BAN_CHANNEL } from '../application/moderation.js';
import { ACCOUNT_DELETED_CHANNEL } from '../application/account-deletion.js';
import { assertJoinAllowed } from './player.js';

/** How long a revocation event is remembered for joins that were already in flight. */
const RECENT_MS = 5 * 60_000;

export class BanGuard {
  private readonly users = new Map<string, string>();
  private readonly recent = new Map<
    string,
    { at: number; reason: 'ACCOUNT_BANNED' | 'ACCOUNT_DELETED' }
  >();
  private readonly onBan = (msg: unknown): void => {
    const id = (msg as { userId?: string } | null)?.userId;
    if (typeof id === 'string') this.ban(id);
  };
  private readonly onDeleted = (msg: unknown): void => {
    const id = (msg as { userId?: string } | null)?.userId;
    if (typeof id === 'string') this.revoke(id, 'ACCOUNT_DELETED');
  };

  /**
   * @param room - The room this guard protects.
   */
  constructor(private readonly room: Room) {}

  /** Start listening for account revocation (call from onCreate). */
  async attach(): Promise<void> {
    await this.room.presence?.subscribe(BAN_CHANNEL, this.onBan);
    await this.room.presence?.subscribe(ACCOUNT_DELETED_CHANNEL, this.onDeleted);
  }

  /** Stop listening (call from onDispose). */
  async detach(): Promise<void> {
    await this.room.presence?.unsubscribe(BAN_CHANNEL, this.onBan);
    await this.room.presence?.unsubscribe(ACCOUNT_DELETED_CHANNEL, this.onDeleted);
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
    this.revoke(userId, 'ACCOUNT_BANNED');
  }

  private revoke(userId: string, reason: 'ACCOUNT_BANNED' | 'ACCOUNT_DELETED'): void {
    const now = Date.now();
    for (const [id, event] of this.recent) if (now - event.at > RECENT_MS) this.recent.delete(id);
    this.recent.set(userId, { at: now, reason });
    this.kickUser(userId, reason);
  }

  /**
   * Close every session of a user in this room.
   * @param userId - The player whose access was revoked.
   * @param reason - The revocation reason sent to the client.
   */
  kickUser(userId: string, reason: 'ACCOUNT_BANNED' | 'ACCOUNT_DELETED' = 'ACCOUNT_BANNED'): void {
    for (const client of [...this.room.clients]) {
      if (this.users.get(client.sessionId) === userId)
        client.leave(reason === 'ACCOUNT_BANNED' ? 4003 : 4004, reason);
    }
  }

  /**
   * Last check before a join completes. Call with no await between it and the step that
   * makes the player visible in the room.
   * @param userId - The verified user.
   * @throws Error `ACCOUNT_BANNED` or `ACCOUNT_DELETED`.
   */
  async confirm(userId: string): Promise<void> {
    if (userId === '') return;
    const event = this.recent.get(userId);
    if (event !== undefined && Date.now() - event.at <= RECENT_MS) throw new Error(event.reason);
    await assertJoinAllowed(userId);
    // A revocation event can land while assertJoinAllowed was awaiting.
    const late = this.recent.get(userId);
    if (late !== undefined && Date.now() - late.at <= RECENT_MS) throw new Error(late.reason);
  }
}
