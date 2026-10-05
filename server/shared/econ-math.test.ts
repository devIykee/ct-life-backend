/**
 * Tax brackets and shift scoring.
 *
 * Unit tests for the math the simulator and the M2 services apply.
 */
import { describe, it, expect } from 'vitest';

function applyTax(weeklyIncomeCents: number): number {
  const FREE = 500_000; // $5k/week
  const BPS = 2_000; // 20%
  if (weeklyIncomeCents <= FREE) return 0;
  const taxable = weeklyIncomeCents - FREE;
  return Math.round((taxable * BPS) / 10_000);
}

function applyShiftScore(maxScore: number, score: number, basePayCents: number): number {
  const clamped = Math.max(0, Math.min(score, maxScore));
  return Math.round(basePayCents * (clamped / maxScore));
}

describe('tax brackets', () => {
  it('zero tax below 5k/week', () => {
    expect(applyTax(0)).toBe(0);
    expect(applyTax(400_00)).toBe(0);
    expect(applyTax(500_000)).toBe(0);
  });
  it('20% above 5k/week', () => {
    expect(applyTax(600_000)).toBe(20_000);
    expect(applyTax(1_000_000)).toBe(100_000);
  });
});

describe('shift scoring', () => {
  it('caps score at maxScore', () => {
    expect(applyShiftScore(100, 50, 4000)).toBe(2000);
    expect(applyShiftScore(100, 100, 4000)).toBe(4000);
    expect(applyShiftScore(100, 9999, 4000)).toBe(4000);
    expect(applyShiftScore(100, 0, 4000)).toBe(0);
  });
});
