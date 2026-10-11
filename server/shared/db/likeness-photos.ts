/** Durable ownership and cleanup journal for normalized private photos. */
import { randomUUID } from 'node:crypto';
import { recordLikenessAction, type LikenessActionReceipt } from './likeness-receipts.js';
import type { Db } from './pool.js';
import { runInTransaction } from './uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../domain/errors.js';

export interface PrivatePhotoSession {
  id: string;
  user_id: string;
  request_hash: string;
  object_key: string;
  state: 'processing' | 'ready' | 'failed' | 'deleting' | 'deleted';
  expires_at: Date;
  lease_token: string;
  lease_until: Date;
}
type Reservation = {
  id: string;
  userId: string;
  key: string;
  hash: string;
  objectKey: string;
  consentVersion: string;
  now: Date;
  expiresAt: Date;
};
export class LikenessPhotoRepository {
  constructor(private readonly db: Db) {}

  async reserve(input: Reservation): Promise<{ session: PrivatePhotoSession; acquired: boolean }> {
    // Unique indexes arbitrate concurrent fresh snapshots; resolve a loser once
    // in a new transaction so it sees the durable winning request.
    try {
      return await this.reserveOnce(input);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return this.reserveOnce(input);
      throw error;
    }
  }
  private async reserveOnce(
    input: Reservation,
  ): Promise<{ session: PrivatePhotoSession; acquired: boolean }> {
    return runInTransaction(
      async (c) => {
        const owner = await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.userId]);
        if (!owner.rowCount) throw new NotFoundError({ kind: 'user' });
        const existing = await c.query<PrivatePhotoSession>(
          'SELECT * FROM likeness_upload_sessions WHERE user_id=$1 AND request_key=$2 FOR UPDATE',
          [input.userId, input.key],
        );
        const session = existing.rows[0];
        const token = randomUUID(),
          leaseUntil = new Date(input.now.getTime() + 90_000);
        if (session) {
          if (session.request_hash !== input.hash)
            throw new ValidationFailedError({ reason: 'idempotency_body_mismatch' });
          if (
            session.state === 'processing' &&
            session.lease_until <= input.now &&
            session.expires_at > input.now
          ) {
            const reclaimed = await c.query<PrivatePhotoSession>(
              'UPDATE likeness_upload_sessions SET lease_token=$2,lease_until=$3 WHERE id=$1 RETURNING *',
              [session.id, token, leaseUntil],
            );
            return { session: reclaimed.rows[0]!, acquired: true };
          }
          return { session, acquired: false };
        }
        const active = await c.query(
          "SELECT id FROM likeness_upload_sessions WHERE user_id=$1 AND state IN ('processing','ready')",
          [input.userId],
        );
        if (active.rowCount)
          throw new ForbiddenError({ reason: 'delete_previous_likeness_photo_first' });
        const inserted = await c.query<PrivatePhotoSession>(
          `INSERT INTO likeness_upload_sessions
        (id,user_id,request_key,request_hash,object_key,consent_version,consent_at,state,created_at,expires_at,lease_token,lease_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,'processing',$7,$8,$9,$10) RETURNING *`,
          [
            input.id,
            input.userId,
            input.key,
            input.hash,
            input.objectKey,
            input.consentVersion,
            input.now,
            input.expiresAt,
            token,
            leaseUntil,
          ],
        );
        return { session: inserted.rows[0]!, acquired: true };
      },
      {},
      this.db,
    );
  }

  async canWrite(session: PrivatePhotoSession, now: Date): Promise<boolean> {
    const result = await this.db.withConnection((c) =>
      c.query(
        `SELECT id FROM likeness_upload_sessions WHERE id=$1
      AND user_id=$2 AND state='processing' AND lease_token=$3 AND lease_until>$4 AND expires_at>$4`,
        [session.id, session.user_id, session.lease_token, now],
      ),
    );
    return !!result.rowCount;
  }

  async complete(
    session: PrivatePhotoSession,
    photo: { sha256: string; size: number },
    now: Date,
  ): Promise<void> {
    await runInTransaction(
      async (c) => {
        const result = await c.query<PrivatePhotoSession>(
          'SELECT * FROM likeness_upload_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [session.id, session.user_id],
        );
        const current = result.rows[0];
        if (current?.state === 'ready') {
          const same = await c.query(
            'SELECT id FROM likeness_uploads WHERE id=$1 AND content_sha256=$2 AND deleted_at IS NULL',
            [session.id, photo.sha256],
          );
          if (same.rowCount) return;
        }
        if (
          !current ||
          current.state !== 'processing' ||
          current.lease_token !== session.lease_token ||
          current.expires_at <= now ||
          current.lease_until <= now
        )
          throw new ForbiddenError({ reason: 'photo_upload_not_active' });
        await c.query(
          `INSERT INTO likeness_uploads(id,user_id,object_key,content_sha256,content_type,size_bytes,verified_at,expires_at)
        VALUES($1,$2,$3,$4,'image/jpeg',$5,$6,$7)`,
          [
            session.id,
            session.user_id,
            current.object_key,
            photo.sha256,
            photo.size,
            now,
            current.expires_at,
          ],
        );
        await c.query("UPDATE likeness_upload_sessions SET state='ready' WHERE id=$1", [
          session.id,
        ]);
      },
      {},
      this.db,
    );
  }

  /** Whether this attempt may remove its object after failure (never a new lease's object). */
  async failAndCanClean(session: PrivatePhotoSession): Promise<boolean> {
    return runInTransaction(
      async (c) => {
        await c.query(
          "UPDATE likeness_upload_sessions SET state='failed' WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND state='processing'",
          [session.id, session.user_id, session.lease_token],
        );
        const result = await c.query(
          "SELECT id FROM likeness_upload_sessions WHERE id=$1 AND user_id=$2 AND state IN ('failed','deleting','deleted')",
          [session.id, session.user_id],
        );
        return !!result.rowCount;
      },
      {},
      this.db,
    );
  }

  async requestDelete(
    userId: string,
    id: string,
    now: Date,
    receipt?: LikenessActionReceipt,
  ): Promise<PrivatePhotoSession> {
    return runInTransaction(
      async (c) => {
        const result = await c.query<PrivatePhotoSession>(
          'SELECT * FROM likeness_upload_sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [id, userId],
        );
        if (!result.rows[0]) throw new NotFoundError({ kind: 'likeness_upload' });
        if (await recordLikenessAction(c, userId, receipt, now)) return result.rows[0];
        await c.query(
          "UPDATE likeness_upload_sessions SET state='deleting' WHERE id=$1 AND state<>'deleted'",
          [id],
        );
        await c.query(
          'UPDATE likeness_uploads SET deleted_at=COALESCE(deleted_at,$2) WHERE id=$1',
          [id, now],
        );
        await c.query(
          "UPDATE likeness_jobs SET status='cancelled',phase='cancelled',failure_reason='photo_consent_withdrawn',updated_at=$2 WHERE upload_id=$1 AND status IN ('queued','processing')",
          [id, now],
        );
        return result.rows[0]!;
      },
      {},
      this.db,
    );
  }
  async markDeleted(id: string, now: Date): Promise<void> {
    await this.db.withConnection((c) =>
      c.query(
        "UPDATE likeness_upload_sessions SET state='deleted',cleanup_checked_at=$2 WHERE id=$1 AND state IN ('deleting','failed','deleted')",
        [id, now],
      ),
    );
  }
  async cleanupCandidates(now: Date): Promise<PrivatePhotoSession[]> {
    const result = await this.db.withConnection((c) =>
      c.query<PrivatePhotoSession>(
        "SELECT * FROM likeness_upload_sessions WHERE (state IN ('deleting','failed','deleted') OR expires_at<=$1) AND (cleanup_checked_at IS NULL OR cleanup_checked_at<=$1::timestamptz-interval '5 minutes') ORDER BY cleanup_checked_at NULLS FIRST,expires_at LIMIT 50",
        [now],
      ),
    );
    return result.rows;
  }
}
