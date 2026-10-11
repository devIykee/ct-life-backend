/** Durable operator spending reservations. No API key or signed output URL belongs in this file. */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ValidationFailedError } from '../../server/shared/domain/errors.js';
export const TRIAL_LIMIT = 200;
export const STAGE_CEILINGS = { reference: 10, mesh: 50, prerig: 0, rig: 25 } as const;
export type TrialStage = keyof typeof STAGE_CEILINGS;
const Stage = z.enum(['reference', 'mesh', 'prerig', 'rig']);
const Attempt = z.object({
  trial: z.string(),
  stage: Stage,
  reserved: z.number().nonnegative(),
  state: z.enum(['submitting', 'submitted', 'success', 'failed', 'ambiguous']),
  at: z.string(),
  taskId: z.string().optional(),
  consumed: z.number().nonnegative().optional(),
});
const Balance = z.object({ balance: z.number().nonnegative(), frozen: z.number().nonnegative() });
export const TrialLedgerSchema = z.object({
  version: z.literal(1),
  limit: z.literal(TRIAL_LIMIT),
  initialBalance: Balance,
  latestBalance: Balance,
  updatedAt: z.string(),
  attempts: z.array(Attempt),
  notes: z.array(z.string()),
});
export type TrialLedger = z.infer<typeof TrialLedgerSchema>;
/** Flush the data file and its directory around atomic replacement. */
export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(join(path, '..'), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
/** Reopen one campaign journal on every invocation; never silently reset reservations. */
export function readTrialLedger(directory: string): TrialLedger {
  return TrialLedgerSchema.parse(
    JSON.parse(readFileSync(join(directory, 'spend-journal.json'), 'utf8')),
  );
}
/** Create a journal only with exclusive creation; a second campaign must not overwrite it. */
export function initializeTrialLedger(
  directory: string,
  balance: { balance: number; frozen: number },
): TrialLedger {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ledger: TrialLedger = {
    version: 1,
    limit: TRIAL_LIMIT,
    initialBalance: balance,
    latestBalance: balance,
    updatedAt: new Date().toISOString(),
    attempts: [],
    notes: [
      'Operator evaluation authorized for at most 200 Tripo API credits; no public activation or wallet payment.',
    ],
  };
  const path = join(directory, 'spend-journal.json'),
    fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(ledger, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return ledger;
}
/** Persist a conservative reservation BEFORE issuing any potentially paid POST. */
export function reserveTrialStage(
  directory: string,
  trial: string,
  stage: TrialStage,
  balance: { balance: number; frozen: number },
): TrialLedger {
  const ledger = readTrialLedger(directory);
  if (!/^[a-z0-9_-]{1,40}$/.test(trial))
    throw new ValidationFailedError({ reason: 'invalid_trial_id' });
  if (ledger.attempts.some((a) => a.trial === trial && a.stage === stage))
    throw new ValidationFailedError({ reason: 'trial_stage_already_reserved_no_resubmit' });
  if (ledger.attempts.some((a) => a.consumed !== undefined && a.consumed > a.reserved))
    throw new ValidationFailedError({ reason: 'provider_exceeded_credit_reservation_stop' });
  if (ledger.attempts.some((a) => ['submitting', 'submitted', 'ambiguous'].includes(a.state)))
    throw new ValidationFailedError({ reason: 'reconcile_existing_trial_first' });
  const reserved = STAGE_CEILINGS[stage],
    committed = ledger.attempts.reduce((sum, a) => sum + Math.max(a.reserved, a.consumed ?? 0), 0);
  if (committed + reserved > TRIAL_LIMIT)
    throw new ValidationFailedError({ reason: 'operator_credit_cap_exceeded' });
  if (balance.frozen > 0 || balance.balance < reserved)
    throw new ValidationFailedError({ reason: 'insufficient_or_frozen_api_credits' });
  if (ledger.attempts.length === 0) ledger.initialBalance = balance;
  ledger.latestBalance = balance;
  ledger.updatedAt = new Date().toISOString();
  ledger.attempts.push({ trial, stage, reserved, state: 'submitting', at: ledger.updatedAt });
  writePrivateJson(join(directory, 'spend-journal.json'), ledger);
  return ledger;
}
/** Update known task identity/results without releasing its conservative reservation. */
export function recordTrialStage(
  directory: string,
  trial: string,
  stage: TrialStage,
  update: {
    state: 'submitted' | 'success' | 'failed' | 'ambiguous';
    taskId?: string;
    consumed?: number;
  },
  balance?: { balance: number; frozen: number },
): TrialLedger {
  const ledger = readTrialLedger(directory),
    attempt = ledger.attempts.find((a) => a.trial === trial && a.stage === stage);
  if (!attempt) throw new ValidationFailedError({ reason: 'missing_trial_reservation' });
  if (attempt.taskId && update.taskId && attempt.taskId !== update.taskId)
    throw new ValidationFailedError({ reason: 'trial_task_identity_changed' });
  Object.assign(attempt, update);
  if (balance) ledger.latestBalance = balance;
  ledger.updatedAt = new Date().toISOString();
  writePrivateJson(join(directory, 'spend-journal.json'), ledger);
  if (attempt.consumed !== undefined && attempt.consumed > attempt.reserved)
    throw new ValidationFailedError({ reason: 'provider_exceeded_credit_reservation_stop' });
  return ledger;
}
