/** Postgres is the generation queue and submission journal. This exceeds the soft
 * 300-line limit to keep transaction/lease and stage invariants together. */
import { randomUUID } from 'node:crypto';
import { recordLikenessAction, type LikenessActionReceipt } from './likeness-receipts.js';
import type { Db } from './pool.js';
import { runInTransaction } from './uow.js';
import { NotFoundError, ValidationFailedError, ForbiddenError } from '../domain/errors.js';

export type GenerationStage = 'reference' | 'mesh' | 'prerig' | 'rig';
export interface PipelineJob {
  id: string;
  user_id: string;
  upload_id: string;
  entitlement_id: string;
  model_id: string;
  mode: 'human' | 'stylized';
  phase: string;
  status: string;
  lease_token: string;
  lease_until: Date;
  deadline_at: Date;
  source_failures: number;
  poll_failures: number;
  provider_face_token: string | null;
  provider_character_token: string | null;
  approved_reference_token: string | null;
  reference_key: string | null;
  reference_sha256: string | null;
  asset_key: string | null;
  seed: number | null;
  reference_revision: string | null;
  prompt_version: string | null;
}
export interface ProviderAttempt {
  id: string;
  stage: GenerationStage;
  state: string;
  provider_task_id: string | null;
  reserved_at: Date;
}

export class LikenessPipelineRepository {
  constructor(
    private readonly db: Db,
    private readonly allowedOwners?: readonly string[],
  ) {}

  async claim(now: Date): Promise<PipelineJob | null> {
    return runInTransaction(
      async (c) => {
        const row = await c.query<PipelineJob>(
          `SELECT * FROM likeness_jobs
        WHERE status IN ('queued','processing') AND next_run_at<=$1
        AND ($2::uuid[] IS NULL OR user_id=ANY($2::uuid[]))
        AND (lease_until IS NULL OR lease_until<=$1)
        AND phase NOT IN ('awaiting_reference_approval','awaiting_asset_validation','reconciliation_required','completed','failed','cancelled')
        ORDER BY next_run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
          [now, this.allowedOwners ?? null],
        );
        if (!row.rows[0]) return null;
        const token = randomUUID();
        const claimed = await c.query<PipelineJob>(
          `UPDATE likeness_jobs SET lease_token=$2,lease_until=$3,status='processing',updated_at=$4 WHERE id=$1 RETURNING *`,
          [row.rows[0].id, token, new Date(now.getTime() + 120_000), now],
        );
        return claimed.rows[0]!;
      },
      {},
      this.db,
    );
  }

  async activeSource(job: PipelineJob, now: Date): Promise<{ objectKey: string } | null> {
    const result = await this.db.withConnection((c) =>
      c.query<{ object_key: string }>(
        `SELECT u.object_key FROM likeness_jobs j
      JOIN likeness_uploads u ON u.id=j.upload_id AND u.user_id=j.user_id
      JOIN likeness_entitlements e ON e.id=j.entitlement_id AND e.user_id=j.user_id
      WHERE j.id=$1 AND j.status='processing' AND j.lease_token=$2 AND j.lease_until>$3
      AND u.deleted_at IS NULL AND u.expires_at>$3 AND e.revoked_at IS NULL AND e.verified_at<=$3`,
        [job.id, job.lease_token, now],
      ),
    );
    return result.rows[0] ? { objectKey: result.rows[0].object_key } : null;
  }

  async sourcesReady(
    job: PipelineJob,
    input: {
      faceToken: string;
      characterToken: string;
      seed: number;
      revision: string;
      promptVersion: string;
    },
    now: Date,
  ): Promise<void> {
    await this.db.withConnection((c) =>
      c.query(
        `UPDATE likeness_jobs SET provider_face_token=$3,provider_character_token=$4,
      seed=$5,reference_revision=$6,prompt_version=$7,reference_key=$8,asset_key=$9,
      phase='reference_ready',lease_until=NULL,next_run_at=$10,updated_at=$10
      WHERE id=$1 AND lease_token=$2 AND phase='sources' AND status='processing'`,
        [
          job.id,
          job.lease_token,
          input.faceToken,
          input.characterToken,
          input.seed,
          input.revision,
          input.promptVersion,
          `${randomUUID()}.jpg`,
          `${randomUUID()}.glb`,
          now,
        ],
      ),
    );
  }

  async reserveAttempt(
    job: PipelineJob,
    stage: GenerationStage,
    now: Date,
  ): Promise<ProviderAttempt | null> {
    return runInTransaction(
      async (c) => {
        const locked = await c.query<PipelineJob>(
          'SELECT * FROM likeness_jobs WHERE id=$1 FOR UPDATE',
          [job.id],
        );
        const current = locked.rows[0];
        if (
          !current ||
          current.status !== 'processing' ||
          current.lease_token !== job.lease_token ||
          current.lease_until <= now ||
          current.phase !== `${stage}_ready`
        )
          return null;
        const permission = await c.query<{ credit_budget: string }>(
          `SELECT e.credit_budget FROM likeness_uploads u JOIN likeness_entitlements e ON e.id=$3
        WHERE u.id=$1 AND u.user_id=$2 AND u.deleted_at IS NULL AND u.expires_at>$4
        AND e.user_id=$2 AND e.revoked_at IS NULL AND e.verified_at<=$4`,
          [current.upload_id, current.user_id, current.entitlement_id, now],
        );
        if (!permission.rowCount)
          throw new ForbiddenError({ reason: 'likeness_processing_permission_withdrawn' });
        const reserved = { reference: 10, mesh: 50, prerig: 0, rig: 25 }[stage];
        const spent = await c.query<{ total: string }>(
          'SELECT COALESCE(sum(GREATEST(reserved_credits,COALESCE(consumed_credits,0))),0) AS total FROM likeness_provider_attempts WHERE job_id=$1',
          [job.id],
        );
        if (Number(spent.rows[0]!.total) + reserved > Number(permission.rows[0]!.credit_budget))
          throw new ForbiddenError({ reason: 'likeness_credit_budget_exhausted' });
        const created = await c.query<ProviderAttempt>(
          `INSERT INTO likeness_provider_attempts(id,job_id,stage,state,reserved_at,reserved_credits)
        VALUES($1,$2,$3,'reserved',$4,$5) ON CONFLICT(job_id,stage) DO NOTHING RETURNING *`,
          [randomUUID(), job.id, stage, now, reserved],
        );
        if (!created.rows[0]) {
          await c.query(
            "UPDATE likeness_jobs SET phase='reconciliation_required',failure_reason='submission_already_reserved',lease_until=NULL,updated_at=$2 WHERE id=$1",
            [job.id, now],
          );
          return null;
        }
        await c.query('UPDATE likeness_jobs SET phase=$2,updated_at=$3 WHERE id=$1', [
          job.id,
          `${stage}_submitting`,
          now,
        ]);
        return created.rows[0];
      },
      {},
      this.db,
    );
  }

  async submitted(
    job: PipelineJob,
    attempt: ProviderAttempt,
    taskId: string,
    now: Date,
  ): Promise<void> {
    await runInTransaction(
      async (c) => {
        // Persist a returned task ID even if a lease expired or consent was withdrawn
        // while the HTTP call was in flight. Never erase the only reconciliation ID.
        await c.query(
          `UPDATE likeness_provider_attempts SET state='submitted',provider_task_id=$2,submitted_at=$3
        WHERE id=$1 AND provider_task_id IS NULL AND state IN ('reserved','ambiguous')`,
          [attempt.id, taskId, now],
        );
        await c.query(
          `UPDATE likeness_jobs SET phase=$2,lease_until=NULL,next_run_at=$3,updated_at=$3,poll_failures=0
        WHERE id=$1 AND status='processing' AND phase IN ($4,'reconciliation_required')`,
          [job.id, `${attempt.stage}_polling`, now, `${attempt.stage}_submitting`],
        );
      },
      {},
      this.db,
    );
  }

  async attempt(jobId: string, stage: GenerationStage): Promise<ProviderAttempt | null> {
    const result = await this.db.withConnection((c) =>
      c.query<ProviderAttempt>(
        'SELECT * FROM likeness_provider_attempts WHERE job_id=$1 AND stage=$2',
        [jobId, stage],
      ),
    );
    return result.rows[0] ?? null;
  }

  async markAttempt(
    attemptId: string,
    state: 'succeeded' | 'failed' | 'ambiguous',
    now: Date,
    credits: number | null = null,
  ): Promise<void> {
    await this.db.withConnection((c) =>
      c.query(
        'UPDATE likeness_provider_attempts SET state=$2,completed_at=$3,consumed_credits=$4 WHERE id=$1',
        [attemptId, state, now, credits],
      ),
    );
  }

  async advance(
    job: PipelineJob,
    phase: string,
    now: Date,
    details: { referenceHash?: string; assetHash?: string; referenceToken?: string } = {},
  ): Promise<void> {
    await this.db.withConnection((c) =>
      c.query(
        `UPDATE likeness_jobs SET phase=$3,reference_sha256=COALESCE($4,reference_sha256),
      asset_sha256=COALESCE($5,asset_sha256),approved_reference_token=COALESCE($6,approved_reference_token),
      lease_until=NULL,next_run_at=$7,updated_at=$7,poll_failures=0
      WHERE id=$1 AND lease_token=$2 AND status='processing'`,
        [
          job.id,
          job.lease_token,
          phase,
          details.referenceHash ?? null,
          details.assetHash ?? null,
          details.referenceToken ?? null,
          now,
        ],
      ),
    );
  }

  async wait(
    job: PipelineJob,
    now: Date,
    delayMs: number,
    failure: 'source' | 'poll' | null = null,
  ): Promise<void> {
    await this.db.withConnection((c) =>
      c.query(
        `UPDATE likeness_jobs SET lease_until=NULL,next_run_at=$3,updated_at=$4,
      source_failures=source_failures+$5,poll_failures=poll_failures+$6 WHERE id=$1 AND lease_token=$2 AND status='processing'`,
        [
          job.id,
          job.lease_token,
          new Date(now.getTime() + delayMs),
          now,
          failure === 'source' ? 1 : 0,
          failure === 'poll' ? 1 : 0,
        ],
      ),
    );
  }

  async stop(
    job: PipelineJob,
    phase: 'failed' | 'reconciliation_required',
    reason: string,
    now: Date,
  ): Promise<void> {
    await this.db.withConnection((c) =>
      c.query(
        `UPDATE likeness_jobs SET phase=$3,status=$4,failure_reason=$5,lease_until=NULL,updated_at=$6
      WHERE id=$1 AND lease_token=$2 AND status='processing'`,
        [job.id, job.lease_token, phase, phase === 'failed' ? 'failed' : 'processing', reason, now],
      ),
    );
  }

  async approveReference(
    userId: string,
    id: string,
    hash: string,
    now: Date,
    receipt?: LikenessActionReceipt,
  ): Promise<void> {
    await runInTransaction(
      async (c) => {
        const result = await c.query<PipelineJob & { reference_approved_at: Date | null }>(
          'SELECT * FROM likeness_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [id, userId],
        );
        const job = result.rows[0];
        if (!job) throw new NotFoundError({ kind: 'likeness_job' });
        if (await recordLikenessAction(c, userId, receipt, now)) return;
        if (job.reference_sha256 !== hash)
          throw new ValidationFailedError({ reason: 'reference_preview_changed' });
        if (job.reference_approved_at && job.status !== 'cancelled') return;
        if (job.phase !== 'awaiting_reference_approval' || job.status !== 'processing')
          throw new ForbiddenError({ reason: 'reference_not_awaiting_approval' });
        await c.query(
          "UPDATE likeness_jobs SET phase='mesh_ready',reference_approved_at=$2,next_run_at=$2,updated_at=$2 WHERE id=$1",
          [id, now],
        );
      },
      {},
      this.db,
    );
  }

  async ownedReference(
    userId: string,
    id: string,
    now: Date,
  ): Promise<{ key: string; sha256: string }> {
    const result = await this.db.withConnection((c) =>
      c.query<{ reference_key: string; reference_sha256: string }>(
        `SELECT reference_key,reference_sha256 FROM likeness_jobs
      WHERE id=$1 AND user_id=$2 AND reference_sha256 IS NOT NULL AND status NOT IN ('cancelled','failed') AND deadline_at>$3`,
        [id, userId, now],
      ),
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError({ kind: 'likeness_reference' });
    return { key: row.reference_key, sha256: row.reference_sha256 };
  }

  /** Structural GLB checks alone never make a result deliverable to the game. */
  async ownedValidatedAsset(userId: string, id: string): Promise<{ key: string; sha256: string }> {
    const result = await this.db.withConnection((c) =>
      c.query<{ asset_key: string; asset_sha256: string }>(
        `SELECT asset_key,asset_sha256 FROM likeness_jobs
      WHERE id=$1 AND user_id=$2 AND status='succeeded' AND phase='completed'
      AND asset_key IS NOT NULL AND asset_sha256 IS NOT NULL AND artifact_cleanup_at IS NULL`,
        [id, userId],
      ),
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError({ kind: 'validated_likeness_asset' });
    return { key: row.asset_key, sha256: row.asset_sha256 };
  }

  async cancel(
    userId: string,
    id: string,
    now: Date,
    receipt?: LikenessActionReceipt,
  ): Promise<void> {
    await runInTransaction(
      async (c) => {
        const owned = await c.query(
          'SELECT id FROM likeness_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [id, userId],
        );
        if (!owned.rowCount) throw new NotFoundError({ kind: 'likeness_job' });
        if (await recordLikenessAction(c, userId, receipt, now)) return;
        await c.query(
          `UPDATE likeness_jobs SET status='cancelled',phase='cancelled',updated_at=$3,
        failure_reason='user_cancelled' WHERE id=$1 AND user_id=$2`,
          [id, userId, now],
        );
      },
      {},
      this.db,
    );
  }

  /** Cancel expired work; private artifact cleanup remains possible with provider disabled. */
  async cleanupCandidates(
    now: Date,
  ): Promise<Array<{ id: string; reference_key: string | null; asset_key: string | null }>> {
    await this.db.withConnection((c) =>
      c.query(
        `UPDATE likeness_jobs SET status='cancelled',phase='cancelled',
      failure_reason='generation_retention_expired',updated_at=$1 WHERE deadline_at<=$1 AND status IN ('queued','processing')`,
        [now],
      ),
    );
    const result = await this.db.withConnection((c) =>
      c.query<{ id: string; reference_key: string | null; asset_key: string | null }>(
        `SELECT id,reference_key,asset_key FROM likeness_jobs
      WHERE status IN ('failed','cancelled') AND (artifact_cleanup_at IS NULL OR artifact_cleanup_at<=$1::timestamptz-interval '5 minutes') AND (lease_until IS NULL OR lease_until<=$1)
      ORDER BY artifact_cleanup_at NULLS FIRST,updated_at LIMIT 50`,
        [now],
      ),
    );
    return result.rows;
  }
  async artifactsDeleted(id: string, now: Date): Promise<void> {
    await this.db.withConnection((c) =>
      c.query(
        `UPDATE likeness_jobs SET artifact_cleanup_at=$2,
      provider_face_token=NULL,provider_character_token=NULL,approved_reference_token=NULL
      WHERE id=$1 AND status IN ('failed','cancelled')`,
        [id, now],
      ),
    );
  }
}
