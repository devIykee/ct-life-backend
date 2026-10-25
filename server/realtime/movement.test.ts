import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DISTRICTS,
  decodePos,
  distanceToLand,
  getIslandGeometry,
  islandToVenue,
  venueToIsland,
  onLand,
  setIslandGeometry,
  distanceToPolygon,
  encodePos,
  newAnchor,
  pointInPolygon,
  stepMove,
  TokenBucket,
} from './movement.js';

describe('stepMove (distance budget)', () => {
  it('accepts an honest 6 m/s sprint with jittery arrivals', () => {
    const a = newAnchor(0, 0, 0);
    // Client sends every 100 ms at 6 m/s; arrivals jitter 40..160 ms.
    const arrivals = [140, 180, 340, 380, 520, 640, 700, 860, 900, 1000];
    let clamped = 0;
    arrivals.forEach((t, i) => {
      const r = stepMove(a, 0.6 * (i + 1), 0, t);
      if (r.clamped) clamped++;
    });
    expect(clamped).toBe(0);
    expect(a.x).toBeCloseTo(6);
  });

  it('survives one dropped message', () => {
    const a = newAnchor(0, 0, 0);
    stepMove(a, 0.6, 0, 100);
    const r = stepMove(a, 1.8, 0, 300); // 200 ms gap, 1.2 m
    expect(r.clamped).toBe(false);
  });

  it('clamps a teleport toward the target instead of rejecting', () => {
    const a = newAnchor(0, 0, 0);
    const r = stepMove(a, 100, 0, 100);
    expect(r.clamped).toBe(true);
    expect(r.x).toBeGreaterThan(0);
    expect(r.x).toBeLessThan(2);
    expect(a.x).toBe(r.x);
  });

  it('never allows more than the cap over a long run', () => {
    const a = newAnchor(0, 0, 0);
    // Cheater asks for 1 m every 100 ms (10 m/s) for 10 s.
    for (let i = 1; i <= 100; i++) stepMove(a, i, 0, i * 100);
    expect(a.x).toBeLessThanOrEqual(6.5 * 10 + 0.5 + 1e-9);
  });

  it('standing still banks at most one second of movement', () => {
    const a = newAnchor(0, 0, 0);
    const r = stepMove(a, 50, 0, 60_000);
    expect(r.clamped).toBe(true);
    expect(r.x).toBeCloseTo(7);
  });
});

describe('TokenBucket', () => {
  it('passes a burst then limits', () => {
    const b = new TokenBucket(10, 5);
    const ok = Array.from({ length: 8 }, () => b.take(1000)).filter(Boolean).length;
    expect(ok).toBe(5);
    expect(b.take(1100)).toBe(true); // refilled one
  });
});

describe('polygons', () => {
  const sq: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  it('point in polygon', () => {
    expect(pointInPolygon(sq, 5, 5)).toBe(true);
    expect(pointInPolygon(sq, 15, 5)).toBe(false);
  });
  it('distance to polygon', () => {
    expect(distanceToPolygon(sq, 5, 5)).toBe(0);
    expect(distanceToPolygon(sq, 13, 5)).toBeCloseTo(3);
    expect(distanceToPolygon(sq, 13, 14)).toBeCloseTo(5);
  });
  it('position encoding round-trips', () => {
    expect(decodePos(encodePos({ x: 1.234, z: -5, at: 42 }))).toEqual({ x: 1.23, z: -5, at: 42 });
    expect(decodePos('nope')).toBeNull();
  });
});

describe('contract/ids/districts.json', () => {
  setIslandGeometry(null);
  const geo = getIslandGeometry();

  it('has a polygon for every district', () => {
    for (const id of DISTRICTS) expect(geo.districts[id]?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('puts the plaza, the islet and the causeway on land, and the open sea off it', () => {
    expect(onLand(geo.island, 0, 0)).toBe(true);
    expect(onLand(geo.island, 800, -646)).toBe(true);
    expect(onLand(geo.island, 802, -532)).toBe(true);
    expect(onLand(geo.island, 2000, 0)).toBe(false);
    expect(distanceToLand(geo.island, 2000, 0)).toBeGreaterThan(1000);
  });

  it("includes The Rug Room's pier pad and still rejects the sea beyond it", () => {
    // The pad (x 116.5..135.5, z -273.5..-250.5) is built out over the water.
    for (const [x, z] of [
      [126, -262],
      [118, -272],
      [134, -252],
    ] as const) {
      expect(onLand(geo.island, x, z), `${x},${z}`).toBe(true);
    }
    for (const [x, z] of [
      [126, -275],
      [126, -290],
      [110, -270],
    ] as const) {
      expect(onLand(geo.island, x, z), `${x},${z}`).toBe(false);
    }
  });
});

describe('venue placement', () => {
  setIslandGeometry(null);
  const v = getIslandGeometry().venues!['terminal_cafe']!;

  it('round-trips venue and island coordinates', () => {
    const [ix, iz] = venueToIsland(v, 3, -4);
    const [lx, lz] = islandToVenue(v, ix, iz);
    expect(lx).toBeCloseTo(3);
    expect(lz).toBeCloseTo(-4);
  });

  it('puts each venue entrance spot near its door on the island', () => {
    const spots = JSON.parse(readFileSync('contract/ids/spots.json', 'utf8')) as {
      venues: Record<string, { spots: Array<{ id: string; x?: number; z?: number }> }>;
    };
    const venues = getIslandGeometry().venues!;
    let checked = 0;
    for (const [id, p] of Object.entries(venues)) {
      const e = spots.venues[id]?.spots.find((s) => s.id.endsWith('.entrance'));
      if (e?.x === undefined || e.z === undefined) continue;
      const [ix, iz] = venueToIsland(p, e.x, e.z);
      expect(Math.hypot(ix - p.door[0], iz - p.door[1]), id).toBeLessThan(4);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});
