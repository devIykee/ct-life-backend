/** Owner-only resume, entitlement discovery and accepted validated asset selection. */
import type { Db } from './pool.js';
import { runInTransaction } from './uow.js';
import { recordLikenessAction, type LikenessActionReceipt } from './likeness-receipts.js';
import { NotFoundError, ForbiddenError } from '../domain/errors.js';
import { LikenessRepository } from './likeness.js';
import type { LikenessAssetManifest } from '../domain/likeness.js';

export class LikenessDeliveryRepository {
  constructor(private readonly db: Db) {}

  async entitlement(userId: string, now = new Date()) {
    const result = await this.db.withConnection((c) =>
      c.query<{ id: string; payment_source: string }>(
        `SELECT e.id,e.payment_source FROM likeness_entitlements e
       WHERE e.user_id=$1 AND e.revoked_at IS NULL AND e.verified_at<=$2
       AND NOT EXISTS (SELECT 1 FROM likeness_jobs j WHERE j.entitlement_id=e.id)
       ORDER BY e.verified_at,e.id LIMIT 1`,
        [userId, now],
      ),
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          source:
            row.payment_source === 'operator_evaluation'
              ? 'operator_evaluation'
              : 'verified_purchase',
        }
      : null;
  }

  async list(userId: string) {
    const ids = await this.db.withConnection((c) =>
      c.query<{ id: string }>(
        'SELECT id FROM likeness_jobs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20',
        [userId],
      ),
    );
    const selection = await this.db.withConnection((c) =>
      c.query<{ job_id: string }>(
        `SELECT s.job_id FROM likeness_selections s JOIN likeness_jobs j ON j.id=s.job_id
       WHERE s.user_id=$1 AND j.user_id=$1 AND j.status='succeeded' AND j.phase='completed'
       AND j.artifact_cleanup_at IS NULL`,
        [userId],
      ),
    );
    const repository = new LikenessRepository(this.db);
    return {
      jobs: await Promise.all(ids.rows.map((row) => repository.get(userId, row.id))),
      acceptedJobId: selection.rows[0]?.job_id ?? null,
    };
  }

  async manifest(userId: string, id: string): Promise<LikenessAssetManifest> {
    const result = await this.db.withConnection((c) =>
      c.query<{ asset_manifest: LikenessAssetManifest }>(
        `SELECT asset_manifest FROM likeness_jobs WHERE id=$1 AND user_id=$2
       AND status='succeeded' AND phase='completed' AND asset_validated_at IS NOT NULL
       AND asset_manifest IS NOT NULL AND artifact_cleanup_at IS NULL`,
        [id, userId],
      ),
    );
    if (!result.rows[0]) throw new NotFoundError({ kind: 'validated_likeness_asset' });
    return result.rows[0].asset_manifest;
  }

  async preview(userId: string, id: string): Promise<{ key: string; sha256: string }> {
    const result = await this.db.withConnection((c) =>
      c.query<{ asset_key: string; asset_sha256: string }>(
        `SELECT asset_key,asset_sha256 FROM likeness_jobs WHERE id=$1 AND user_id=$2
       AND status IN ('processing','succeeded') AND asset_sha256 IS NOT NULL
       AND asset_key IS NOT NULL AND artifact_cleanup_at IS NULL`,
        [id, userId],
      ),
    );
    if (!result.rows[0]) throw new NotFoundError({ kind: 'likeness_preview' });
    return { key: result.rows[0].asset_key, sha256: result.rows[0].asset_sha256 };
  }

  async accept(
    userId: string,
    id: string,
    receipt: LikenessActionReceipt,
    now: Date,
  ): Promise<LikenessAssetManifest> {
    return runInTransaction(
      async (c) => {
        const result = await c.query<{
          status: string;
          phase: string;
          asset_manifest: LikenessAssetManifest | null;
          asset_validated_at: Date | null;
          artifact_cleanup_at: Date | null;
        }>('SELECT * FROM likeness_jobs WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, userId]);
        const row = result.rows[0];
        if (!row) throw new NotFoundError({ kind: 'likeness_job' });
        if (
          row.status !== 'succeeded' ||
          row.phase !== 'completed' ||
          !row.asset_manifest ||
          !row.asset_validated_at ||
          row.artifact_cleanup_at
        )
          throw new ForbiddenError({ reason: 'likeness_asset_not_validated' });
        if (!(await recordLikenessAction(c, userId, receipt, now)))
          await c.query(
            `INSERT INTO likeness_selections(user_id,job_id,accepted_at)VALUES($1,$2,$3)
          ON CONFLICT(user_id)DO UPDATE SET job_id=EXCLUDED.job_id,accepted_at=EXCLUDED.accepted_at`,
            [userId, id, now],
          );
        return row.asset_manifest;
      },
      {},
      this.db,
    );
  }

  /** Called only by the trusted worker validator; not exposed as a client mutation. */
  async validated(
    id: string,
    expectedHash: string,
    manifest: LikenessAssetManifest,
    now: Date,
  ): Promise<boolean> {
    if (manifest.jobId !== id || manifest.sha256 !== expectedHash)
      throw new ForbiddenError({ reason: 'likeness_manifest_mismatch' });
    const result = await this.db.withConnection((c) =>
      c.query(
        `WITH validated AS(UPDATE likeness_jobs SET status='succeeded',phase='completed',asset_manifest=$3,
       asset_validated_at=$4,updated_at=$4 WHERE id=$1 AND asset_sha256=$2
       AND phase='awaiting_asset_validation' AND status='processing' AND artifact_cleanup_at IS NULL
       AND deadline_at>$4 AND EXISTS(SELECT 1 FROM likeness_entitlements e WHERE e.id=entitlement_id AND e.revoked_at IS NULL)
       AND EXISTS(SELECT 1 FROM likeness_uploads u WHERE u.id=upload_id AND u.deleted_at IS NULL AND u.expires_at>$4)
       RETURNING entitlement_id)
       UPDATE likeness_entitlements SET fulfillment_status='delivered' WHERE id IN(SELECT entitlement_id FROM validated)`,
        [id, expectedHash, manifest, now],
      ),
    );
    return result.rowCount === 1;
  }
}
