/** Operator-only staged trial. Never imported by API/workers; default public product stays disabled.
 * Commands accept paths/identifiers, never a credential. The key is read only from process env.
 * Every paid stage reserves its ceiling durably before POST; no task stage can be resubmitted.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { TripoAdapter, TripoRequestError } from '../../server/shared/infra/tripo.js';
import { normalizeLikenessPhoto } from '../../server/shared/infra/likeness-image.js';
import {
  LikenessArtifactReader,
  inspectRiggedGlb,
} from '../../server/shared/infra/likeness-artifacts.js';
import { DomainError, ValidationFailedError } from '../../server/shared/domain/errors.js';
import { LIKENESS_MODELS } from '../../server/shared/domain/likeness.js';
import {
  initializeTrialLedger,
  readTrialLedger,
  recordTrialStage,
  reserveTrialStage,
  writePrivateJson,
  STAGE_CEILINGS,
  type TrialStage,
} from './likeness-trial-ledger.js';
const Manifest = z.object({
  id: z.string(),
  modelId: z.string(),
  sourceDescription: z.string(),
  bodyHash: z.string(),
  faceHash: z.string(),
  bodyToken: z.string().optional(),
  faceToken: z.string().optional(),
  referenceToken: z.string().optional(),
  referenceHash: z.string().optional(),
  approvedHash: z.string().optional(),
  artifactHosts: z.array(z.string()),
  seed: z.number().int(),
});
type Trial = z.infer<typeof Manifest>;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stageOf = (raw: string | undefined): TrialStage =>
  z.enum(['reference', 'mesh', 'prerig', 'rig']).parse(raw);
function fail(reason: string): never {
  throw new ValidationFailedError({ reason });
}
function readTrial(directory: string, id: string): Trial {
  return Manifest.parse(JSON.parse(readFileSync(join(directory, id, 'trial.json'), 'utf8')));
}
function saveTrial(directory: string, trial: Trial): void {
  writePrivateJson(join(directory, trial.id, 'trial.json'), trial);
}
function printSummary(directory: string): void {
  const ledger = readTrialLedger(directory);
  console.log(
    JSON.stringify({
      limit: ledger.limit,
      reserved: ledger.attempts.reduce((sum, a) => sum + a.reserved, 0),
      reportedConsumed: ledger.attempts.reduce((sum, a) => sum + (a.consumed ?? 0), 0),
      balance: ledger.latestBalance,
      attempts: ledger.attempts.map((a) => ({
        trial: a.trial,
        stage: a.stage,
        state: a.state,
        reserved: a.reserved,
        consumed: a.consumed,
        taskId: a.taskId,
      })),
    }),
  );
}
async function source(path: string) {
  const bytes = readFileSync(path);
  return normalizeLikenessPhoto(bytes, bytes[0] === 137 ? 'image/png' : 'image/jpeg');
}
async function submit(
  directory: string,
  trial: Trial,
  stage: TrialStage,
  provider: TripoAdapter,
): Promise<void> {
  const ledger = readTrialLedger(directory),
    prior = ledger.attempts.filter((a) => a.trial === trial.id);
  if (prior.some((a) => a.stage === stage)) fail('trial_stage_already_reserved_no_resubmit');
  const expected: TrialStage[] = ['reference', 'mesh', 'prerig', 'rig'];
  if (expected[prior.length] !== stage || prior.some((a) => a.state !== 'success'))
    fail('trial_stage_prerequisite_missing');
  const balance = await provider.balance();
  // Do not even upload source images without enough balance for this planned first trial.
  if (stage === 'reference' && (balance.balance < 85 || balance.frozen > 0))
    fail('full_trial_requires85_available_credits');
  if (stage === 'mesh' && (!trial.referenceHash || trial.approvedHash !== trial.referenceHash))
    fail('operator_must_approve_conditioned_reference');
  if (stage === 'rig') {
    const check = prior.find((a) => a.stage === 'prerig');
    if (!check?.taskId) fail('missing_prerig_task');
    const status = await provider.status(check.taskId);
    if (
      status.status !== 'success' ||
      status.output.riggable !== true ||
      status.output.rig_type !== 'biped'
    )
      fail('model_not_biped_riggable');
  }
  if (stage === 'reference') {
    if (!trial.bodyToken) {
      trial.bodyToken = await provider.uploadImage(
        readFileSync(join(directory, trial.id, 'body.jpg')),
        'jpeg',
      );
      saveTrial(directory, trial);
    }
    if (!trial.faceToken) {
      trial.faceToken = await provider.uploadImage(
        readFileSync(join(directory, trial.id, 'face.jpg')),
        'jpeg',
      );
      saveTrial(directory, trial);
    }
  }
  if (stage === 'mesh' && !trial.referenceToken) {
    trial.referenceToken = await provider.uploadImage(
      readFileSync(join(directory, trial.id, 'conditioned.jpg')),
      'jpeg',
    );
    saveTrial(directory, trial);
  }
  reserveTrialStage(directory, trial.id, stage, balance);
  try {
    let taskId: string;
    if (stage === 'reference')
      taskId = await provider.prepareReference(
        trial.modelId,
        { token: trial.bodyToken!, type: 'jpeg' },
        { token: trial.faceToken!, type: 'jpeg' },
      );
    else if (stage === 'mesh')
      taskId = await provider.generate(trial.referenceToken!, 'jpeg', trial.seed);
    else {
      const mesh = prior.find((a) => a.stage === 'mesh');
      if (!mesh?.taskId) fail('missing_mesh_task');
      taskId =
        stage === 'prerig'
          ? await provider.preRigCheck(mesh.taskId)
          : await provider.rig(mesh.taskId);
    }
    recordTrialStage(directory, trial.id, stage, { state: 'submitted', taskId });
    console.log(
      JSON.stringify({ stage, taskId, state: 'submitted', reserved: STAGE_CEILINGS[stage] }),
    );
  } catch (error) {
    const ambiguous = !(error instanceof TripoRequestError) || error.submissionUnknown;
    recordTrialStage(directory, trial.id, stage, { state: ambiguous ? 'ambiguous' : 'failed' });
    throw error;
  }
}
async function poll(
  directory: string,
  trial: Trial,
  stage: TrialStage,
  provider: TripoAdapter,
): Promise<void> {
  const attempt = readTrialLedger(directory).attempts.find(
    (a) => a.trial === trial.id && a.stage === stage,
  );
  if (!attempt?.taskId) fail('no_task_id_reconcile_do_not_resubmit');
  const result = await provider.status(attempt.taskId),
    balance = await provider.balance();
  const hosts = [
    ...new Set(
      Object.values(result.output)
        .filter((v): v is string => typeof v === 'string' && v.startsWith('https:'))
        .map((url) => new URL(url).hostname),
    ),
  ];
  if (['success', 'failed', 'banned', 'expired', 'cancelled'].includes(result.status)) {
    if (result.consumedCredits === null) fail('consumed_credits_missing_reconcile');
    recordTrialStage(
      directory,
      trial.id,
      stage,
      {
        state: result.status === 'success' ? 'success' : 'failed',
        consumed: result.consumedCredits,
      },
      balance,
    );
  }
  console.log(
    JSON.stringify({
      stage,
      status: result.status,
      progress: result.progress,
      consumed: result.consumedCredits,
      balance,
      outputHosts: hosts,
      riggable: result.output.riggable,
      rigType: result.output.rig_type,
    }),
  );
}
async function download(
  directory: string,
  trial: Trial,
  stage: TrialStage,
  provider: TripoAdapter,
): Promise<void> {
  if (stage !== 'reference' && stage !== 'rig') fail('only_reference_or_rig_artifacts');
  const attempt = readTrialLedger(directory).attempts.find(
    (a) => a.trial === trial.id && a.stage === stage,
  );
  if (attempt?.state !== 'success' || !attempt.taskId) fail('completed_task_required');
  const result = await provider.status(attempt.taskId),
    url =
      stage === 'reference'
        ? (result.output.generated_image ?? result.output.image)
        : (result.output.model ?? result.output.pbr_model);
  if (!url) fail('provider_output_missing');
  const host = new URL(url).hostname;
  if (!trial.artifactHosts.includes(host)) fail(`operator_must_allow_output_host:${host}`);
  const bytes = await new LikenessArtifactReader(trial.artifactHosts, 30000).read(
    url,
    stage === 'reference' ? 8 * 1024 * 1024 : 32 * 1024 * 1024,
  );
  if (stage === 'reference') {
    const normalized = await normalizeLikenessPhoto(
      bytes,
      bytes[0] === 137 ? 'image/png' : 'image/jpeg',
    );
    writeFileSync(
      join(
        directory,
        trial.id,
        bytes[0] === 137 ? 'conditioned-original.png' : 'conditioned-original.jpg',
      ),
      bytes,
      { mode: 0o600 },
    );
    writeFileSync(join(directory, trial.id, 'conditioned.jpg'), normalized.bytes, { mode: 0o600 });
    trial.referenceHash = normalized.sha256;
    saveTrial(directory, trial);
    console.log(
      JSON.stringify({
        reference: join(directory, trial.id, 'conditioned.jpg'),
        sha256: normalized.sha256,
      }),
    );
  } else {
    const path = join(directory, trial.id, 'rigged-unapproved.glb');
    writeFileSync(path, bytes, { mode: 0o600 });
    let inspection: unknown;
    try {
      inspection = { acceptedStructuralSubset: true, ...inspectRiggedGlb(bytes) };
    } catch (error) {
      inspection = {
        acceptedStructuralSubset: false,
        reason: error instanceof DomainError ? error.details?.reason : 'inspection_failed',
        sha256: sha(bytes),
      };
    }
    writePrivateJson(join(directory, trial.id, 'inspection.json'), inspection);
    console.log(
      JSON.stringify({ artifact: path, bytes: bytes.length, inspection, playable: false }),
    );
  }
}
/** Run only an explicit local operator command; never auto-progress to another paid stage. */
export async function runTrial(args: string[]): Promise<void> {
  const [command, directoryRaw, id = 'trial1', parameter, extra, modelId = 'head_snow'] = args;
  if (!directoryRaw || !isAbsolute(directoryRaw))
    fail('absolute_external_evidence_directory_required');
  const directory = resolve(directoryRaw);
  if (directory.startsWith(process.cwd() + '/')) fail('evidence_must_be_outside_repository');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, '.operator.lock'),
    lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, String(process.pid));
  try {
    const key = process.env.TRIPO_API_KEY;
    if (!key?.trim()) fail('provider_key_not_configured');
    const provider = new TripoAdapter({
      apiKey: key,
      endUserAgreementConfirmed: false,
      authorizedOperatorEvaluation: true,
      timeoutMs: 30000,
    });
    if (command === 'balance') {
      const balance = await provider.balance();
      if (!existsSync(join(directory, 'spend-journal.json')))
        initializeTrialLedger(directory, balance);
      else {
        const ledger = readTrialLedger(directory);
        ledger.latestBalance = balance;
        ledger.updatedAt = new Date().toISOString();
        writePrivateJson(join(directory, 'spend-journal.json'), ledger);
      }
      console.log(JSON.stringify(balance));
      return;
    }
    if (command === 'init') {
      if (!/^[a-z0-9_-]{1,40}$/.test(id) || !parameter || !extra)
        fail('init_requires_trial_body_path_face_path');
      if (existsSync(join(directory, id, 'trial.json'))) fail('trial_already_initialized');
      const identity = LIKENESS_MODELS.find(
        (m) => m.modelId === modelId && m.reason !== 'face_covered',
      );
      if (!identity) fail('unsupported_trial_identity');
      const body = await source(parameter),
        face = await source(extra);
      mkdirSync(join(directory, id), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, id, 'body.jpg'), body.bytes, { mode: 0o600 });
      writeFileSync(join(directory, id, 'face.jpg'), face.bytes, { mode: 0o600 });
      saveTrial(directory, {
        id,
        modelId: identity.modelId,
        sourceDescription:
          'Owned CT Life stock body and fictional/synthetic adult likeness; no user selfie or third-party person photo.',
        bodyHash: body.sha256,
        faceHash: face.sha256,
        artifactHosts: [],
        seed: 20261011,
      });
      console.log(JSON.stringify({ trial: id, bodySha256: body.sha256, faceSha256: face.sha256 }));
      return;
    }
    if (command === 'report') {
      printSummary(directory);
      return;
    }
    // Explicitly authorized corrective comparison on the existing human mesh.
    // Separate journal identity preserves the rejected first rig and its cost.
    if (command === 'human-rerig') {
      if (id !== 'synthetic-human1') fail('human_rerig_only_existing_authorized_trial');
      const trial = readTrial(directory, id);
      const ledger = readTrialLedger(directory);
      const mesh = ledger.attempts.find(
        (a) => a.trial === id && a.stage === 'mesh' && a.state === 'success',
      );
      if (!mesh?.taskId) fail('missing_existing_human_mesh');
      const rerigId = 'synthetic-human1-mixamo';
      const balance = await provider.balance();
      reserveTrialStage(directory, rerigId, 'rig', balance);
      mkdirSync(join(directory, rerigId), { recursive: true, mode: 0o700 });
      saveTrial(directory, { ...trial, id: rerigId });
      try {
        const taskId = await provider.rigHuman(mesh.taskId);
        recordTrialStage(directory, rerigId, 'rig', { state: 'submitted', taskId });
        console.log(JSON.stringify({ trial: rerigId, state: 'submitted', reserved: 25 }));
      } catch (error) {
        const ambiguous = !(error instanceof TripoRequestError) || error.submissionUnknown;
        recordTrialStage(directory, rerigId, 'rig', { state: ambiguous ? 'ambiguous' : 'failed' });
        throw error;
      }
      return;
    }
    const trial = readTrial(directory, id);
    if (command === 'allow-host') {
      if (!parameter || !/^[a-z0-9.-]+$/.test(parameter) || parameter.includes('..'))
        fail('invalid_artifact_hostname');
      trial.artifactHosts = [...new Set([...trial.artifactHosts, parameter])];
      saveTrial(directory, trial);
      console.log(JSON.stringify({ allowedHostname: parameter }));
      return;
    }
    if (command === 'approve-reference') {
      if (
        !parameter ||
        parameter !== trial.referenceHash ||
        sha(readFileSync(join(directory, id, 'conditioned.jpg'))) !== parameter
      )
        fail('reference_approval_hash_mismatch');
      trial.approvedHash = parameter;
      saveTrial(directory, trial);
      console.log(JSON.stringify({ approved: true, sha256: parameter }));
      return;
    }
    if (command === 'submit') return await submit(directory, trial, stageOf(parameter), provider);
    if (command === 'poll') return await poll(directory, trial, stageOf(parameter), provider);
    if (command === 'download')
      return await download(directory, trial, stageOf(parameter), provider);
    fail('unknown_operator_trial_command');
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
if (process.argv[1]?.endsWith('/likeness-trial.ts'))
  runTrial(process.argv.slice(2)).catch((error) => {
    console.error(
      JSON.stringify({
        error: error instanceof DomainError ? error.code : 'OPERATOR_TRIAL_FAILED',
        reason:
          error instanceof DomainError ? error.details?.reason : 'local_operator_operation_failed',
      }),
    );
    process.exitCode = 1;
  });
