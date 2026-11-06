/**
 * Normie market waves: threshold, size, cap, cooldown, leave and yield, on
 * the pure state machine and in a real venue room (clock, mood and rng
 * injected; no database read for the mood).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SeededRng } from '../../packages/npc-brain/src/rng.js';
import {
  DEFAULT_NORMIE_WAVES,
  hostsNormieWaves,
  NORMIE_MAX_PER_INSTANCE,
  NORMIE_WAVE_VENUES,
  NormieWaves,
  type FreeSpot,
  type NormieStepInput,
} from './normie-waves.js';
import { _resetConfigForTests } from '../shared/config/config.js';

const T0 = 1_800_000_000_000;
const MIN = 60_000;
const spots = (n: number): FreeSpot[] =>
  Array.from({ length: n }, (_, i) => ({ spotId: `v.seat_${i + 1}`, animId: 'act_sit' }));

function input(over: Partial<NormieStepInput> = {}): NormieStepInput {
  return {
    nowMs: T0,
    moodBps: 500,
    npcCount: 2,
    freeSpots: spots(6),
    rng: new SeededRng(42),
    ...over,
  };
}

describe('normie waves: threshold and size', () => {
  it('starts a wave at the peak threshold, not below it', () => {
    expect(new NormieWaves().step(input({ moodBps: 299 })).spawn).toHaveLength(0);
    const w = new NormieWaves().step(input({ moodBps: DEFAULT_NORMIE_WAVES.peakBps }));
    expect(w.spawn.length).toBeGreaterThanOrEqual(2);
  });

  it('a wave is 2-4 normies, on distinct free spots in the order given', () => {
    const sizes = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) {
      const w = new NormieWaves().step(input({ rng: new SeededRng(seed) }));
      sizes.add(w.spawn.length);
      expect(w.spawn.map((s) => s.spotId)).toEqual(spots(w.spawn.length).map((s) => s.spotId));
      expect(new Set(w.spawn.map((s) => s.npcId)).size).toBe(w.spawn.length);
    }
    expect([...sizes].sort()).toEqual([2, 3, 4]);
  });
});

describe('normie waves: caps', () => {
  it('never takes the room past 12 NPCs', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const w = new NormieWaves().step(input({ npcCount: 10, rng: new SeededRng(seed) }));
      expect(w.spawn.length).toBeLessThanOrEqual(2);
    }
    expect(new NormieWaves().step(input({ npcCount: 12 })).spawn).toHaveLength(0);
  });

  it('a full room does not use up the cooldown: the wave comes once there is space', () => {
    const w = new NormieWaves();
    expect(w.step(input({ npcCount: 12 })).spawn).toHaveLength(0);
    expect(w.step(input({ nowMs: T0 + 1000, npcCount: 11 })).spawn).toHaveLength(1);
  });

  it('respects maxPerInstance and the number of free spots', () => {
    const cfg = { ...DEFAULT_NORMIE_WAVES, minSize: 4, maxSize: 4, maxPerInstance: 3 };
    expect(new NormieWaves(cfg).step(input()).spawn).toHaveLength(3);
    expect(new NormieWaves().step(input({ freeSpots: spots(1) })).spawn).toHaveLength(1);
    expect(new NormieWaves().step(input({ freeSpots: [] })).spawn).toHaveLength(0);
    expect(NORMIE_MAX_PER_INSTANCE).toBeGreaterThanOrEqual(DEFAULT_NORMIE_WAVES.maxSize);
  });

  it('matches archetypes.json normie.maxPerInstance', () => {
    const reg = JSON.parse(
      readFileSync(join(process.cwd(), 'contract', 'ids', 'archetypes.json'), 'utf8'),
    ) as { archetypes: Array<{ id: string; maxPerInstance?: number }> };
    expect(reg.archetypes.find((a) => a.id === 'normie')?.maxPerInstance).toBe(
      NORMIE_MAX_PER_INSTANCE,
    );
  });
});

describe('normie waves: leave and cooldown', () => {
  it('they leave after 3-5 minutes, walk out, and are removed', () => {
    const w = new NormieWaves();
    const first = w.step(input());
    const ids = first.spawn.map((s) => s.npcId);
    // Nobody leaves before 3 minutes.
    expect(w.step(input({ nowMs: T0 + 3 * MIN - 1 })).leave).toHaveLength(0);
    const leftAt = new Map<string, number>();
    const removedAt = new Map<string, number>();
    const walk = DEFAULT_NORMIE_WAVES.leaveWalkMs;
    for (let t = T0 + 3 * MIN; t <= T0 + 5 * MIN + walk; t += 1000) {
      const s = w.step(input({ nowMs: t }));
      for (const l of s.leave) {
        expect(l.reason).toBe('timeout');
        leftAt.set(l.npcId, t);
      }
      for (const id of s.remove) removedAt.set(id, t);
      expect(s.spawn).toHaveLength(0); // cooldown: no new wave yet
    }
    expect([...leftAt.keys()].sort()).toEqual([...ids].sort());
    expect(w.presentCount).toBe(0);
    // Each one is removed once its exit walk is done, not before.
    for (const id of ids) {
      expect(removedAt.get(id)! - leftAt.get(id)!).toBe(walk);
      expect(w.has(id)).toBe(false);
    }
  });

  it('they all leave as soon as the mood drops below the calm line', () => {
    const w = new NormieWaves();
    const ids = w.step(input()).spawn.map((s) => s.npcId);
    expect(w.step(input({ nowMs: T0 + 1000, moodBps: 150 })).leave).toHaveLength(0);
    const drop = w.step(input({ nowMs: T0 + 2000, moodBps: 99 }));
    expect(drop.leave.map((l) => l.npcId).sort()).toEqual([...ids].sort());
    expect(drop.leave.every((l) => l.reason === 'mood')).toBe(true);
  });

  it('one wave at a time, then a cooldown from the wave start even if the peak holds', () => {
    const w = new NormieWaves();
    expect(w.step(input()).spawn.length).toBeGreaterThan(0);
    expect(w.step(input({ nowMs: T0 + 1000 })).spawn).toHaveLength(0);
    // Mood dips, everyone leaves and is removed, then the peak comes back.
    w.step(input({ nowMs: T0 + 2000, moodBps: 0 }));
    w.step(input({ nowMs: T0 + 10_000, moodBps: 0 }));
    expect(w.step(input({ nowMs: T0 + 10 * MIN })).spawn).toHaveLength(0);
    expect(w.step(input({ nowMs: T0 + 15 * MIN - 1 })).spawn).toHaveLength(0);
    expect(w.step(input({ nowMs: T0 + 15 * MIN })).spawn.length).toBeGreaterThan(0);
  });

  it('a normie gives its seat up to a player', () => {
    const w = new NormieWaves();
    const [a] = w.step(input()).spawn;
    expect(w.yieldSpot(a!.npcId, T0 + 1000)).toBe(true);
    expect(w.yieldSpot(a!.npcId, T0 + 1000)).toBe(false);
    expect(w.yieldSpot('npc-0-town_crier', T0 + 1000)).toBe(false);
    expect(w.step(input({ nowMs: T0 + 1000 + 5000 })).remove).toEqual([a!.npcId]);
  });
});

describe('normie waves: venues', () => {
  it('the trading venues host waves from phase 2 only', () => {
    expect(NORMIE_WAVE_VENUES).toEqual(['timeline_square', 'terminal_cafe', 'launchpad_tower']);
    for (const v of NORMIE_WAVE_VENUES) {
      expect(hostsNormieWaves(v, 2)).toBe(true);
      expect(hostsNormieWaves(v, 1)).toBe(false);
    }
    expect(hostsNormieWaves('cabal_lounge', 6)).toBe(false);
  });
});

describe('normie waves in a venue room', () => {
  const saved = process.env.LIVE_PHASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_PHASE;
    else process.env.LIVE_PHASE = saved;
    _resetConfigForTests();
    vi.restoreAllMocks();
  });

  async function room(venueId: string, phase = '6') {
    process.env.LIVE_PHASE = phase;
    _resetConfigForTests();
    const { VenueRoom } = await import('./rooms/venue.js');
    const r = new VenueRoom();
    const raw = r as unknown as Record<string, unknown>;
    raw.setSimulationInterval = () => undefined;
    await r.onCreate({ venueId });
    // The mood is injected: no database read from the tick.
    raw.refreshPulse = () => undefined;
    raw.rng = new SeededRng(9);
    const setMood = (bps: number): void => {
      raw.moodBps = bps;
    };
    const tick = (raw.tickNpcs as (dt: number) => void).bind(r);
    const normies = () => [...r.state.npcs.entries()].filter(([, n]) => n.archetypeId === 'normie');
    return { r, raw, setMood, tick, normies };
  }

  it('terminal_cafe: a peak fills the free terminals and tables up to 12 NPCs, a dump sends them out', async () => {
    let now = 9_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { r, setMood, tick, normies } = await room('terminal_cafe');
    expect(r.state.npcs.size).toBe(9);
    tick(1000);
    expect(normies()).toHaveLength(0); // mood 0

    setMood(450);
    now += 1000;
    tick(1000);
    const wave = normies();
    expect(wave.length).toBeGreaterThanOrEqual(1);
    expect(wave.length).toBeLessThanOrEqual(3); // 9 + 3 = 12
    expect(r.state.npcs.size).toBeLessThanOrEqual(12);
    const free = ['terminal_4', 'terminal_6', 'terminal_7', 'terminal_8', 'table_3', 'table_4'];
    for (const [, n] of wave) {
      expect(free.map((f) => `terminal_cafe.${f}`)).toContain(n.spotId);
      expect(['act_type', 'act_sit']).toContain(n.animId);
    }
    // They stay seated, and only talk normie lines.
    for (let s = 0; s < 60; s++) {
      now += 1000;
      tick(1000);
      for (const [, n] of normies()) {
        expect(['act_type', 'act_sit']).toContain(n.animId);
        if (n.lineId !== '') expect(n.lineId).toMatch(/^normie\.\d+$/);
      }
    }

    setMood(-50);
    now += 1000;
    tick(1000);
    for (const [, n] of normies()) {
      expect(n.state).toBe('leave');
      expect(n.spotId).toBe('terminal_cafe.exit');
      expect(n.lineId).toMatch(/^normie\.\d+$/);
    }
    now += 5000;
    tick(1000);
    expect(normies()).toHaveLength(0);
    expect(r.state.npcs.size).toBe(9);
  });

  it('a player sitting on a normie seat sends the normie out', async () => {
    let now = 9_500_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { r, raw, setMood, tick, normies } = await room('timeline_square');
    setMood(800);
    tick(1000);
    const [id, n] = normies()[0]!;
    expect(n.spotId).toMatch(/^timeline_square\.bench_\d$/);
    const seat = n.spotId;
    const { PlayerState } = await import('../../contract/realtime/states.js');
    r.state.players.set('s1', Object.assign(new PlayerState(), { userId: 'u1' }));
    const sent: unknown[] = [];
    (raw.handleSit as (c: unknown, m: unknown) => void).call(
      r,
      { sessionId: 's1', send: (...a: unknown[]) => sent.push(a) },
      { spotId: seat },
    );
    expect(sent).toEqual([]);
    expect(r.state.players.get('s1')!.spotId).toBe(seat);
    expect(r.state.npcs.get(id)!.state).toBe('leave');
    now += 5000;
    tick(1000);
    expect(r.state.npcs.has(id)).toBe(false);
  });

  it('no waves at phase 1, and none in a venue without them', async () => {
    const p1 = await room('timeline_square', '1');
    p1.setMood(900);
    p1.tick(1000);
    expect(p1.normies()).toHaveLength(0);
    const lounge = await room('cabal_lounge');
    lounge.setMood(900);
    lounge.tick(1000);
    expect(lounge.normies()).toHaveLength(0);
  });
});
