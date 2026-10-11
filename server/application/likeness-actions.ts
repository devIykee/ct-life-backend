/** Owner actions remain usable when new generation is unavailable. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { LikenessUnavailableError } from '../shared/domain/likeness.js';
import type { LikenessPipelineRepository } from '../shared/db/likeness-pipeline.js';
import type { PrivateLikenessStorage } from '../shared/infra/likeness-storage.js';
const Approval = z.strictObject({ referenceSha256: z.string().regex(/^[0-9a-f]{64}$/) });
export class LikenessJobActions {
  /** Inject owned-job persistence and optional private storage; generation availability is separate. */
  constructor(
    private readonly repository: LikenessPipelineRepository,
    private readonly storage?: PrivateLikenessStorage,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private id(value: string): void {
    if (!z.uuid().safeParse(value).success)
      throw new ValidationFailedError({ reason: 'invalid_likeness_job_id' });
  }
  /** Approve the exact private preview using a durable operation receipt. */
  async approve(userId: string, id: string, body: unknown, key: unknown): Promise<void> {
    this.id(id);
    const input = Approval.safeParse(body);
    if (!input.success) throw new ValidationFailedError({ reason: 'invalid_reference_approval' });
    await this.repository.approveReference(
      userId,
      id,
      input.data.referenceSha256,
      this.now(),
      likenessActionReceipt(key, `approve/${id}/${input.data.referenceSha256}`),
    );
  }
  /** Stop future stages without erasing provider reconciliation records. */
  async cancel(userId: string, id: string, key: unknown): Promise<void> {
    this.id(id);
    await this.repository.cancel(
      userId,
      id,
      this.now(),
      likenessActionReceipt(key, `cancel/${id}`),
    );
  }
  /** Read the owned, unexpired normalized preview. */
  async reference(userId: string, id: string) {
    this.id(id);
    const reference = await this.repository.ownedReference(userId, id, this.now());
    if (!this.storage) throw new LikenessUnavailableError();
    return { bytes: await this.storage.get(reference.key), sha256: reference.sha256 };
  }
  /** Deliver only a separately validated completed result to its owner. */
  async result(userId: string, id: string) {
    this.id(id);
    const result = await this.repository.ownedValidatedAsset(userId, id);
    if (!this.storage) throw new LikenessUnavailableError();
    return { bytes: await this.storage.get(result.key, 32 * 1024 * 1024), sha256: result.sha256 };
  }
}

/** Include the operation and resource, so a key cannot silently replay a different action. */
export function likenessActionReceipt(key: unknown, payload: string) {
  if (typeof key !== 'string' || !z.uuid().safeParse(key).success)
    throw new ValidationFailedError({ reason: 'idempotency_key_must_be_uuid' });
  return { key, hash: createHash('sha256').update(payload).digest('hex') };
}
