/**
 * Space + Video-call realtime tests.
 *
 * Smoke tests against @colyseus/testing. We construct the rooms
 * directly (no matchmaker) and assert that the schema patches
 * fire as expected. The LiveKit integration is tested at the
 * service layer; this test stays at the schema/state level.
 */
import { describe, it, expect } from 'vitest';
import { Room } from 'colyseus';
import { SpaceRoom } from './space.js';
import { VideoCallRoom } from './video-call.js';

interface FakeClient {
  sessionId: string;
  send: (type: string, payload: unknown) => void;
}

async function newRoom<T extends Room>(
  Ctor: new () => T,
  options: Record<string, unknown>,
): Promise<T> {
  const r = new Ctor();
  // The @colyseus/testing helpers are heavier than we need here.
  // We just exercise onCreate + onJoin directly.
  await (r as unknown as { onCreate: (o: Record<string, unknown>) => Promise<void> }).onCreate(
    options,
  );
  return r;
}

describe('SpaceRoom', () => {
  it('host joins as host with canPublish=true; listener joins as listener', async () => {
    const room = await newRoom(SpaceRoom, {});
    const host: FakeClient = { sessionId: 's1', send: () => undefined };
    const listener: FakeClient = { sessionId: 's2', send: () => undefined };
    await (
      room as unknown as { onJoin: (c: FakeClient, o: Record<string, unknown>) => void }
    ).onJoin(host, { userId: 'host-1', hostUserId: 'host-1' });
    await (
      room as unknown as { onJoin: (c: FakeClient, o: Record<string, unknown>) => void }
    ).onJoin(listener, { userId: 'l-1', hostUserId: 'host-1' });
    const hostSp = room.state.speakers.get('host-1');
    const listenerSp = room.state.speakers.get('l-1');
    expect(hostSp?.role).toBe('host');
    expect(hostSp?.canPublish).toBe(true);
    expect(listenerSp?.role).toBe('listener');
    expect(listenerSp?.canPublish).toBe(false);
  });

  it('raise/lower hand + promote + demote cycle', async () => {
    const room = await newRoom(SpaceRoom, {});
    const host: FakeClient = { sessionId: 's1', send: () => undefined };
    const listener: FakeClient = { sessionId: 's2', send: () => undefined };
    const api = room as unknown as {
      onJoin: (c: FakeClient, o: Record<string, unknown>) => void;
      onRaiseHand: (u: string) => void;
      onLowerHand: (u: string) => void;
      onPromote: (u: string) => void;
      onDemote: (u: string) => void;
    };
    api.onJoin(host, { userId: 'h', hostUserId: 'h' });
    api.onJoin(listener, { userId: 'l', hostUserId: 'h' });
    api.onRaiseHand('l');
    expect(room.state.handQueue).toEqual(['l']);
    expect(room.state.speakers.get('l')?.handRaised).toBe(true);
    api.onPromote('l');
    expect(room.state.speakers.get('l')?.role).toBe('speaker');
    expect(room.state.speakers.get('l')?.canPublish).toBe(true);
    expect(room.state.handQueue).toEqual([]);
    api.onDemote('l');
    expect(room.state.speakers.get('l')?.role).toBe('listener');
    expect(room.state.speakers.get('l')?.canPublish).toBe(false);
    api.onRaiseHand('l');
    api.onLowerHand('l');
    expect(room.state.handQueue).toEqual([]);
  });

  it('hand queue preserves insertion order', async () => {
    const room = await newRoom(SpaceRoom, {});
    const host: FakeClient = { sessionId: 's0', send: () => undefined };
    const api = room as unknown as {
      onJoin: (c: FakeClient, o: Record<string, unknown>) => void;
      onRaiseHand: (u: string) => void;
    };
    api.onJoin(host, { userId: 'h', hostUserId: 'h' });
    api.onJoin({ sessionId: 's1', send: () => undefined }, { userId: 'a', hostUserId: 'h' });
    api.onJoin({ sessionId: 's2', send: () => undefined }, { userId: 'b', hostUserId: 'h' });
    api.onJoin({ sessionId: 's3', send: () => undefined }, { userId: 'c', hostUserId: 'h' });
    api.onRaiseHand('a');
    api.onRaiseHand('b');
    api.onRaiseHand('c');
    expect(room.state.handQueue).toEqual(['a', 'b', 'c']);
  });
});

describe('VideoCallRoom', () => {
  it('tracks participants and welcome fires on join', async () => {
    const room = await newRoom(VideoCallRoom, {
      callId: 'c-1',
      hostUserId: 'h',
      kind: 'video',
    });
    const host: FakeClient = { sessionId: 's1', send: () => undefined };
    let welcomeFired = false;
    const guest: FakeClient = {
      sessionId: 's2',
      send: (type: string) => {
        if (type === 'welcome') welcomeFired = true;
      },
    };
    await (
      room as unknown as { onJoin: (c: FakeClient, o: Record<string, unknown>) => void }
    ).onJoin(host, { userId: 'h' });
    await (
      room as unknown as { onJoin: (c: FakeClient, o: Record<string, unknown>) => void }
    ).onJoin(guest, { userId: 'g' });
    expect(welcomeFired).toBe(true);
    expect(room.state.participantUserIds.sort()).toEqual(['g', 'h']);
    expect(room.state.kind).toBe('video');
  });
});
