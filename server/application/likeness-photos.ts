/** Own-photo consent, bounded normalization, private storage and recoverable cleanup. */
import { createHash, randomUUID } from 'node:crypto';
import { likenessActionReceipt } from './likeness-actions.js';
import { z } from 'zod';
import { DomainError, ForbiddenError, ValidationFailedError } from '../shared/domain/errors.js';
import { LIKENESS_CONSENT_VERSION, LikenessUnavailableError } from '../shared/domain/likeness.js';
import { LikenessPhotoRepository } from '../shared/db/likeness-photos.js';
import {
  MAX_LIKENESS_PHOTO_INPUT_BYTES,
  normalizeLikenessPhoto,
} from '../shared/infra/likeness-image.js';
import type { PrivateLikenessStorage } from '../shared/infra/likeness-storage.js';

const Consent = z.strictObject({
  version: z.literal(LIKENESS_CONSENT_VERSION),
  ownPhoto: z.literal(true),
  shareWithProvider: z.literal(true),
});

class PhotoInFlightError extends DomainError {
  readonly code = 'IN_FLIGHT';
  constructor() {
    super('This photo upload is still being processed. Retry the same request key.');
    this.httpStatus = 409;
  }
}

export class LikenessPhotoService {
  /** Readiness must include the provider agreement and private storage/deletion configuration. */
  constructor(
    private readonly repository: LikenessPhotoRepository,
    private readonly storage: PrivateLikenessStorage,
    private readonly enabled = false,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Accept one explicit own-photo upload; original bytes never enter storage. */
  async ingest(
    userId: string,
    key: string,
    contentType: 'image/jpeg' | 'image/png',
    bytes: Uint8Array,
    consent: unknown,
  ) {
    if (!this.enabled) throw new LikenessUnavailableError();
    if (!z.uuid().safeParse(key).success || !Consent.safeParse(consent).success)
      throw new ValidationFailedError({ reason: 'invalid_photo_consent_or_request_key' });
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_LIKENESS_PHOTO_INPUT_BYTES)
      throw new ValidationFailedError({ reason: 'invalid_photo_size' });
    const now = this.now(),
      expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000),
      id = randomUUID();
    const hash = createHash('sha256').update(contentType).update('\0').update(bytes).digest('hex');
    const { session, acquired } = await this.repository.reserve({
      id,
      userId,
      key,
      hash,
      objectKey: `${id}.jpg`,
      consentVersion: LIKENESS_CONSENT_VERSION,
      now,
      expiresAt,
    });
    if (!acquired) {
      if (session.state === 'ready' && session.expires_at > now)
        return { uploadId: session.id, expiresAt: session.expires_at.toISOString() };
      if (session.state === 'processing') throw new PhotoInFlightError();
      throw new ValidationFailedError({ reason: 'photo_upload_expired_or_deleted' });
    }
    try {
      const normalized = await normalizeLikenessPhoto(bytes, contentType);
      if (!(await this.repository.canWrite(session, this.now())))
        throw new ForbiddenError({ reason: 'photo_upload_not_active' });
      try {
        await this.storage.put(session.object_key, normalized.bytes, 'image/jpeg');
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'CONFLICT') throw error;
        const previous = await this.storage.get(session.object_key);
        if (createHash('sha256').update(previous).digest('hex') !== normalized.sha256) throw error;
      }
      await this.repository.complete(
        session,
        { sha256: normalized.sha256, size: normalized.bytes.length },
        this.now(),
      );
      return { uploadId: session.id, expiresAt: session.expires_at.toISOString() };
    } catch (error) {
      if (await this.repository.failAndCanClean(session)) {
        try {
          await this.storage.delete(session.object_key);
          await this.repository.markDeleted(session.id, this.now());
        } catch {
          /* Durable failed/deleting row stays for cleanup. */
        }
      }
      throw error;
    }
  }

  /** Withdrawal blocks new provider stages before source deletion is attempted. */
  async remove(userId: string, id: string, key?: unknown): Promise<void> {
    if (!z.uuid().safeParse(id).success)
      throw new ValidationFailedError({ reason: 'invalid_likeness_upload_id' });
    const session = await this.repository.requestDelete(
      userId,
      id,
      this.now(),
      key === undefined ? undefined : likenessActionReceipt(key, `delete-photo/${id}`),
    );
    await this.storage.delete(session.object_key);
    await this.repository.markDeleted(id, this.now());
  }

  /** Resume failed deletion and expire photos without requiring an active provider. */
  async cleanup(): Promise<number> {
    const rows = await this.repository.cleanupCandidates(this.now());
    let deleted = 0;
    for (const row of rows) {
      try {
        await this.remove(row.user_id, row.id);
        deleted++;
      } catch {
        /* Leave journal row for next bounded sweep. */
      }
    }
    return deleted;
  }
}
