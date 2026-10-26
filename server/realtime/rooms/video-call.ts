/**
 * Video-call realtime room.
 *
 * One Colyseus room per live video or paid call. Mirrors the
 * voice_rooms state for the call kind. Free video calls use this
 * room; paid calls use the same shape plus the escrow status
 * reflected in the contract's `status` field.
 */
import { Room, Client } from 'colyseus';
import { VideoCallState } from '../../../contract/realtime/states.js';
import { createJwtIssuer } from '../../shared/auth/jwt.js';
import { loadConfig } from '../../shared/config/config.js';
import { assertJoinAllowed } from '../player.js';
import { BanGuard } from '../ban-guard.js';

export class VideoCallRoom extends Room {
  private readonly ban = new BanGuard(this);
  // Typed local state to keep TypeScript happy without the generic.
  declare state: VideoCallState;
  /**
   *
   */
  override async onCreate(options: Record<string, unknown>): Promise<void> {
    await this.ban.attach();
    this.state = new VideoCallState();
    this.state.callId = String(options['callId'] ?? '');
    this.state.hostUserId = String(options['hostUserId'] ?? '');
    this.state.kind = options['kind'] === 'paid_call' ? 'paid_call' : 'video';
    this.maxClients = 8;
    this.patchRate = 1000; // 1 Hz
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
      await assertJoinAllowed(userId);
    }
    if (!userId) return;
    this.ban.track(client, userId);
    if (!this.state.participantUserIds.includes(userId)) {
      this.state.participantUserIds.push(userId);
    }
    client.send('welcome', {
      serverNow: Date.now(),
      instanceId: this.roomId,
    });
  }

  /**
   *
   */
  override onLeave(client: Client): void {
    this.ban.untrack(client);
    void client;
    // The application service writes left_at on voice_speakers
    // when the LiveKit webhook fires; we don't track per-session
    // identity here.
  }

  /**
   *
   */
  override async onDispose(): Promise<void> {
    await this.ban.detach();
    // No state to persist; LiveKit closing is the source of truth.
  }
}
