import { describe, it, expect } from 'vitest';
import { EconSim } from './run.js';

describe('econ-sim', () => {
  it('1000 players x 8 weeks keeps median within +/- 50% of starting', () => {
    const sim = new EconSim({ players: 1_000, seed: 0xea1fb0a });
    const snapshots = sim.run(8);
    expect(snapshots.length).toBe(8);
    const issues = EconSim.assertInvariants(100_000, snapshots);
    // The simulator is deterministic on this seed; the guard should
    // not trip. If a future change tips it, the gate is allowed to
    // fail with the printed details.
    expect(issues).toEqual([]);
  });

  it('reports monotonic weekly snapshots', () => {
    const sim = new EconSim({ players: 100, seed: 0xea1fb0a });
    const snapshots = sim.run(8);
    for (let i = 1; i < snapshots.length; i++) {
      expect(snapshots[i]!.week).toBe(snapshots[i - 1]!.week + 1);
    }
  });
});
