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
import { authenticateJoinIdentity } from '../player.js';
import { BanGuard } from '../ban-guard.js';

export class VideoCallRoom extends Room {
  private readonly ban = new BanGuard(this);
  private readonly usersBySession = new Map<string, string>();
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
    const identity = await authenticateJoinIdentity(options, String(options.userId ?? ''));
    const userId = identity.userId;
    if (userId === '') return;
    this.ban.track(client, identity);
    await this.ban.confirm(client);
    this.usersBySession.set(client.sessionId, userId);
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
    const userId = this.usersBySession.get(client.sessionId);
    this.usersBySession.delete(client.sessionId);
    if (!userId || [...this.usersBySession.values()].includes(userId)) return;
    const index = this.state.participantUserIds.indexOf(userId);
    if (index >= 0) this.state.participantUserIds.splice(index, 1);
    // LiveKit webhooks remain authoritative for media presence; this list tracks game-room sessions.
  }

  /**
   *
   */
  override async onDispose(): Promise<void> {
    await this.ban.detach();
    this.usersBySession.clear();
    // No state to persist; LiveKit closing is the source of truth.
  }
}
