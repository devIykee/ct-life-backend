/**
 * NPC roster: who spawns where, the phase gate, the per-instance cap, and
 * the contract the client relies on (venue ids it knows, spot ids of the
 * venue, a line set for every NPC that talks).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_NPCS_PER_INSTANCE,
  npcArchetypesFor,
  npcSpawnPlan,
  rosterVenueIds,
} from './npc-roster.js';
import {
  canonicalArchetype,
  DRESSING_ARCHETYPES,
  PHASE1_ARCHETYPES,
  PHASE2_ARCHETYPES,
  type NpcArchetype,
} from '../../packages/npc-brain/src/index.js';
import { _resetConfigForTests } from '../shared/config/config.js';

const root = process.cwd();
const json = <T>(...p: string[]): T => JSON.parse(readFileSync(join(root, ...p), 'utf8')) as T;
const venues = json<{ venues: Array<{ id: string }> }>('contract', 'ids', 'venues.json').venues.map(
  (v) => v.id,
);
const spots = json<{ venues: Record<string, { spots: Array<{ id: string; kind: string }> }> }>(
  'contract',
  'ids',
  'spots.json',
).venues;
const registry = json<{
  archetypes: Array<{
    id: string;
    venueId: string;
    phase: number;
    lines: string;
    maxPerInstance?: number;
  }>;
}>('contract', 'ids', 'archetypes.json').archetypes;
const lines = json<Record<string, unknown>>('contract', 'config', 'npc_lines.json');

/** Everything a venue spawns at a phase, plan or table. */
function roster(venueId: string, phase: number): string[] {
  const plan = npcSpawnPlan(venueId, phase);
  return plan.length > 0 ? plan.map((s) => s.archetype) : npcArchetypesFor(venueId, phase);
}

const PHASE2_BY_VENUE: Record<string, string[]> = {
  cabal_lounge: ['alpha_caller', 'cabal_insider'],
  launchpad_tower: ['rug_dev', 'sniper_bot'],
  audit_row: ['sleuth', 'auditor'],
  vc_row: ['vc'],
  airdrop_fields: ['farmer', 'sybil_farmer'],
  discord_heights: ['drainer', 'community_mod'],
  prediction_pit: ['prediction_shark_npc'],
  ratio_arena: ['chain_tribalist', 'chain_tribalist'],
  hackathon_house: ['doxxed_founder'],
  yacht_club: ['fake_rich_larp', 'dubai_relocator'],
  timeline_square: ['thread_boy', 'engagement_farmer', 'laser_eyes_maxi'],
  terminal_cafe: ['ai_agent'],
};
const PHASE2_IDS = new Set<string>(PHASE2_ARCHETYPES);

describe('npc roster: phase gate', () => {
  it.each(Object.entries(PHASE2_BY_VENUE))(
    '%s spawns its phase-2 NPCs at livePhase 2 and 6',
    (venueId, expected) => {
      for (const phase of [2, 6]) {
        const got = roster(venueId, phase).filter((a) => PHASE2_IDS.has(a));
        expect(got).toEqual(expected);
      }
    },
  );

  it('no venue spawns a phase-2 NPC at livePhase 1, and phase 1 is unchanged', () => {
    for (const venueId of venues) {
      expect(
        roster(venueId, 1).filter((a) => PHASE2_IDS.has(a)),
        venueId,
      ).toEqual([]);
    }
    expect(npcArchetypesFor('timeline_square', 1)).toEqual([
      'town_crier',
      'giveaway_guy',
      'reply_guy',
      'doomposter',
      'spaces_host',
    ]);
    expect(npcSpawnPlan('terminal_cafe', 1)).toHaveLength(8);
    expect(npcArchetypesFor('perp_pit', 1)).toEqual(['perp_degen_npc']);
  });

  it('phase-2 NPCs come after the phase-1 NPCs, so phase-1 npcIds do not move', () => {
    for (const venueId of venues) {
      const p1 = roster(venueId, 1);
      expect(roster(venueId, 6).slice(0, p1.length), venueId).toEqual(p1);
    }
  });

  it('every phase-2 archetype spawns somewhere except normie (waves, not static)', () => {
    const spawned = new Set(venues.flatMap((v) => roster(v, 6)));
    const missing = PHASE2_ARCHETYPES.filter((a) => !spawned.has(a));
    expect(missing).toEqual(['normie']);
  });
});

describe('npc roster: density and CPU', () => {
  it(`no venue has more than ${MAX_NPCS_PER_INSTANCE} NPCs at any phase`, () => {
    for (const venueId of venues) {
      for (const phase of [1, 2, 6]) {
        expect(roster(venueId, phase).length, `${venueId}@${phase}`).toBeLessThanOrEqual(
          MAX_NPCS_PER_INSTANCE,
        );
      }
    }
  });

  it('no archetype exceeds its registry maxPerInstance (default 1, dressing exempt)', () => {
    const dressing = new Set<string>(DRESSING_ARCHETYPES);
    for (const venueId of venues) {
      const counts = new Map<string, number>();
      for (const a of roster(venueId, 6)) counts.set(a, (counts.get(a) ?? 0) + 1);
      for (const [a, n] of counts) {
        if (dressing.has(a)) continue;
        const max = registry.find((r) => r.id === a)?.maxPerInstance ?? 1;
        expect(n, `${venueId}:${a}`).toBeLessThanOrEqual(max);
      }
    }
  });
});

describe('npc roster: contract', () => {
  it('every venue id in the roster is a venue of venues.json and spots.json', () => {
    for (const venueId of rosterVenueIds()) {
      expect(venues, venueId).toContain(venueId);
      expect(spots[venueId], venueId).toBeDefined();
    }
  });

  it('every seat of a plan is a spot of its venue', () => {
    for (const venueId of venues) {
      const ids = new Set((spots[venueId]?.spots ?? []).map((s) => s.id));
      for (const seat of npcSpawnPlan(venueId, 6)) expect(ids, seat.spotId).toContain(seat.spotId);
    }
  });

  it('every venue with table NPCs has a stand/npc spot to put them on', () => {
    const kinds = new Set(['npc', 'standing', 'stand']);
    for (const venueId of venues) {
      if (npcArchetypesFor(venueId, 6).length === 0) continue;
      const homes = (spots[venueId]?.spots ?? []).filter((s) => kinds.has(s.kind));
      expect(homes.length, venueId).toBeGreaterThan(0);
    }
  });

  it('every venue has a stand/npc spot of its own for each table NPC (no shared homes)', () => {
    const kinds = new Set(['npc', 'standing', 'stand']);
    for (const venueId of venues) {
      const n = npcArchetypesFor(venueId, 6).length;
      if (n === 0) continue;
      const homes = (spots[venueId]?.spots ?? []).filter((s) => kinds.has(s.kind));
      expect(homes.length, venueId).toBeGreaterThanOrEqual(n);
    }
  });

  it('each phase-2 archetype spawns in the venue archetypes.json names', () => {
    for (const r of registry) {
      if (!PHASE2_IDS.has(r.id) || r.id === 'normie') continue;
      expect(roster(r.venueId, 6), `${r.id} -> ${r.venueId}`).toContain(r.id);
    }
  });

  it('archetypes.json lists exactly the brain archetypes, each pointing at a real venue', () => {
    const brains = [...PHASE1_ARCHETYPES, ...PHASE2_ARCHETYPES, ...DRESSING_ARCHETYPES].sort();
    expect(registry.map((r) => r.id).sort()).toEqual(brains);
    for (const r of registry) {
      if (r.venueId === '') continue; // patron dresses any venue
      expect(venues, `${r.id} -> ${r.venueId}`).toContain(r.venueId);
    }
  });

  it('every archetype that talks has a set of 30+ short lines', () => {
    for (const r of registry) {
      if (r.lines === '') continue; // barista, patron: dressing, no lines
      expect(r.lines).toBe(`npc_lines.${r.id}`);
      const set = lines[r.id];
      expect(Array.isArray(set), r.id).toBe(true);
      const arr = set as unknown[];
      expect(arr.length, r.id).toBeGreaterThanOrEqual(30);
      for (const l of arr) {
        expect(typeof l, r.id).toBe('string');
        expect((l as string).length, `${r.id}: ${String(l)}`).toBeLessThanOrEqual(80);
      }
      // Phase-2 NPCs speak `<id>.<n>` of slot-free lines only (no lineParams yet).
      if (PHASE2_IDS.has(r.id)) {
        expect(arr.filter((l) => !(l as string).includes('{')).length, r.id).toBeGreaterThan(20);
      }
    }
  });

  it('every archetype the roster spawns has a line set or is dressing', () => {
    const dressing = new Set<string>(DRESSING_ARCHETYPES);
    for (const venueId of venues) {
      for (const a of roster(venueId, 6)) {
        if (dressing.has(a)) continue;
        expect(Array.isArray(lines[canonicalArchetype(a as NpcArchetype)]), `${venueId}:${a}`).toBe(
          true,
        );
      }
    }
  });
});

describe('venue room spawns by LIVE_PHASE', () => {
  const saved = process.env.LIVE_PHASE;
  afterEach(() => {
    if (saved === undefined) delete process.env.LIVE_PHASE;
    else process.env.LIVE_PHASE = saved;
    _resetConfigForTests();
    vi.restoreAllMocks();
  });

  async function room(venueId: string, phase: string) {
    process.env.LIVE_PHASE = phase;
    _resetConfigForTests();
    const { VenueRoom } = await import('./rooms/venue.js');
    const r = new VenueRoom();
    (r as unknown as Record<string, unknown>).setSimulationInterval = () => undefined;
    await r.onCreate({ venueId });
    return r;
  }

  it('cabal_lounge: two NPCs on spots of the venue at phase 6, none at phase 1', async () => {
    const on = await room('cabal_lounge', '6');
    const npcs = [...on.state.npcs.entries()];
    expect(npcs.map(([, n]) => n.archetypeId)).toEqual(['alpha_caller', 'cabal_insider']);
    const ids = new Set(spots.cabal_lounge!.spots.map((s) => s.id));
    for (const [, n] of npcs) expect(ids).toContain(n.spotId);
    expect(new Set(npcs.map(([, n]) => n.spotId)).size).toBe(2);

    const off = await room('cabal_lounge', '1');
    expect(off.state.npcs.size).toBe(0);
  });

  it('yacht_club: the Fake-Rich LARP and the Dubai Relocator on distinct spots of the venue', async () => {
    const on = await room('yacht_club', '6');
    const npcs = [...on.state.npcs.values()];
    expect(npcs.map((n) => n.archetypeId)).toEqual(['fake_rich_larp', 'dubai_relocator']);
    const ids = new Set(spots.yacht_club!.spots.map((s) => s.id));
    for (const n of npcs) expect(ids).toContain(n.spotId);
    expect(new Set(npcs.map((n) => n.spotId)).size).toBe(2);

    const marina = await room('dubai_marina', '6');
    expect(marina.state.npcs.size).toBe(0);
  });

  it('timeline_square: each of the 8 NPCs has a home spot of its own', async () => {
    const r = await room('timeline_square', '6');
    const homes = [...r.state.npcs.values()].map((n) => n.spotId);
    expect(homes).toHaveLength(8);
    expect(new Set(homes).size).toBe(8);
  });

  it('ratio_arena: two chain tribalists with distinct npcIds', async () => {
    const r = await room('ratio_arena', '6');
    expect([...r.state.npcs.keys()]).toEqual(['npc-0-chain_tribalist', 'npc-1-chain_tribalist']);
  });

  it('terminal_cafe: the AI Agent joins the plan at the cafe centre', async () => {
    const r = await room('terminal_cafe', '6');
    const ai = [...r.state.npcs.values()].find((n) => n.archetypeId === 'ai_agent');
    expect(ai?.spotId).toBe('terminal_cafe.center');
    expect(r.state.npcs.size).toBe(9);
  });

  it('ticks speak `<archetype>.<n>` lines of slot-free lines and stay on venue spots', async () => {
    let now = 5_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const r = await room('timeline_square', '6');
    expect(r.state.npcs.size).toBe(8);
    const tick = (r as unknown as { tickNpcs: (dt: number) => void }).tickNpcs.bind(r);
    const ids = new Set(spots.timeline_square!.spots.map((s) => s.id));
    const spoken = new Set<string>();
    for (let s = 0; s < 120; s++) {
      now += 1000;
      tick(1000);
      for (const n of r.state.npcs.values()) {
        expect(ids, n.spotId).toContain(n.spotId);
        if (n.lineId !== '' && PHASE2_IDS.has(n.archetypeId)) spoken.add(n.lineId);
      }
    }
    expect(spoken.size).toBeGreaterThan(0);
    for (const lineId of spoken) {
      const m = /^([a-z_]+)\.(\d+)$/.exec(lineId);
      expect(m, lineId).not.toBeNull();
      const line = (lines[m![1]!] as string[])[Number(m![2])];
      expect(line, lineId).toBeDefined();
      expect(line!.includes('{'), lineId).toBe(false);
    }
  });
});
