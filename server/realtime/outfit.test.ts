/**
 * Rooms apply outfit changes from the api and nobody else can set one.
 */
import { describe, expect, it, vi } from 'vitest';
import { LocalPresence } from 'colyseus';
import { MapSchema } from '@colyseus/schema';
import { PlayerState } from '../../contract/realtime/states.js';
import { OUTFIT_CHANNEL, setIslandGeometry } from './movement.js';
import { applyOutfitMessage } from './player.js';

vi.mock('./player.js', async (orig) => ({
  ...(await orig<typeof import('./player.js')>()),
  authenticateJoin: async (o: { userId: string }) => o.userId,
}));

const { StreetRoom } = await import('./rooms/street.js');

class TestStreet extends StreetRoom {
  protected override loadPlayer(userId: string): Promise<PlayerState> {
    const p = new PlayerState();
    p.userId = userId;
    return Promise.resolve(p);
  }
}

const player = (userId: string, outfit?: string): PlayerState => {
  const p = new PlayerState();
  p.userId = userId;
  p.outfit = outfit;
  return p;
};

describe('applyOutfitMessage', () => {
  it('sets and clears the outfit only for the named user', () => {
    const players = new MapSchema<PlayerState>();
    players.set('s1', player('u1'));
    players.set('s2', player('u2'));
    applyOutfitMessage(players, { userId: 'u1', outfit: 'rekt_burger_crew' });
    expect(players.get('s1')!.outfit).toBe('rekt_burger_crew');
    expect(players.get('s2')!.outfit).toBeUndefined();
    applyOutfitMessage(players, { userId: 'u1', outfit: null });
    expect(players.get('s1')!.outfit).toBeUndefined();
  });

  it('ignores malformed messages', () => {
    const players = new MapSchema<PlayerState>();
    players.set('s1', player('u1', 'rekt_burger_crew'));
    for (const bad of [null, 'x', {}, { userId: 5, outfit: 'a' }, { userId: 'u1', outfit: 7 }]) {
      applyOutfitMessage(players, bad);
    }
    expect(players.get('s1')!.outfit).toBe('rekt_burger_crew');
  });
});

describe('StreetRoom', () => {
  async function boot() {
    setIslandGeometry({
      island: [
        [
          [-1000, -1000],
          [1000, -1000],
          [1000, 1000],
          [-1000, 1000],
        ],
      ],
      districts: {
        timeline: [
          [-1000, -1000],
          [0, -1000],
          [0, 1000],
          [-1000, 1000],
        ],
      },
    } as never);
    const presence = new LocalPresence();
    const room = new TestStreet() as unknown as Record<string, any>;
    room.presence = presence;
    room.setSimulationInterval = () => undefined;
    await room.onCreate({ district: 'timeline' });
    const client = { sessionId: 's1', send: vi.fn() };
    await room.onJoin(client, { userId: 'u1' });
    return { room, presence, client };
  }
  const outfitOf = (room: Record<string, any>) => room.sessions.get('s1').player.outfit;

  it('applies an outfit message from the api to the joined player, and a clear', async () => {
    const { room, presence } = await boot();
    expect(outfitOf(room)).toBeUndefined();
    presence.publish(OUTFIT_CHANNEL, { userId: 'u1', outfit: 'rekt_burger_crew' });
    expect(outfitOf(room)).toBe('rekt_burger_crew');
    presence.publish(OUTFIT_CHANNEL, { userId: 'u2', outfit: null }); // someone else
    expect(outfitOf(room)).toBe('rekt_burger_crew');
    presence.publish(OUTFIT_CHANNEL, { userId: 'u1', outfit: null });
    expect(outfitOf(room)).toBeUndefined();
  });

  it('a client cannot set it: no message carries an outfit into the state', async () => {
    const { room, client } = await boot();
    const handlers = room.onMessageEvents.events as Record<
      string,
      Array<(c: unknown, m: unknown) => unknown>
    >;
    for (const name of ['move', 'emote', 'say', 'talking']) {
      handlers[name]?.[0]?.(client, {
        x: 1,
        z: 1,
        outfit: 'rekt_burger_crew',
        id: 'e',
        text: 'hi',
        on: true,
      });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(outfitOf(room)).toBeUndefined();
    // And the state schema has the field server-side only (no setter message exists).
    expect(Object.keys(handlers)).not.toContain('outfit');
    expect(Object.keys(handlers)).not.toContain('set_outfit');
  });
});
