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

export class VideoCallRoom extends Room {
  // Typed local state to keep TypeScript happy without the generic.
  declare state: VideoCallState;
  /**
   *
   */
  override async onCreate(options: Record<string, unknown>): Promise<void> {
    this.state = new VideoCallState();
    this.state.callId = String(options['callId'] ?? '');
    this.state.hostUserId = String(options['hostUserId'] ?? '');
    this.state.kind = options['kind'] === 'paid_call' ? 'paid_call' : 'video';
    this.maxClients = 8;
    this.patchRate = 1000; // 1 Hz
  }

  /**
   *
   */
  override onJoin(client: Client, options: Record<string, unknown>): void {
    const userId = String(options.userId ?? '');
    if (!userId) return;
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
    void client;
    // The application service writes left_at on voice_speakers
    // when the LiveKit webhook fires; we don't track per-session
    // identity here.
  }

  /**
   *
   */
  override onDispose(): void {
    // No state to persist; LiveKit closing is the source of truth.
  }
}
