/** Durable one-purchase/one-job journal, isolated from game-cash payments. */
import type { Db } from './pool.js';
import { runInTransaction } from './uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../domain/errors.js';
import {
  LIKENESS_PRODUCT,
  type LikenessInput,
  type LikenessJob,
  type LikenessMode,
} from '../domain/likeness.js';

interface JobRow {
  payment_source?: string;
  id: string;
  model_id: string;
  mode: LikenessMode;
  status: LikenessJob['status'];
  request_hash: string;
  phase?: string;
  reference_sha256?: string | null;
  failure_reason?: string | null;
  created_at: Date;
  updated_at: Date;
}

interface CreateJobArgs {
  userId: string;
  id: string;
  key: string;
  hash: string;
  input: LikenessInput;
  mode: LikenessMode;
  provider: string;
  now: Date;
}

function publicJob(row: JobRow): LikenessJob {
  return {
    source:
      row.payment_source === 'operator_evaluation' ? 'operator_evaluation' : 'verified_purchase',
    id: row.id,
    modelId: row.model_id,
    mode: row.mode,
    status: row.status,
    phase: row.phase ?? 'sources',
    referenceSha256: row.reference_sha256 ?? null,
    failureReason: row.failure_reason ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class LikenessRepository {
  constructor(private readonly db: Db) {}

  async get(userId: string, id: string): Promise<LikenessJob> {
    const result = await this.db.withConnection((c) =>
      c.query<JobRow>(
        'SELECT j.*,e.payment_source FROM likeness_jobs j JOIN likeness_entitlements e ON e.id=j.entitlement_id WHERE j.id = $1 AND j.user_id = $2',
        [id, userId],
      ),
    );
    if (!result.rows[0]) throw new NotFoundError({ kind: 'likeness_job' });
    return publicJob(result.rows[0]);
  }

  async create(args: CreateJobArgs): Promise<LikenessJob> {
    try {
      return await this.createOnce(args);
    } catch (error) {
      const pg = error as { code?: string; constraint?: string };
      // SERIALIZABLE can report a uniqueness race instead of 40001. One fresh
      // transaction reads the winner and returns its durable replay/used result.
      if (
        pg.code !== '23505' ||
        !['likeness_jobs_user_id_idempotency_key_key', 'likeness_jobs_entitlement_id_key'].includes(
          pg.constraint ?? '',
        )
      )
        throw error;
      return this.createOnce(args);
    }
  }

  private async createOnce(args: CreateJobArgs): Promise<LikenessJob> {
    return runInTransaction(
      async (c) => {
        // Serialize this owner's submissions before checking durable replay and
        // entitlement consumption. A lost HTTP response does not buy another job.
        const owner = await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [args.userId]);
        if (!owner.rowCount) throw new NotFoundError({ kind: 'user' });
        const existing = await c.query<JobRow>(
          'SELECT j.*,e.payment_source FROM likeness_jobs j JOIN likeness_entitlements e ON e.id=j.entitlement_id WHERE j.user_id = $1 AND j.idempotency_key = $2',
          [args.userId, args.key],
        );
        if (existing.rows[0]) {
          if (existing.rows[0].request_hash !== args.hash) {
            throw new ValidationFailedError({ reason: 'idempotency_body_mismatch' });
          }
          return publicJob(existing.rows[0]);
        }
        const entitlement = await c.query<{ id: string; payment_source: string }>(
          `SELECT id,payment_source FROM likeness_entitlements WHERE id = $1 AND user_id = $2
         AND product_id = $3 AND revoked_at IS NULL AND verified_at <= $4 FOR UPDATE`,
          [args.input.entitlementId, args.userId, LIKENESS_PRODUCT, args.now],
        );
        if (!entitlement.rowCount)
          throw new ForbiddenError({ reason: 'verified_likeness_purchase_required' });
        const consumed = await c.query('SELECT id FROM likeness_jobs WHERE entitlement_id = $1', [
          args.input.entitlementId,
        ]);
        if (consumed.rowCount)
          throw new ForbiddenError({ reason: 'likeness_purchase_already_used' });
        const upload = await c.query(
          `SELECT id FROM likeness_uploads WHERE id = $1 AND user_id = $2
         AND deleted_at IS NULL AND verified_at <= $3 AND expires_at > $3 FOR UPDATE`,
          [args.input.uploadId, args.userId, args.now],
        );
        if (!upload.rowCount) throw new NotFoundError({ kind: 'verified_likeness_upload' });
        const result = await c.query<JobRow>(
          `INSERT INTO likeness_jobs (id, user_id, idempotency_key, request_hash, entitlement_id,
         upload_id, model_id, mode, provider, consent_version, consent_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$11) RETURNING *`,
          [
            args.id,
            args.userId,
            args.key,
            args.hash,
            args.input.entitlementId,
            args.input.uploadId,
            args.input.modelId,
            args.mode,
            args.provider,
            args.input.consent.version,
            args.now,
          ],
        );
        return publicJob({
          ...result.rows[0]!,
          payment_source: entitlement.rows[0]!.payment_source,
        });
      },
      {},
      this.db,
    );
  }
}
