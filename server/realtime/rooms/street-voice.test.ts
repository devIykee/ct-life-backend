/**
 * Street room voice membership (capability `streetVoice`): a real StreetRoom
 * with RedisPresence on the test Redis, driven directly (no matchmaker).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RedisPresence } from 'colyseus';
import { PlayerState } from '../../../contract/realtime/states.js';
import { setIslandGeometry } from '../movement.js';
import { createRedis } from '../../shared/redis/client.js';
import { streetMembersKey } from '../street-presence.js';

vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  return { ...real, authenticateJoin: async (o: { userId: string }) => o.userId };
});

const { StreetRoom } = await import('./street.js');

const ISLAND: Array<[number, number]> = [
  [-1000, -1000],
  [1000, -1000],
  [1000, 1000],
  [-1000, 1000],
];

class VoiceStreet extends StreetRoom {
  voiceOn = true;
  removed: Array<[string, string, string]> = [];
  over: string[] = [];
  protected override loadPlayer(userId: string): Promise<PlayerState> {
    const p = new PlayerState();
    p.userId = userId;
    return Promise.resolve(p);
  }
  protected override streetVoiceOn(): boolean {
    return this.voiceOn;
  }
  protected override async removeFromVoice(d: string, i: string, u: string): Promise<void> {
    this.removed.push([d, i, u]);
  }
  protected override async overVoiceCap(userIds: readonly string[]): Promise<string[]> {
    return userIds.filter((u) => this.over.includes(u));
  }
  sweep(): Promise<void> {
    return this.sweepVoiceMinutes();
  }
}

const redis = createRedis().main;
const keys: string[] = [];

async function boot(voiceOn: boolean): Promise<VoiceStreet> {
  setIslandGeometry({ island: [ISLAND], districts: { timeline: ISLAND } });
  const room = new VoiceStreet();
  room.voiceOn = voiceOn;
  const r = room as unknown as Record<string, unknown>;
  r.presence = new RedisPresence(redis);
  await room.onCreate({ district: 'timeline' });
  keys.push(streetMembersKey('timeline', room.state.instanceId));
  return room;
}

function client(sessionId: string): {
  sessionId: string;
  sent: string[];
  send: (t: string) => void;
} {
  const sent: string[] = [];
  return { sessionId, sent, send: (t) => sent.push(t) };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

afterEach(async () => {
  setIslandGeometry(null);
  if (keys.length) await redis.del(...keys.splice(0));
});

describe('street room voice membership', () => {
  it('counts a session before welcome, removes the last leaver from voice, clears on dispose', async () => {
    const room = await boot(true);
    const key = streetMembersKey('timeline', room.state.instanceId);
    const c1 = client('sv-1');
    const c2 = client('sv-2');
    // Written before welcome: the client's first token request finds it.
    const sendSpy = vi.fn(async () => expect(await redis.hget(key, 'u1')).toBe('1'));
    c1.send = (t: string) => {
      c1.sent.push(t);
      if (t === 'welcome') void sendSpy();
    };
    await room.onJoin(c1 as never, { userId: 'u1' });
    expect(c1.sent).toContain('welcome');
    await tick();
    expect(sendSpy).toHaveBeenCalled();
    expect(await redis.hget(key, 'u1')).toBe('1');
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    // A second session of the same user: leaving one keeps them in voice.
    await room.onJoin(c2 as never, { userId: 'u1' });
    room.onLeave(c2 as never);
    await tick();
    expect(await redis.hget(key, 'u1')).toBe('1');
    expect(room.removed).toEqual([]);
    // The last session leaving (also what a ban does) takes them out of the LiveKit room.
    room.onLeave(c1 as never);
    await tick();
    expect(await redis.hget(key, 'u1')).toBe('0');
    expect(room.removed).toEqual([['timeline', room.state.instanceId, 'u1']]);
    await room.onJoin(client('sv-3') as never, { userId: 'u2' });
    await room.onDispose();
    await tick();
    expect(await redis.exists(key)).toBe(0);
  });

  it('writes nothing and calls LiveKit for nothing while streetVoice is off', async () => {
    const room = await boot(false);
    const key = streetMembersKey('timeline', room.state.instanceId);
    const c = client('sv-off');
    await room.onJoin(c as never, { userId: 'u1' });
    expect(c.sent).toContain('welcome');
    room.onLeave(c as never);
    await tick();
    expect(await redis.exists(key)).toBe(0);
    expect(room.removed).toEqual([]);
    await room.onDispose();
  });

  it('the minutes sweep disconnects only connected members past their cap', async () => {
    const room = await boot(true);
    await room.onJoin(client('sw-1') as never, { userId: 'u1' });
    await room.onJoin(client('sw-2') as never, { userId: 'u2' });
    await room.onJoin(client('sw-3') as never, { userId: 'u2' });
    room.over = ['u2', 'not-here'];
    await room.sweep();
    expect(room.removed).toEqual([['timeline', room.state.instanceId, 'u2']]);
    await room.onDispose();
  });
});
