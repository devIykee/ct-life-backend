/**
 * NPC brain tests.
 *
 * Each test uses a fixed seed and a SimulatedClock so the result
 * is fully deterministic. The test asserts the brain emits the
 * expected sequence of states and outputs.
 */
import { describe, it, expect } from 'vitest';
import { SimulatedClock } from './clock.js';
import { SeededRng } from './rng.js';
import { createBrain, type NpcBrain, type TickCtx, type VenueCtx, type NpcEvent } from './index.js';

const T0 = 1_700_000_000_000;

function baseVenue(over: Partial<VenueCtx> = {}): VenueCtx {
  return {
    instanceId: 'inst-1',
    moodBps: 0,
    richest: [],
    recentEvents: [],
    currentSpotId: 'square_center',
    followUserId: null,
    walkableSpots: ['square_center', 'terminal_1', 'terminal_2', 'rekt_clinic', 'perp_terminal'],
    drainedUntilMs: null,
    giveDropToastPending: false,
    ...over,
  };
}

function setup(archetype: Parameters<typeof createBrain>[0]) {
  const clock = new SimulatedClock();
  clock.set(T0);
  const rng = new SeededRng(0xc0ffee);
  const brain: NpcBrain = createBrain(archetype);
  const ctx = (): TickCtx => ({
    clock,
    rng,
    nowMs: clock.now(),
    dtMs: 1000,
    venue: baseVenue(),
  });
  return { clock, rng, brain, ctx };
}

describe('town_crier', () => {
  it('idles then talks periodically, and speaks immediately on a notify', () => {
    const { clock, brain, ctx } = setup('town_crier');
    // First tick at T0: dwell is 0, so the crier talks. That's by
    // design — they have something to say.
    const first = brain.tick(ctx());
    expect(first.state).toBe('talk');
    expect(first.lineId).toBeTruthy();
    // Skip past the talk dwell and the next idle window.
    clock.set(T0 + 200_000);
    const talkTick = brain.tick(ctx());
    expect(talkTick.state).toBe('talk');
    // Notify an event: the next tick should produce a TALK.
    const ev: NpcEvent = {
      kind: 'liquidation',
      perpId: 'p1',
      userId: 'u1',
      coin: 'FROGE',
      lossCents: 1000,
      spotId: 'perp_pit',
    };
    brain.notify(ev, ctx());
    const afterEvent = brain.tick(ctx());
    expect(afterEvent.state).toBe('talk');
  });
});

describe('giveaway_guy', () => {
  it('walks to the center and talks every 30 s', () => {
    const { clock, brain, ctx } = setup('giveaway_guy');
    const a = brain.tick(ctx());
    expect(a.state).toBe('goto');
    expect(a.targetSpotId).toBe('square_center');
    clock.advance(5_000);
    const b = brain.tick(ctx());
    expect(b.state).toBe('talk');
    expect(b.lineId).toBe('giveaway_pitch');
  });
});

describe('reply_guy', () => {
  it('follows the richest player and talks every 20 s', () => {
    const { clock, brain, ctx } = setup('reply_guy');
    const venue = baseVenue({ richest: [{ userId: 'rich-1', netWorthCents: 1_000_000 }] });
    const c1: TickCtx = { ...ctx(), venue };
    const a = brain.tick(c1);
    expect(a.state).toBe('follow');
    expect(a.followUserId).toBe('rich-1');
    clock.advance(20_000);
    const c2: TickCtx = { ...ctx(), venue };
    const b = brain.tick(c2);
    expect(b.state).toBe('talk');
    expect(b.lineId).toBe('reply_gm');
  });
});

describe('perp_degen_npc', () => {
  it('cycles through goto -> act -> react -> leave -> cry, triggered by a liquidation notify', () => {
    const { brain, ctx } = setup('perp_degen_npc');
    const a = brain.tick(ctx());
    expect(a.state).toBe('act'); // first tick goes from initial goto -> act
    expect(a.animId).toBe('act_frantic_type');
    // Notify liquidation -> react.
    const ev: NpcEvent = {
      kind: 'liquidation',
      perpId: 'p1',
      userId: 'u1',
      coin: 'FROGE',
      lossCents: 1000,
      spotId: 'perp_pit',
    };
    const react = brain.notify(ev, ctx());
    expect(react.state).toBe('react');
    expect(react.animId).toBe('react_liquidated');
  });
});

describe('rekt_guy', () => {
  it('sits in rekt_clinic and cycles cry -> stimmy', () => {
    const { clock, brain, ctx } = setup('rekt_guy');
    const a = brain.tick(ctx());
    expect(a.state).toBe('act');
    expect(a.animId).toBe('act_cry');
    clock.advance(30_000);
    const b = brain.tick(ctx());
    expect(b.state).toBe('talk');
    expect(b.lineId).toBe('rekt_stimmy');
  });
});

describe('wallet_tracker', () => {
  it('sits at the cafe and broadcasts wins every 60 s', () => {
    const { clock, brain, ctx } = setup('wallet_tracker');
    clock.advance(60_000);
    const a = brain.tick(ctx());
    expect(a.state).toBe('talk');
    expect(a.lineId).toBe('wallet_turnaround');
  });
});

describe('doomposter', () => {
  it('leaves when Mood is positive and talks when Mood is below -2%', () => {
    const { brain, ctx } = setup('doomposter');
    const positive: TickCtx = { ...ctx(), venue: baseVenue({ moodBps: 100 }) };
    expect(brain.tick(positive).state).toBe('leave');
    // Reset, then test negative mood.
    brain.reset();
    const negative: TickCtx = { ...ctx(), venue: baseVenue({ moodBps: -300 }) };
    const a = brain.tick(negative);
    expect(a.state).toBe('talk');
    expect(a.lineId).toBe('doom_bear');
  });
});

describe('spaces_host', () => {
  it('opens a space when idle and no player space is live', () => {
    const { clock, brain, ctx } = setup('spaces_host');
    clock.advance(60_000);
    const a = brain.tick(ctx());
    expect(a.state).toBe('talk');
    expect(a.lineId).toBe('spaces_gm');
  });
});

describe('ore_miner', () => {
  it('talks at the refinery and reacts to motherlode', () => {
    const { clock, brain, ctx } = setup('ore_miner');
    clock.advance(60_000);
    const a = brain.tick(ctx());
    expect(a.state).toBe('talk');
    expect(a.lineId).toBe('ore_board');
    // Notify a motherlode.
    const ev: NpcEvent = { kind: 'motherlode', amount: 55, spotId: 'ore_refinery' };
    const b = brain.notify(ev, ctx());
    expect(b.state).toBe('talk');
    expect(b.lineId).toBe('ore_motherlode');
  });
});

describe('reproducibility', () => {
  it('two brains with the same seed produce the same first 10 ticks', () => {
    const a = setup('town_crier');
    const b = setup('town_crier');
    for (let i = 0; i < 10; i++) {
      a.clock.advance(20_000);
      b.clock.advance(20_000);
      const ra = a.brain.tick(a.ctx());
      const rb = b.brain.tick(b.ctx());
      expect(ra.state).toBe(rb.state);
      expect(ra.lineId).toBe(rb.lineId);
      expect(ra.animId).toBe(rb.animId);
    }
  });
});
