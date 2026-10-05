/**
 * Colyseus schemas for the realtime layer.
 *
 * The schemas are generated server-side and sent to the client
 * (the codegen in tools/contract-check can emit C# from these).
 * M2 ships the venue, city, and market schemas, and the per-message
 * types live in contract/realtime (the FE consumes them via the
 * codegen). The schemas here are the live state.
 */
import { MapSchema, ArraySchema, Schema, type } from '@colyseus/schema';

/** A player in a venue. */
export class PlayerState extends Schema {
  @type('string') userId: string = '';
  @type('string') name: string = '';
  @type('string') skrName: string = '';
  @type('string') tribeId: string = '';
  @type('boolean') isSeeker: boolean = false;
  @type('string') minerTier: string = 'none';
  @type('string') anim: string = 'loco_idle';
  @type('string') emoteId: string = '';
  @type('number') emoteAt: number = 0;
  @type('string') spotId: string = '';
  @type('number') x: number = 0;
  @type('number') z: number = 0;
  @type('number') rotY: number = 0;
  @type('boolean') talking: boolean = false;
}

/** An NPC in a venue. */
export class NpcState extends Schema {
  @type('string') npcId: string = '';
  @type('string') archetype: string = '';
  @type('string') state: string = 'idle';
  @type('string') spotId: string = '';
  @type('string') lineId: string = '';
  @type('string') animId: string = 'loco_idle';
  @type('string') emoteId: string = '';
  @type('string') targetUserId: string = '';
  @type('number') startedAt: number = 0;
}

/** City state (one of these per game, 1 Hz). */
export class CityState extends Schema {
  @type('number') online: number = 0;
  @type('number') mood: number = 0; // basis points of SOL 24h change
  @type(['string']) eventIds: ArraySchema<string> = new ArraySchema<string>();
  @type('string') metaId: string = 'meta_v1';
}

/** Venue state. */
export class VenueState extends Schema {
  @type('string') venueId: string = '';
  @type('string') instanceId: string = '';
  @type({ map: PlayerState }) players: MapSchema<PlayerState> = new MapSchema<PlayerState>();
  @type({ map: NpcState }) npcs: MapSchema<NpcState> = new MapSchema<NpcState>();
}

/** Market state (placeholder; M3 wires the live coins). */
export class MarketState extends Schema {
  @type('number') ts: number = 0;
  @type('string') placeholder: string = 'market-m3';
}
