/** A targeted credential/session departure must not remove another user's game-room presence. */
import { describe, expect, it, vi } from 'vitest';
import { SpaceRoom } from './space.js';
import { VideoCallRoom } from './video-call.js';
import { SpaceState, VideoCallState } from '../../../contract/realtime/states.js';
vi.mock('../player.js', async (orig) => ({
  ...(await orig<typeof import('../player.js')>()),
  authenticateJoinIdentity: async (o: { userId: string }) => ({
    userId: o.userId,
    credential: null,
  }),
}));
const mk = (sessionId: string) => ({ sessionId, send: () => {}, leave: () => {} });
for (const kind of ['space', 'video'] as const)
  describe(`${kind} credential-session cleanup`, () => {
    it('keeps sibling sessions and removes only the departing user on their final leave', async () => {
      const room = kind === 'space' ? new SpaceRoom() : new VideoCallRoom();
      Object.assign(room, { state: kind === 'space' ? new SpaceState() : new VideoCallState() });
      const first = mk('a1'),
        sibling = mk('a2'),
        other = mk('b1');
      await room.onJoin(first as never, { userId: 'a' });
      await room.onJoin(sibling as never, { userId: 'a' });
      await room.onJoin(other as never, { userId: 'b' });
      const users = () =>
        kind === 'space'
          ? [...(room.state as SpaceState).speakers.keys()]
          : Array.from((room.state as VideoCallState).participantUserIds);
      room.onLeave(other as never);
      expect(users()).toEqual(['a']);
      room.onLeave(first as never);
      expect(users()).toEqual(['a']);
      room.onLeave(sibling as never);
      expect(users()).toEqual([]);
      await room.onDispose();
    });
  });
