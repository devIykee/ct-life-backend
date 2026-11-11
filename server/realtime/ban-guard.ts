/** Account and credential revocation shared by every persistent game room. */
import type { Client, Room } from 'colyseus';
import { BAN_CHANNEL } from '../application/moderation.js';
import { ACCOUNT_DELETED_CHANNEL } from '../application/account-deletion.js';
import {
  LOGIN_IDENTITY_REVOKED_CHANNEL,
  assertLoginCredential,
  invalidLoginCredentials,
  type LoginCredential,
} from '../application/login-credentials.js';
import { assertJoinAllowed, type RoomJoinIdentity } from './player.js';

const RECENT_MS = 5 * 60_000;
const RECHECK_MS = 15_000;
const AUTHORITY_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type AccountReason = 'ACCOUNT_BANNED' | 'ACCOUNT_DELETED';
const credentialKey = (c: LoginCredential): string => `${c.userId}:${c.identityId}:${c.version}`;

export class BanGuard {
  private readonly users = new Map<string, RoomJoinIdentity>();
  private readonly recent = new Map<string, { at: number; reason: AccountReason }>();
  private readonly revoked = new Map<string, { at: number; userId: string; minVersion: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private attached = false;
  private epoch = 0;
  private rechecking: object | null = null;
  private subscriptions: { channel: string; handler: (message: unknown) => void }[] = [];
  private readonly onBan = (msg: unknown): void => {
    const id = (msg as { userId?: string } | null)?.userId;
    if (typeof id === 'string') this.ban(id);
  };
  private readonly onDeleted = (msg: unknown): void => {
    const id = (msg as { userId?: string } | null)?.userId;
    if (typeof id === 'string') this.revokeAccount(id, 'ACCOUNT_DELETED');
  };
  private readonly onIdentityRevoked = (msg: unknown): void => {
    const event = msg as { userId?: unknown; identityId?: unknown; minVersion?: unknown } | null;
    if (
      !event ||
      typeof event.userId !== 'string' ||
      !UUID.test(event.userId) ||
      typeof event.identityId !== 'string' ||
      !UUID.test(event.identityId) ||
      !Number.isSafeInteger(event.minVersion) ||
      Number(event.minVersion) < 1 ||
      Number(event.minVersion) > 2147483647
    )
      return;
    const { userId, identityId } = event;
    const minVersion = Number(event.minVersion);
    // Untracked identities need no cache: their next join checks durable state.
    if (
      ![...this.users.values()].some(
        (s) => s.credential?.identityId === identityId && s.userId === userId,
      )
    )
      return;
    this.prune();
    const previous = this.revoked.get(identityId);
    this.revoked.set(identityId, {
      at: Date.now(),
      userId,
      minVersion: Math.max(previous?.userId === userId ? previous.minVersion : 0, minVersion),
    });
    for (const client of [...this.room.clients]) {
      const credential = this.users.get(client.sessionId)?.credential;
      if (
        credential?.userId === userId &&
        credential.identityId === identityId &&
        credential.version < minVersion
      )
        client.leave(4005, 'AUTH_IDENTITY_REVOKED');
    }
  };

  /** @param room - The room whose sessions are protected. */
  constructor(private readonly room: Room) {}

  /** Subscribe once and start bounded, non-overlapping durable revalidation. */
  async attach(): Promise<void> {
    if (this.attached) return;
    this.attached = true;
    const epoch = ++this.epoch;
    try {
      for (const [channel, callback] of [
        [BAN_CHANNEL, this.onBan],
        [ACCOUNT_DELETED_CHANNEL, this.onDeleted],
        [LOGIN_IDENTITY_REVOKED_CHANNEL, this.onIdentityRevoked],
      ] as const) {
        // Each attachment owns a distinct listener, including a subscription that
        // finishes after disposal. Its cleanup cannot unsubscribe a replacement.
        const handler = (message: unknown): void => {
          if (this.attached && this.epoch === epoch) callback(message);
        };
        this.subscriptions.push({ channel, handler });
        await this.room.presence?.subscribe(channel, handler);
        if (!this.attached || this.epoch !== epoch) {
          await this.room.presence?.unsubscribe(channel, handler);
          return;
        }
      }
      this.timer = setInterval(() => {
        void this.recheck();
      }, RECHECK_MS);
      this.timer.unref();
    } catch (error) {
      if (this.attached && this.epoch === epoch) await this.detach();
      throw error;
    }
  }

  /** Stop subscriptions/timers and discard pending results when a room closes. */
  async detach(): Promise<void> {
    this.attached = false;
    this.epoch++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.users.clear();
    this.recent.clear();
    this.revoked.clear();
    this.rechecking = null;
    const subscriptions = this.subscriptions.splice(0);
    await Promise.allSettled(
      subscriptions.map(({ channel, handler }) =>
        this.room.presence?.unsubscribe(channel, handler),
      ),
    );
  }

  /**
   * Track immediately after authentication, before any further join await.
   * @param client - The joining client.
   * @param identity - Verified user and original credential generation.
   */
  track(client: Client, identity: RoomJoinIdentity): void {
    if (identity.userId === '') return;
    if (identity.credential && identity.credential.userId !== identity.userId)
      throw new Error('INVALID_TOKEN');
    this.users.set(client.sessionId, {
      userId: identity.userId,
      credential: identity.credential ? { ...identity.credential } : null,
    });
  }

  /** @param client - Session leaving this room. */
  untrack(client: Client): void {
    this.users.delete(client.sessionId);
  }

  /** @param userId - The banned player. */
  ban(userId: string): void {
    this.revokeAccount(userId, 'ACCOUNT_BANNED');
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, event] of this.recent) if (now - event.at > RECENT_MS) this.recent.delete(id);
    for (const [id, event] of this.revoked) if (now - event.at > RECENT_MS) this.revoked.delete(id);
  }

  private revokeAccount(userId: string, reason: AccountReason): void {
    this.prune();
    this.recent.set(userId, { at: Date.now(), reason });
    this.kickUser(userId, reason);
  }

  /**
   * Close all credentials of an account for account-wide moderation/deletion.
   * @param userId - The affected player.
   * @param reason - The account-wide reason.
   */
  kickUser(userId: string, reason: AccountReason = 'ACCOUNT_BANNED'): void {
    for (const client of [...this.room.clients])
      if (this.users.get(client.sessionId)?.userId === userId)
        client.leave(reason === 'ACCOUNT_BANNED' ? 4003 : 4004, reason);
  }

  private assertCurrent(client: Client, identity: RoomJoinIdentity): void {
    const account = this.recent.get(identity.userId);
    if (account && Date.now() - account.at <= RECENT_MS) throw new Error(account.reason);
    const credential = identity.credential;
    const event = credential && this.revoked.get(credential.identityId);
    if (
      event &&
      event.userId === identity.userId &&
      Date.now() - event.at <= RECENT_MS &&
      credential.version < event.minVersion
    )
      throw new Error('AUTH_IDENTITY_REVOKED');
    if (this.users.get(client.sessionId) !== identity) throw new Error('JOIN_CANCELLED');
  }

  /** Capture the exact tracked join for synchronous checks after later awaits. */
  checkpoint(client: Client): () => void {
    const identity = this.users.get(client.sessionId);
    if (!identity) throw new Error('JOIN_CANCELLED');
    this.assertCurrent(client, identity);
    return () => this.assertCurrent(client, identity);
  }

  /**
   * Last await before publishing joined-player state. Recheck after every await.
   * @param client - Session previously tracked with its verified credential.
   */
  async confirm(client: Client): Promise<void> {
    const identity = this.users.get(client.sessionId);
    if (!identity) throw new Error('JOIN_CANCELLED');
    this.assertCurrent(client, identity);
    if (identity.credential) {
      await assertJoinAllowed(identity.userId);
      this.assertCurrent(client, identity);
      const { buildContext } = await import('../application/context.js');
      await assertLoginCredential(buildContext().db, identity.credential);
    }
    this.assertCurrent(client, identity);
  }

  /** Durable fallback for missed events. An unavailable authority closes only the captured sessions. */
  async recheck(): Promise<void> {
    if (!this.attached || this.rechecking) return;
    const snapshot = [...this.users].filter((entry) => entry[1].credential !== null);
    if (snapshot.length === 0) {
      this.prune();
      return;
    }
    const epoch = this.epoch;
    const check = {};
    this.rechecking = check;
    // A deadline bounds room access even if the driver never receives a reply.
    // Keep the no-overlap lock until the actual authority query settles; a late
    // result cannot act on a room after this deadline or attachment epoch ends.
    const authority = (async (): Promise<Set<string> | null> => {
      try {
        const { buildContext } = await import('../application/context.js');
        return new Set(
          (
            await invalidLoginCredentials(
              buildContext().db,
              snapshot.map((entry) => entry[1].credential!),
            )
          ).map(credentialKey),
        );
      } catch {
        return null;
      } finally {
        if (this.rechecking === check) this.rechecking = null;
      }
    })();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const unavailable = new Promise<null>((resolve) => {
      deadline = setTimeout(() => resolve(null), AUTHORITY_TIMEOUT_MS);
      deadline.unref();
    });
    let invalid: Set<string> | null;
    try {
      invalid = await Promise.race([authority, unavailable]);
    } finally {
      clearTimeout(deadline);
    }
    if (!this.attached || this.epoch !== epoch) return;
    const clients = new Map(this.room.clients.map((client) => [client.sessionId, client]));
    for (const [sessionId, identity] of snapshot) {
      if (this.users.get(sessionId) !== identity) continue; // A replacement session must not inherit an old result.
      if (invalid === null || invalid.has(credentialKey(identity.credential!))) {
        // Mark the captured scope cancelled before asynchronous transport/onLeave cleanup.
        this.users.delete(sessionId);
        const client = clients.get(sessionId);
        client?.leave(
          invalid === null ? 4006 : 4005,
          invalid === null ? 'AUTH_STATE_UNAVAILABLE' : 'AUTH_IDENTITY_REVOKED',
        );
      }
    }
    this.prune();
  }
}
