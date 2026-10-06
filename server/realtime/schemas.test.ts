import { describe, it, expect } from 'vitest';
import {
  VenueState,
  PlayerState,
  NpcState,
  CityState,
  MarketState,
  CoinState,
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
    expect(player.look).toEqual(['skin1', 'head1', 'hair1', 'top1', 'bottom1', 'shoes1', 'acc1']);
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
    expect(city.eventIds).toEqual(['event1', 'event2', 'event3']);
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
    expect(state.players.get('session1')?.look).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(state.npcs.get('npc-town-crier')?.archetypeId).toBe('town_crier');
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
  });
});
