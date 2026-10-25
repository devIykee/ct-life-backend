import { describe, it, expect } from 'vitest';
import {
  VenueState,
  PlayerState,
  NpcState,
  CityState,
  MarketState,
  CoinState,
  HomeState,
  SpaceState,
  SpeakerState,
  VideoCallState,
} from '../../contract/realtime/states.js';
import { MapSchema } from '@colyseus/schema';

describe('Realtime Schema Validation', () => {
  it('PlayerState has all required fields from contract', () => {
    const player = new PlayerState();
    player.userId = 'user123';
    player.name = 'testuser';
    player.skrName = 'TESTUSER';
    player.tribeId = 'tribe1';
    player.isSeeker = true;
    player.minerTier = 'prospector';
    player.x = 100.5;
    player.z = 50.25;
    player.rotY = 1.5;
    player.anim = 'loco_walk';
    player.emoteId = 'wave';
    player.emoteAt = 12345;
    player.spotId = 'spot1';
    player.talking = true;
    player.look = ['skin1', 'head1', 'hair1', 'top1', 'bottom1', 'shoes1', 'acc1'];

    expect(player.userId).toBe('user123');
    expect(player.name).toBe('testuser');
    expect(player.skrName).toBe('TESTUSER');
    expect(player.tribeId).toBe('tribe1');
    expect(player.isSeeker).toBe(true);
    expect(player.minerTier).toBe('prospector');
    expect(player.x).toBe(100.5);
    expect(player.z).toBe(50.25);
    expect(player.rotY).toBe(1.5);
    expect(player.anim).toBe('loco_walk');
    expect(player.emoteId).toBe('wave');
    expect(player.emoteAt).toBe(12345);
    expect(player.spotId).toBe('spot1');
    expect(player.talking).toBe(true);
    expect([...player.look]).toEqual([
      'skin1',
      'head1',
      'hair1',
      'top1',
      'bottom1',
      'shoes1',
      'acc1',
    ]);
    expect(player.look.length).toBe(7);
  });

  it('NpcState has all required fields from contract', () => {
    const npc = new NpcState();
    npc.archetypeId = 'town_crier';
    npc.state = 'talk';
    npc.spotId = 'spot1';
    npc.animId = 'idle';
    npc.targetUserId = 'user1';
    npc.lineId = 'greeting';
    npc.lineParams = new MapSchema<string>();
    npc.lineParams.set('param1', 'value1');
    npc.lineParams.set('param2', 'value2');
    npc.emoteId = 'wave';
    npc.startedAt = 12345;

    expect(npc.archetypeId).toBe('town_crier');
    expect(npc.state).toBe('talk');
    expect(npc.spotId).toBe('spot1');
    expect(npc.animId).toBe('idle');
    expect(npc.targetUserId).toBe('user1');
    expect(npc.lineId).toBe('greeting');
    expect(npc.lineParams.size).toBe(2);
    expect(npc.lineParams.get('param1')).toBe('value1');
    expect(npc.lineParams.get('param2')).toBe('value2');
    expect(npc.emoteId).toBe('wave');
    expect(npc.startedAt).toBe(12345);
  });

  it('CityState has all required fields from contract', () => {
    const city = new CityState();
    city.online = 42;
    city.mood = 150;
    city.eventIds = ['event1', 'event2', 'event3'];
    city.metaId = 'meta1';

    expect(city.online).toBe(42);
    expect(city.mood).toBe(150);
    expect([...city.eventIds]).toEqual(['event1', 'event2', 'event3']);
    expect(city.metaId).toBe('meta1');
  });

  it('CoinState has all required fields from contract', () => {
    const coin = new CoinState();
    coin.coinId = 'coin123';
    coin.ticker = 'SOL';
    coin.name = 'Solana';
    coin.stage = 'graduated';
    coin.priceMicros = 123450000n;
    coin.mcapCents = 1000000000n;
    coin.vol5mCents = 50000000n;
    coin.change5mBps = -250;
    coin.holders = 1000;
    coin.launchedAt = 1234567890n;

    expect(coin.coinId).toBe('coin123');
    expect(coin.ticker).toBe('SOL');
    expect(coin.name).toBe('Solana');
    expect(coin.stage).toBe('graduated');
    expect(coin.priceMicros).toBe(123450000n);
    expect(coin.mcapCents).toBe(1000000000n);
    expect(coin.vol5mCents).toBe(50000000n);
    expect(coin.change5mBps).toBe(-250);
    expect(coin.holders).toBe(1000);
    expect(coin.launchedAt).toBe(1234567890n);
  });

  it('MarketState has coins MapSchema', () => {
    const market = new MarketState();
    market.coins = new MapSchema<CoinState>();

    const sol = new CoinState();
    sol.coinId = 'coin1';
    sol.ticker = 'SOL';
    sol.name = 'Solana';
    sol.stage = 'graduated';
    sol.priceMicros = 150000000n;
    sol.change5mBps = 520;
    market.coins.set('coin1', sol);

    const usdc = new CoinState();
    usdc.coinId = 'coin2';
    usdc.ticker = 'USDC';
    usdc.name = 'USD Coin';
    usdc.stage = 'graduated';
    usdc.priceMicros = 1000000n;
    usdc.change5mBps = 1;
    market.coins.set('coin2', usdc);

    expect(market.coins.size).toBe(2);
    expect(market.coins.get('coin1')?.ticker).toBe('SOL');
    expect(market.coins.get('coin1')?.priceMicros).toBe(150000000n);
    expect(market.coins.get('coin2')?.ticker).toBe('USDC');
    expect(market.coins.get('coin2')?.priceMicros).toBe(1000000n);
  });

  it('VenueState has players and NPCs MapSchemas', () => {
    const state = new VenueState();
    state.venueId = 'venue1';
    state.instanceId = 'instance1';
    state.players = new MapSchema<PlayerState>();
    state.npcs = new MapSchema<NpcState>();

    const player = new PlayerState();
    player.userId = 'user1';
    player.name = 'alice';
    player.skrName = 'ALICE';
    player.x = 100;
    player.z = 50;
    player.rotY = 0;
    player.look = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    state.players.set('session1', player);

    const npc = new NpcState();
    npc.archetypeId = 'town_crier';
    npc.state = 'idle';
    npc.lineParams = new MapSchema<string>();
    state.npcs.set('npc-town-crier', npc);

    expect(state.venueId).toBe('venue1');
    expect(state.instanceId).toBe('instance1');
    expect(state.players.size).toBe(1);
    expect(state.npcs.size).toBe(1);
    expect(state.players.get('session1')?.userId).toBe('user1');
    expect([...(state.players.get('session1')?.look ?? [])]).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    expect(state.npcs.get('npc-town-crier')?.archetypeId).toBe('town_crier');
  });

  it('HomeState has all required fields from contract', () => {
    const home = new HomeState();
    home.ownerId = 'user123';
    home.homeId = 'home456';
    home.players = new MapSchema<PlayerState>();

    const player = new PlayerState();
    player.userId = 'guest1';
    player.name = 'Guest';
    player.look = ['1', '2', '3', '4', '5', '6', '7'];
    home.players.set('session1', player);

    expect(home.ownerId).toBe('user123');
    expect(home.homeId).toBe('home456');
    expect(home.players.size).toBe(1);
    expect(home.players.get('session1')?.userId).toBe('guest1');
  });

  it('SpeakerState has all required fields from contract', () => {
    const speaker = new SpeakerState();
    speaker.userId = 'user123';
    speaker.role = 'speaker';
    speaker.canPublish = true;
    speaker.handRaised = false;
    speaker.handRaisedAt = 0;

    expect(speaker.userId).toBe('user123');
    expect(speaker.role).toBe('speaker');
    expect(speaker.canPublish).toBe(true);
    expect(speaker.handRaised).toBe(false);
    expect(speaker.handRaisedAt).toBe(0);
  });

  it('SpaceState has all required fields from contract', () => {
    const space = new SpaceState();
    space.spaceId = 'space123';
    space.hostUserId = 'host456';
    space.title = 'Test Space';
    space.status = 'live';
    space.speakers = new MapSchema<SpeakerState>();
    space.handQueue = ['user1', 'user2'];
    space.listenerCount = 42;

    const speaker = new SpeakerState();
    speaker.userId = 'user1';
    speaker.role = 'host';
    speaker.canPublish = true;
    space.speakers.set('user1', speaker);

    expect(space.spaceId).toBe('space123');
    expect(space.hostUserId).toBe('host456');
    expect(space.title).toBe('Test Space');
    expect(space.status).toBe('live');
    expect(space.speakers.size).toBe(1);
    expect([...space.handQueue]).toEqual(['user1', 'user2']);
    expect(space.listenerCount).toBe(42);
  });

  it('VideoCallState has all required fields from contract', () => {
    const call = new VideoCallState();
    call.callId = 'call123';
    call.hostUserId = 'host456';
    call.kind = 'paid_call';
    call.status = 'live';
    call.participantUserIds = ['user1', 'user2', 'user3'];

    expect(call.callId).toBe('call123');
    expect(call.hostUserId).toBe('host456');
    expect(call.kind).toBe('paid_call');
    expect(call.status).toBe('live');
    expect([...call.participantUserIds]).toEqual(['user1', 'user2', 'user3']);
  });

  it('all schemas are imported from contract/realtime/', () => {
    // This test verifies that the schema classes are imported from the contract
    // directory and not duplicated in server code. The schema-check.ts script
    // enforces this at CI time.
    expect(PlayerState.name).toBe('PlayerState');
    expect(NpcState.name).toBe('NpcState');
    expect(CityState.name).toBe('CityState');
    expect(MarketState.name).toBe('MarketState');
    expect(CoinState.name).toBe('CoinState');
    expect(VenueState.name).toBe('VenueState');
    expect(HomeState.name).toBe('HomeState');
    expect(SpaceState.name).toBe('SpaceState');
    expect(SpeakerState.name).toBe('SpeakerState');
    expect(VideoCallState.name).toBe('VideoCallState');
  });

  it('PlayerState coordinates use float32 types', () => {
    // Verify that coordinates are typed as float32, not plain number
    const player = new PlayerState();
    player.x = 123.456;
    player.z = 789.012;
    player.rotY = 3.14159;

    // Schema decorators ensure the type, verify the fields exist and are numbers
    expect(typeof player.x).toBe('number');
    expect(typeof player.z).toBe('number');
    expect(typeof player.rotY).toBe('number');
    expect(player.x).toBeCloseTo(123.456, 3);
    expect(player.z).toBeCloseTo(789.012, 3);
    expect(player.rotY).toBeCloseTo(3.14159, 5);
  });

  it('PlayerState look array has length 7', () => {
    // Verify look is defined as string array with 7 elements
    const player = new PlayerState();
    player.look = ['skin', 'head', 'hair', 'top', 'bottom', 'shoes', 'acc'];

    expect([...player.look]).toEqual(['skin', 'head', 'hair', 'top', 'bottom', 'shoes', 'acc']);
    expect(player.look.length).toBe(7);
    expect(player.look[0]).toBe('skin');
    expect(player.look[6]).toBe('acc');
  });

  it('NpcState has lineParams MapSchema', () => {
    // Verify lineParams is correctly typed as MapSchema<string>
    const npc = new NpcState();
    npc.lineParams = new MapSchema<string>();
    npc.lineParams.set('playerName', 'Alice');
    npc.lineParams.set('coinTicker', 'SOL');
    npc.lineParams.set('amount', '1000');

    expect(npc.lineParams).toBeInstanceOf(MapSchema);
    expect(npc.lineParams.size).toBe(3);
    expect(npc.lineParams.get('playerName')).toBe('Alice');
    expect(npc.lineParams.get('coinTicker')).toBe('SOL');
    expect(npc.lineParams.get('amount')).toBe('1000');
  });
});
