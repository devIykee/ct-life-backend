/**
 * Colyseus state schemas for CT Life.
 *
 * These are the @colyseus/schema classes for VenueState, MarketState,
 * CityState, HomeState, plus PlayerState, NpcState, and CoinState. The
 * C# side is generated from these via `schema-codegen`.
 *
 * The hidden arc on a coin (stealth / hype / peak / outcome) lives only
 * on the server. It is never put in a state field.
 */
import { MapSchema, Schema, type, view } from '@colyseus/schema';

export class PlayerState extends Schema {
  @type('string') userId = '';
  @type('string') name = '';
  @type('string') skrName = '';
  @type('string') tribeId = '';
  @type('boolean') isSeeker = false;
  /** none | prospector | miner | refiner */
  @type('string') minerTier = 'none';
  /** [skinTone, headId, hairId, topId, bottomId, shoesId, accId] */
  @type(['string']) look: string[] = [];
  @type('float32') x = 0;
  @type('float32') z = 0;
  @type('float32') rotY = 0;
  /** Server-set: loco_idle | loco_walk | loco_run | act_sit | act_type */
  @type('string') anim = 'loco_idle';
  @type('string') emoteId = '';
  @type('number') emoteAt = 0;
  @type('string') spotId = '';
  @type('boolean') talking = false;
  /**
   * Island pose, server-filled: the same as x/z/rotY in street rooms, the
   * converted position in venue rooms placed on CT Island (0 otherwise).
   */
  @type('float32') ix = 0;
  @type('float32') iz = 0;
  @type('float32') irotY = 0;
  /**
   * Server-set, never client-set: the outfit other players see on top of the look.
   * 'rekt_burger_crew' while the player has an open Rekt Burger shift, or has the Rekt Burger
   * Uniform equipped; undefined (null on the client) otherwise.
   */
  @type('string') outfit?: string;
}

export class NpcState extends Schema {
  @type('string') archetypeId = '';
  /** idle | wander | goto | act | talk | react | follow | leave */
  @type('string') state = 'idle';
  @type('string') spotId = '';
  @type('string') animId = '';
  @type('string') targetUserId = '';
  @type('string') lineId = '';
  @type({ map: 'string' }) lineParams = new MapSchema<string>();
  @type('string') emoteId = '';
  @type('number') startedAt = 0;
}

export class VenueState extends Schema {
  @type('string') venueId = '';
  @type('string') instanceId = '';
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  @type({ map: NpcState }) npcs = new MapSchema<NpcState>();
}

/**
 * Street room: one per district, players walking between venues.
 * Same PlayerState as venues, but x/z are island metres
 * (+X east, +Z north, origin at the downtown plaza).
 */
export class StreetState extends Schema {
  /** timeline | trenches | dubai_marina | boardwalk | airdrop_farm | builder_hills | breakpoint | residences | mountain | islet */
  @type('string') district = '';
  @type('string') instanceId = '';
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}

/** One vehicle in the island-wide vehicles room. Island metres and radians. */
export class VehicleState extends Schema {
  @type('string') id = '';
  /** compact | suv | sports | moped | roadstar | heli | drone | sedan | taxi | police | pickup | van | bike */
  @type('string') kind = '';
  /** userId of the driver, '' when parked. */
  @type('string') driver = '';
  @type('float32') x = 0;
  @type('float32') y = 0;
  @type('float32') z = 0;
  @type('float32') yaw = 0;
  @type('float32') pitch = 0;
  @type('float32') roll = 0;
  /** m/s as reported by the driver, capped per kind. */
  @type('float32') speed = 0;
  /** Client-defined bits (lights, horn, ...). 0..65535. */
  @type('uint16') flags = 0;
}

/**
 * Vehicles room: one island-wide room. Each client only receives the
 * vehicles within about 250 m of them (plus their own).
 */
export class VehiclesState extends Schema {
  @view() @type({ map: VehicleState }) vehicles = new MapSchema<VehicleState>();
}

export class CoinState extends Schema {
  @type('string') coinId = '';
  @type('string') ticker = '';
  @type('string') name = '';
  /** new | final | graduated | dead */
  @type('string') stage = 'new';
  @type('bigint64') priceMicros = 0n;
  @type('bigint64') mcapCents = 0n;
  @type('bigint64') vol5mCents = 0n;
  @type('int32') change5mBps = 0;
  @type('int32') holders = 0;
  @type('bigint64') launchedAt = 0n;
  /** True for a coin a player launched through the Rugpull Factory. */
  @type('boolean') playerLaunched = false;
  /** Factory art id (rf_*); empty for house coins. */
  @type('string') templateId = '';
  // hidden_arc lives on the server only. Never set on the schema.
}

export class MarketState extends Schema {
  @type({ map: CoinState }) coins = new MapSchema<CoinState>();
}

export class CityState extends Schema {
  @type('int32') online = 0;
  /** basis points of the SOL 24h change. -10000..+10000 */
  @type('int32') mood = 0;
  @type(['string']) eventIds: string[] = [];
  @type('string') metaId = '';
}

export class HomeState extends Schema {
  @type('string') ownerId = '';
  @type('string') homeId = '';
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}

/** M4: audio-room state. One per live Space. */
export class SpeakerState extends Schema {
  @type('string') userId = '';
  /** host | speaker | listener */
  @type('string') role = 'listener';
  @type('boolean') canPublish = false;
  @type('boolean') handRaised = false;
  @type('number') handRaisedAt = 0;
}

export class SpaceState extends Schema {
  @type('string') spaceId = '';
  @type('string') hostUserId = '';
  @type('string') title = '';
  @type('string') status = 'live';
  @type({ map: SpeakerState }) speakers = new MapSchema<SpeakerState>();
  /** userIds in hand-queue order (oldest first). */
  @type(['string']) handQueue: string[] = [];
  @type('number') listenerCount = 0;
}

/** M4: video-call state. One per live video or paid call. */
export class VideoCallState extends Schema {
  @type('string') callId = '';
  @type('string') hostUserId = '';
  /** 'video' | 'paid_call' */
  @type('string') kind = 'video';
  @type('string') status = 'live';
  @type(['string']) participantUserIds: string[] = [];
}
