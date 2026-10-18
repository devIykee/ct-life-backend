/**
 * Venue room smoke (M2 stub).
 *
 * Boots the Colyseus realtime server in-process via @colyseus/testing
 * to confirm the wiring of schemas, decorators, and the
 * composition root works end-to-end. The deeper tests (move
 * validation, sit/stand, emote rate limits, say sanitisation,
 * npc_tap) require a fully wired Colyseus matchmaker with a Redis
 * presence layer and land in M3 alongside the load test (M2 #35).
 */
import { describe, expect, it, vi } from 'vitest';
import { VenueRoom } from './venue.js';
import { VenueState, NpcState, PlayerState } from '../../../contract/realtime/states.js';
import { createBrain } from '../../../packages/npc-brain/src/index.js';

vi.mock('../player.js', async (orig) => {
  const real = await orig<typeof import('../player.js')>();
  const { PlayerState: PS } = await import('../../../contract/realtime/states.js');
  return {
    ...real,
    authenticateJoin: async () => 'u1',
    loadPlayerState: async (id: string) => Object.assign(new PS(), { userId: id }),
  };
});

describe('venue room (M2 stub)', () => {
  it('the VenueRoom class is loadable and instantiable', () => {
    // Compile-time check that the class is constructable. The
    // actual room lifecycle is exercised in M3.
    const room = new VenueRoom();
    expect(room).toBeDefined();
  });

  it('VenueState can carry a player and an NPC', () => {
    const state = new VenueState();
    const player = new PlayerState();
    player.userId = 'u1';
    state.players.set('sess-1', player);
    const npc = new NpcState();
    const npcId = 'npc-0-town_crier';
    npc.archetypeId = 'town_crier';
    state.npcs.set(npcId, npc);
    expect(state.players.size).toBe(1);
    expect(state.npcs.size).toBe(1);
  });

  it('all 9 NPC archetypes instantiate', () => {
    const archetypes = [
      'town_crier',
      'giveaway_guy',
      'reply_guy',
      'perp_degen_npc',
      'rekt_guy',
      'wallet_tracker',
      'doomposter',
      'spaces_host',
      'ore_miner',
    ] as const;
    for (const a of archetypes) {
      const b = createBrain(a);
      expect(b.archetype).toBe(a);
    }
  });
});

describe('venue room movement', () => {
  async function joined(): Promise<{
    room: VenueRoom;
    player: PlayerState;
    sent: Array<{ type: string; payload: Record<string, unknown> }>;
    move: (m: unknown) => void;
  }> {
    const room = new VenueRoom();
    const r = room as unknown as Record<string, unknown>;
    r.setSimulationInterval = () => undefined;
    await room.onCreate({ venueId: 'timeline_square' });
    const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const client = {
      sessionId: 's1',
      send: (type: string, payload: Record<string, unknown>) => sent.push({ type, payload }),
    };
    await room.onJoin(client as never, {});
    const player = room.state.players.get('s1')!;
    const move = (m: unknown): void =>
      (r.handleMove as (c: unknown, m: unknown) => void).call(room, client, m);
    return { room, player, sent, move };
  }

  it('A1: joins on the entrance spot, not the walkable corner', async () => {
    const { player } = await joined();
    // timeline_square.entrance is (0, -14); walkable[0] starts at (-20, -15).
    expect(player.x).toBe(0);
    expect(player.z).toBe(-14);
  });

  it('A2: a jittery honest sprint passes, a teleport is clamped and corrected', async () => {
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { player, sent, move } = await joined();
      // 6 m/s, sent every 100 ms, arrivals bunched 30 ms apart then 170 ms.
      const gaps = [170, 30, 170, 30, 170, 30];
      gaps.forEach((g, i) => {
        now += g;
        move({ x: 0, z: -14 + 0.6 * (i + 1) });
      });
      expect(player.z).toBeCloseTo(-14 + 3.6);
      expect(sent.some((m) => m.type === 'corrected' || m.type === 'rejected')).toBe(false);

      now += 100;
      move({ x: 0, z: 10 });
      expect(player.z).toBeLessThan(-8);
      expect(sent.at(-1)?.type).toBe('corrected');
    } finally {
      spy.mockRestore();
    }
  });
});
