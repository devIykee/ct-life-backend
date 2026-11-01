/**
 * Who spawns in which venue room.
 *
 * Two tables, both keyed by venue id (contract/ids/venues.json):
 *
 * - `npcSpawnPlan`: venues with a seating plan (B17). Each NPC gets a fixed
 *   spot and the anim it holds there.
 * - `npcArchetypesFor`: every other venue. The room gives each NPC a home
 *   spot round-robin over the venue's stand/npc spots.
 *
 * Phase gate: the phase-2 NPCs of the spec table only spawn while the
 * deployment's `LIVE_PHASE` is 2 or more (the same switch `GET /config`
 * sends as `livePhase`). At phase 1 the rooms spawn exactly what they did
 * before.
 *
 * `normie` is not here on purpose: the spec spawns Normies in waves at
 * market peaks, which needs its own code.
 *
 * Pure: no I/O, so the tables are testable without a room.
 */
import type { NpcArchetype } from '../../packages/npc-brain/src/index.js';

/** Build spec, NPC density: at most 12 NPCs per venue instance. */
export const MAX_NPCS_PER_INSTANCE = 12;

/** The release phase that opens the phase-2 NPCs. */
export const NPC_PHASE2 = 2;

/** One seat of a venue's seating plan. */
export interface NpcSeat {
  readonly archetype: NpcArchetype;
  /** Global spot id from spots.json (`venueId.spotId`). */
  readonly spotId: string;
  /** Anim from anims.json the NPC holds on that spot. */
  readonly animId: string;
}

/**
 * B17 venue patrons: who stands where, per the FE seating table.
 *
 * Spot ids are the global ids from spots.json and the anims come from
 * anims.json, so the client can walk a seated NPC to the seat's approach
 * point. Venues without a plan use `npcArchetypesFor`.
 * @param venueId - The venue being created.
 * @param livePhase - The deployment's release phase (LIVE_PHASE).
 * @returns The spawn plan, or [] when the venue has none.
 */
export function npcSpawnPlan(venueId: string, livePhase: number): NpcSeat[] {
  switch (venueId) {
    case 'terminal_cafe': {
      const plan: NpcSeat[] = [
        { archetype: 'barista', spotId: 'terminal_cafe.counter', animId: 'loco_idle' },
        { archetype: 'patron', spotId: 'terminal_cafe.terminal_1', animId: 'act_type' },
        { archetype: 'patron', spotId: 'terminal_cafe.terminal_2', animId: 'act_type' },
        { archetype: 'patron', spotId: 'terminal_cafe.terminal_3', animId: 'act_type' },
        // The twin-monitor desks are the traders' side of the room.
        { archetype: 'patron', spotId: 'terminal_cafe.terminal_5', animId: 'act_type' },
        { archetype: 'patron', spotId: 'terminal_cafe.table_1', animId: 'act_sit' },
        { archetype: 'patron', spotId: 'terminal_cafe.table_2', animId: 'act_sit' },
        // The wallet tracker keeps its own brain and its own terminal.
        { archetype: 'wallet_tracker', spotId: 'terminal_cafe.pulse_screen', animId: 'loco_idle' },
      ];
      if (livePhase >= NPC_PHASE2) {
        plan.push({ archetype: 'ai_agent', spotId: 'terminal_cafe.center', animId: 'loco_idle' });
      }
      return plan;
    }
    case 'spaces_studio':
      return [
        { archetype: 'spaces_host', spotId: 'spaces_studio.stage_host', animId: 'loco_idle' },
        { archetype: 'patron', spotId: 'spaces_studio.stage_4', animId: 'act_sit' },
        { archetype: 'patron', spotId: 'spaces_studio.stage_5', animId: 'act_sit' },
        { archetype: 'patron', spotId: 'spaces_studio.seat_1', animId: 'act_sit' },
        { archetype: 'patron', spotId: 'spaces_studio.seat_2', animId: 'act_sit' },
        { archetype: 'patron', spotId: 'spaces_studio.seat_3', animId: 'act_sit' },
        { archetype: 'patron', spotId: 'spaces_studio.seat_4', animId: 'act_sit' },
      ];
    default:
      return [];
  }
}

/** Phase-1 NPCs per venue (unchanged since M2). */
const PHASE1_ROSTER: Readonly<Record<string, readonly NpcArchetype[]>> = {
  timeline_square: ['town_crier', 'giveaway_guy', 'reply_guy', 'doomposter', 'spaces_host'],
  perp_pit: ['perp_degen_npc'],
  rekt_clinic: ['rekt_guy'],
  terminal_cafe: ['wallet_tracker'],
  ore_refinery: ['ore_miner'],
};

/**
 * Phase-2 NPCs per venue (spec NPC table; FE ask 2026-11-01). Appended
 * after the phase-1 NPCs, so the phase-1 NPCs keep their npcIds and home
 * spots. `fake_rich_larp` and `dubai_relocator` live in `dubai_marina`:
 * the island's `yacht_club` has no venue room yet (it is not in
 * venues.json / spots.json).
 */
const PHASE2_ROSTER: Readonly<Record<string, readonly NpcArchetype[]>> = {
  cabal_lounge: ['alpha_caller', 'cabal_insider'],
  launchpad_tower: ['rug_dev', 'sniper_bot'],
  audit_row: ['sleuth', 'auditor'],
  vc_row: ['vc'],
  airdrop_fields: ['farmer', 'sybil_farmer'],
  discord_heights: ['drainer', 'community_mod'],
  prediction_pit: ['prediction_shark_npc'],
  // The pair argues; two npcIds give the client two voices.
  ratio_arena: ['chain_tribalist', 'chain_tribalist'],
  hackathon_house: ['doxxed_founder'],
  dubai_marina: ['fake_rich_larp', 'dubai_relocator'],
  timeline_square: ['thread_boy', 'engagement_farmer', 'laser_eyes_maxi'],
};

/**
 * NPCs for a venue without a seating plan, in npcId order.
 * @param venueId - The venue being created.
 * @param livePhase - The deployment's release phase (LIVE_PHASE).
 * @returns Archetypes to spawn, or [] for a venue with no NPCs.
 */
export function npcArchetypesFor(venueId: string, livePhase: number): NpcArchetype[] {
  const out = [...(PHASE1_ROSTER[venueId] ?? [])];
  if (livePhase >= NPC_PHASE2) out.push(...(PHASE2_ROSTER[venueId] ?? []));
  return out;
}

/**
 * Every venue id named in the tables, for the contract tests.
 * @returns Venue ids of both tables.
 */
export function rosterVenueIds(): string[] {
  return [
    ...new Set([
      ...Object.keys(PHASE1_ROSTER),
      ...Object.keys(PHASE2_ROSTER),
      'terminal_cafe',
      'spaces_studio',
    ]),
  ];
}
