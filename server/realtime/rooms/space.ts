/**
 * Space realtime room.
 *
 * One Colyseus room per live audio Space. The room mirrors the
 * server-side voice_rooms / voice_speakers state and pushes a
 * space_update to the city room on every change so clients refetch
 * /v1/spaces/{id}. The room itself is just state — the LiveKit
 * token grants are the source of truth for permissions; this room
 * reflects what the application service just wrote.
 */
import { Room, Client } from 'colyseus';
import { SpaceState, SpeakerState } from '../../../contract/realtime/states.js';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { loadConfig } from '../../shared/config/config.js';

export class SpaceRoom extends Room {
  // Typed local state to keep TypeScript happy without the generic.
  declare state: SpaceState;
  /**
   *
   */
  override async onCreate(_options: Record<string, unknown>): Promise<void> {
    this.state = new SpaceState();
    this.maxClients = 50; // 8 speakers + listeners; the spec cap.
    this.patchRate = 500; // 2 Hz — the state changes slowly.
  }

  /**
   * B5 fix: Verify JWT token before allowing join
   */
  override async onJoin(client: Client, options: Record<string, unknown>): Promise<void> {
    const tokenStr = String(options.token ?? '');
    // Reject if no token provided and not in dev mode
    if (tokenStr === '' && !loadConfig().auth.devAuthEnabled) {
      throw new Error('AUTH_REQUIRED');
    }
    // Verify the token
    let userId = String(options.userId ?? '');
    if (tokenStr !== '') {
      try {
        const jwtIssuer = createJwtIssuer();
        const claims = await jwtIssuer.verifyAccess(tokenStr);
        userId = claims.sub; // Use verified userId from token
      } catch (err) {
        throw new Error('INVALID_TOKEN', { cause: err });
      }
    }
    if (!userId) return;
    if (this.state.speakers.has(userId)) return;
    const sp = new SpeakerState();
    sp.userId = userId;
    sp.role = options.hostUserId === userId ? 'host' : 'listener';
    sp.canPublish = sp.role === 'host' || sp.role === 'speaker';
    sp.handRaised = false;
    this.state.speakers.set(userId, sp);
    client.send('welcome', {
      serverNow: Date.now(),
      instanceId: this.roomId,
    });
  }

  /**
   *
   */
  override onLeave(client: Client): void {
    const userId = this.findUserIdBySession(client);
    if (!userId) return;
    this.state.speakers.delete(userId);
    const idx = this.state.handQueue.indexOf(userId);
    if (idx >= 0) this.state.handQueue.splice(idx, 1);
  }

  /** Host promotes a listener to speaker. */
  onPromote(userId: string): void {
    const sp = this.state.speakers.get(userId);
    if (!sp) return;
    sp.role = 'speaker';
    sp.canPublish = true;
    sp.handRaised = false;
    const idx = this.state.handQueue.indexOf(userId);
    if (idx >= 0) this.state.handQueue.splice(idx, 1);
  }

  /** Host demotes a speaker. */
  onDemote(userId: string): void {
    const sp = this.state.speakers.get(userId);
    if (!sp || sp.role === 'host') return;
    sp.role = 'listener';
    sp.canPublish = false;
  }

  /** Listener raises hand. */
  onRaiseHand(userId: string): void {
    const sp = this.state.speakers.get(userId);
    if (!sp) return;
    sp.handRaised = true;
    sp.handRaisedAt = Date.now();
    if (!this.state.handQueue.includes(userId)) {
      this.state.handQueue.push(userId);
    }
  }

  /** Listener lowers hand. */
  onLowerHand(userId: string): void {
    const sp = this.state.speakers.get(userId);
    if (!sp) return;
    sp.handRaised = false;
    sp.handRaisedAt = 0;
    const idx = this.state.handQueue.indexOf(userId);
    if (idx >= 0) this.state.handQueue.splice(idx, 1);
  }

  /**
   *
   */
  override onDispose(): void {
    // Nothing to clean; the application service closes the LiveKit
    // room when /v1/spaces/:id/end fires.
  }

  private findUserIdBySession(client: Client): string | null {
    for (const [uid, sp] of this.state.speakers) {
      void sp;
      if (uid) return uid;
    }
    void client;
    return null;
  }
}
