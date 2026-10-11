/** Durable paid stages: reserve before POST, retain task IDs, never blind-retry submissions.
 * This slightly exceeds the 300-line soft limit to keep paid-stage recovery in one state machine. */
import { createHash, randomInt } from 'node:crypto';
import type {
  LikenessPipelineRepository,
  PipelineJob,
  GenerationStage,
  ProviderAttempt,
} from '../shared/db/likeness-pipeline.js';
import {
  TripoAdapter,
  TripoRequestError,
  TRIPO_REFERENCE_PROMPT_VERSION,
} from '../shared/infra/tripo.js';
import { normalizeLikenessPhoto } from '../shared/infra/likeness-image.js';
import type { PrivateLikenessStorage } from '../shared/infra/likeness-storage.js';
import { DomainError, ValidationFailedError } from '../shared/domain/errors.js';
import { LikenessArtifactReader, inspectRiggedGlb } from '../shared/infra/likeness-artifacts.js';

export interface CharacterReferences {
  /** Server-owned full-body reference, immutable revision (ideally its SHA-256). */
  load(
    modelId: string,
  ): Promise<{ bytes: Buffer; contentType: 'image/jpeg' | 'image/png'; revision: string }>;
}

export class LikenessGenerationWorker {
  /** The production composition must supply all external readiness gates explicitly. */
  constructor(
    private readonly repository: LikenessPipelineRepository,
    private readonly storage: PrivateLikenessStorage,
    private readonly references: CharacterReferences,
    private readonly provider: TripoAdapter,
    private readonly artifacts: LikenessArtifactReader,
    private readonly enabled = false,
    private readonly now: () => Date = () => new Date(),
    private readonly validateAsset?: (job: PipelineJob, bytes: Buffer) => Promise<void>,
  ) {}

  /** Process at most one bounded stage. No claim or provider activity when disabled. */
  async tick(): Promise<boolean> {
    if (!this.enabled) return false;
    const job = await this.repository.claim(this.now());
    if (!job) return false;
    if (job.deadline_at <= this.now()) {
      await this.repository.stop(job, 'failed', 'generation_deadline_exceeded', this.now());
      return true;
    }
    // A leased submitting stage surviving a worker crash is ambiguous. Replaying
    // it might spend a second customer's credit: hold it for reconciliation.
    if (job.phase.endsWith('_submitting')) {
      await this.repository.stop(
        job,
        'reconciliation_required',
        'worker_lost_during_submission',
        this.now(),
      );
      return true;
    }
    if (!(await this.repository.activeSource(job, this.now()))) {
      await this.repository.stop(job, 'failed', 'processing_permission_withdrawn', this.now());
      return true;
    }
    try {
      if (job.phase === 'sources') await this.sources(job);
      else if (job.phase.endsWith('_ready'))
        await this.submit(job, job.phase.slice(0, -6) as GenerationStage);
      else if (job.phase.endsWith('_polling'))
        await this.poll(job, job.phase.slice(0, -8) as GenerationStage);
      else await this.repository.stop(job, 'failed', 'unsupported_generation_phase', this.now());
    } catch (error) {
      if (error instanceof ValidationFailedError) {
        await this.repository.stop(
          job,
          'failed',
          'invalid_generation_artifact_or_input',
          this.now(),
        );
        return true;
      }
      const isSource =
        job.phase === 'sources' || (job.phase === 'mesh_ready' && !job.approved_reference_token);
      if (isSource && job.source_failures < 2)
        await this.repository.wait(
          job,
          this.now(),
          10_000 * 2 ** job.source_failures + randomInt(0, 1000),
          'source',
        );
      else if (job.phase.endsWith('_polling') && job.poll_failures < 2)
        await this.repository.wait(
          job,
          this.now(),
          10_000 * 2 ** job.poll_failures + randomInt(0, 1000),
          'poll',
        );
      else
        await this.repository.stop(
          job,
          job.phase.endsWith('_polling') || (job.phase.endsWith('_ready') && !isSource)
            ? 'reconciliation_required'
            : 'failed',
          error instanceof TripoRequestError ? 'provider_unavailable' : 'generation_stage_failed',
          this.now(),
        );
    }
    return true;
  }

  private async loadReference(modelId: string): ReturnType<CharacterReferences['load']> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.references.load(modelId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new TripoRequestError('character_reference_load_timeout')),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async sources(job: PipelineJob): Promise<void> {
    const source = await this.repository.activeSource(job, this.now());
    if (!source) return;
    const character = await this.loadReference(job.model_id);
    const normalized = await normalizeLikenessPhoto(character.bytes, character.contentType);
    const face = await this.storage.get(source.objectKey);
    if (!(await this.repository.activeSource(job, this.now()))) return;
    const faceToken = await this.provider.uploadImage(face, 'jpeg');
    if (!(await this.repository.activeSource(job, this.now()))) return;
    const characterToken = await this.provider.uploadImage(normalized.bytes, 'jpeg');
    await this.repository.sourcesReady(
      job,
      {
        faceToken,
        characterToken,
        seed: randomInt(0, 2_147_483_647),
        revision: character.revision,
        promptVersion: TRIPO_REFERENCE_PROMPT_VERSION,
      },
      this.now(),
    );
  }

  private async submit(job: PipelineJob, stage: GenerationStage): Promise<void> {
    if (stage === 'mesh' && !job.approved_reference_token) {
      if (!job.reference_key) throw new ValidationFailedError({ reason: 'missing_reference_key' });
      const bytes = await this.storage.get(job.reference_key);
      if (!(await this.repository.activeSource(job, this.now()))) return;
      const token = await this.provider.uploadImage(bytes, 'jpeg');
      await this.repository.advance(job, 'mesh_ready', this.now(), { referenceToken: token });
      return;
    }
    const attempt = await this.repository.reserveAttempt(job, stage, this.now());
    if (!attempt) return;
    try {
      if (!(await this.repository.activeSource(job, this.now()))) return;
      let task: string;
      if (stage === 'reference')
        task = await this.provider.prepareReference(
          job.model_id,
          { token: job.provider_character_token!, type: 'jpeg' },
          { token: job.provider_face_token!, type: 'jpeg' },
        );
      else if (stage === 'mesh')
        task = await this.provider.generate(job.approved_reference_token!, 'jpeg', job.seed!);
      else {
        const mesh = await this.repository.attempt(job.id, 'mesh');
        if (!mesh?.provider_task_id)
          throw new ValidationFailedError({ reason: 'missing_mesh_task' });
        if (!(await this.repository.activeSource(job, this.now()))) return;
        task =
          stage === 'prerig'
            ? await this.provider.preRigCheck(mesh.provider_task_id)
            : job.mode === 'human'
              ? await this.provider.rigHuman(mesh.provider_task_id)
              : await this.provider.rig(mesh.provider_task_id);
      }
      // A crash/DB failure after the paid POST leaves *_submitting, which is
      // held on lease expiry instead of reissuing another provider request.
      await this.repository.submitted(job, attempt, task, this.now());
    } catch (error) {
      const ambiguous = !(error instanceof TripoRequestError) || error.submissionUnknown;
      await this.repository.markAttempt(attempt.id, ambiguous ? 'ambiguous' : 'failed', this.now());
      await this.repository.stop(
        job,
        ambiguous ? 'reconciliation_required' : 'failed',
        ambiguous ? 'provider_submission_unknown' : 'provider_submission_rejected',
        this.now(),
      );
    }
  }

  private async poll(job: PipelineJob, stage: GenerationStage): Promise<void> {
    const attempt = await this.repository.attempt(job.id, stage);
    if (!attempt?.provider_task_id) {
      await this.repository.stop(
        job,
        'reconciliation_required',
        'missing_provider_task',
        this.now(),
      );
      return;
    }
    if (this.now().getTime() - attempt.reserved_at.getTime() > 30 * 60 * 1000) {
      await this.repository.stop(
        job,
        'reconciliation_required',
        'provider_task_deadline_exceeded',
        this.now(),
      );
      return;
    }
    const result = await this.provider.status(attempt.provider_task_id);
    if (result.status === 'queued' || result.status === 'running') {
      await this.repository.wait(job, this.now(), 10_000);
      return;
    }
    if (result.status === 'unknown') {
      await this.repository.stop(
        job,
        'reconciliation_required',
        'provider_task_unknown',
        this.now(),
      );
      return;
    }
    if (result.status !== 'success') {
      await this.repository.markAttempt(attempt.id, 'failed', this.now(), result.consumedCredits);
      await this.repository.stop(job, 'failed', `provider_${result.status}`, this.now());
      return;
    }
    await this.acceptResult(job, attempt, result.output, result.consumedCredits);
  }

  private async acceptResult(
    job: PipelineJob,
    attempt: ProviderAttempt,
    output: Awaited<ReturnType<TripoAdapter['status']>>['output'],
    credits: number | null,
  ): Promise<void> {
    // Record known provider expenditure even when the downloaded artifact fails validation.
    await this.repository.markAttempt(attempt.id, 'succeeded', this.now(), credits);
    if (attempt.stage === 'reference') {
      const url = output.generated_image ?? output.image;
      if (!url || !job.reference_key)
        throw new ValidationFailedError({ reason: 'missing_reference_image' });
      const image = await this.artifacts.read(url, 8 * 1024 * 1024);
      const mime = image[0] === 137 ? 'image/png' : 'image/jpeg';
      const normalized = await normalizeLikenessPhoto(image, mime);
      if (!(await this.repository.activeSource(job, this.now()))) return;
      await this.putArtifact(job.reference_key, normalized.bytes, 'image/jpeg');
      await this.repository.advance(job, 'awaiting_reference_approval', this.now(), {
        referenceHash: normalized.sha256,
      });
    } else if (attempt.stage === 'mesh')
      await this.repository.advance(job, 'prerig_ready', this.now());
    else if (attempt.stage === 'prerig') {
      if (output.riggable !== true || output.rig_type !== 'biped') {
        await this.repository.stop(job, 'failed', 'generated_model_not_biped_riggable', this.now());
      } else await this.repository.advance(job, 'rig_ready', this.now());
    } else {
      const url = output.model ?? output.pbr_model;
      if (!url || !job.asset_key)
        throw new ValidationFailedError({ reason: 'missing_rigged_asset' });
      const bytes = await this.artifacts.read(url, 32 * 1024 * 1024);
      const inspected = inspectRiggedGlb(bytes);
      if (!(await this.repository.activeSource(job, this.now()))) return;
      await this.putArtifact(job.asset_key, bytes, 'model/gltf-binary');
      // A valid GLB is not yet a playable approved avatar. Unity skeleton,
      // materials, animation and on-device budget validation are still required.
      await this.repository.advance(job, 'awaiting_asset_validation', this.now(), {
        assetHash: inspected.sha256,
      });
      if (this.validateAsset) await this.validateAsset(job, bytes);
    }
  }
  private async putArtifact(
    key: string,
    bytes: Buffer,
    contentType: 'image/jpeg' | 'model/gltf-binary',
  ): Promise<void> {
    try {
      await this.storage.put(key, bytes, contentType);
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'CONFLICT') throw error;
      const existing = await this.storage.get(key, 32 * 1024 * 1024);
      if (
        createHash('sha256').update(existing).digest('hex') !==
        createHash('sha256').update(bytes).digest('hex')
      )
        throw error;
    }
  }
  /** Call from the same bounded scheduler even while new generation is disabled. */
  async cleanup(): Promise<number> {
    const rows = await this.repository.cleanupCandidates(this.now());
    let removed = 0;
    for (const row of rows) {
      try {
        if (row.reference_key) await this.storage.delete(row.reference_key);
        if (row.asset_key) await this.storage.delete(row.asset_key);
        await this.repository.artifactsDeleted(row.id, this.now());
        removed++;
      } catch {
        /* Keep the durable cleanup journal for the next sweep. */
      }
    }
    return removed;
  }
}
