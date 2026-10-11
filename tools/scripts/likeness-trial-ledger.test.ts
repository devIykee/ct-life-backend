/** Durable disk-backed budget tests; no provider network or real credentials. */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  initializeTrialLedger,
  readTrialLedger,
  recordTrialStage,
  reserveTrialStage,
  type TrialStage,
} from './likeness-trial-ledger.js';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ctlife-trial-ledger-'));
  initializeTrialLedger(directory, { balance: 300, frozen: 0 });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function finish(trial: string, stage: TrialStage, cost: number) {
  reserveTrialStage(directory, trial, stage, { balance: 300, frozen: 0 });
  recordTrialStage(directory, trial, stage, { state: 'submitted', taskId: `${trial}-${stage}` });
  recordTrialStage(
    directory,
    trial,
    stage,
    { state: 'success', consumed: cost },
    { balance: 300 - cost, frozen: 0 },
  );
}
describe('operator credit reservation journal', () => {
  it('persists private200-credit cap and refuses journal replacement', () => {
    expect(readTrialLedger(directory).limit).toBe(200);
    expect(statSync(join(directory, 'spend-journal.json')).mode & 0o777).toBe(0o600);
    expect(() => initializeTrialLedger(directory, { balance: 900, frozen: 0 })).toThrow();
  });
  it('reserves before task ID exists and refuses replay after a crash/reopen', () => {
    reserveTrialStage(directory, 'trial1', 'reference', { balance: 300, frozen: 0 });
    expect(readTrialLedger(directory).attempts[0]).toMatchObject({
      state: 'submitting',
      reserved: 10,
    });
    expect(() =>
      reserveTrialStage(directory, 'trial1', 'reference', { balance: 300, frozen: 0 }),
    ).toThrow();
    expect(() =>
      reserveTrialStage(directory, 'trial2', 'reference', { balance: 300, frozen: 0 }),
    ).toThrow();
  });
  it('keeps uncertain submissions reserved instead of using balance to retry them', () => {
    reserveTrialStage(directory, 'trial1', 'mesh', { balance: 300, frozen: 0 });
    recordTrialStage(directory, 'trial1', 'mesh', { state: 'ambiguous' });
    expect(() =>
      reserveTrialStage(directory, 'trial2', 'mesh', { balance: 300, frozen: 0 }),
    ).toThrow();
    expect(readTrialLedger(directory).attempts[0]?.reserved).toBe(50);
  });
  it('allows170 reserved across two trials but refuses crossing200 even if actual costs were lower', () => {
    for (const trial of ['trial1', 'trial2'])
      for (const [stage, cost] of [
        ['reference', 10],
        ['mesh', 40],
        ['prerig', 0],
        ['rig', 25],
      ] as const)
        finish(trial, stage, cost);
    expect(readTrialLedger(directory).attempts.reduce((sum, a) => sum + a.reserved, 0)).toBe(170);
    expect(() =>
      reserveTrialStage(directory, 'trial3', 'mesh', { balance: 9999, frozen: 0 }),
    ).toThrow();
    expect(readTrialLedger(directory).attempts).toHaveLength(8);
  });
  it('rejects insufficient or frozen balance before creating a reservation', () => {
    expect(() =>
      reserveTrialStage(directory, 'trial1', 'mesh', { balance: 49.99, frozen: 0 }),
    ).toThrow();
    expect(() =>
      reserveTrialStage(directory, 'trial1', 'reference', { balance: 300, frozen: 0.01 }),
    ).toThrow();
    expect(readTrialLedger(directory).attempts).toHaveLength(0);
  });
  it('retains an unexpectedly high provider charge and blocks all further submissions', () => {
    reserveTrialStage(directory, 'trial1', 'reference', { balance: 300, frozen: 0 });
    recordTrialStage(directory, 'trial1', 'reference', { state: 'submitted', taskId: 'task1' });
    expect(() =>
      recordTrialStage(directory, 'trial1', 'reference', { state: 'success', consumed: 11 }),
    ).toThrow();
    expect(readTrialLedger(directory).attempts[0]?.consumed).toBe(11);
    expect(() =>
      reserveTrialStage(directory, 'trial1', 'mesh', { balance: 300, frozen: 0 }),
    ).toThrow();
  });
  it('refuses changing an already recorded provider task identity', () => {
    reserveTrialStage(directory, 'trial1', 'reference', { balance: 300, frozen: 0 });
    recordTrialStage(directory, 'trial1', 'reference', { state: 'submitted', taskId: 'first' });
    expect(() =>
      recordTrialStage(directory, 'trial1', 'reference', { state: 'submitted', taskId: 'second' }),
    ).toThrow();
    expect(readTrialLedger(directory).attempts[0]?.taskId).toBe('first');
  });
});
