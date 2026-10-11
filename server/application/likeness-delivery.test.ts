/** Real isolated Postgres delivery ownership, receipts and validation races. */
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { likenessFixture, ownPhotoConsent } from './likeness-test-fixture.js';
import { LikenessPhotoService } from './likeness-photos.js';
import { LikenessPhotoRepository } from '../shared/db/likeness-photos.js';
import { LikenessService } from './likeness.js';
import { LikenessRepository } from '../shared/db/likeness.js';
import { LikenessDeliveryRepository } from '../shared/db/likeness-delivery.js';
import { LikenessPipelineRepository } from '../shared/db/likeness-pipeline.js';
import { likenessActionReceipt } from './likeness-actions.js';
import type { LikenessAssetManifest } from '../shared/domain/likeness.js';
let f: Awaited<ReturnType<typeof likenessFixture>>, delivery: LikenessDeliveryRepository;
beforeAll(async () => {
  f = await likenessFixture();
  delivery = new LikenessDeliveryRepository(f.db);
});
beforeEach(async () => f.clear());
afterAll(async () => f.close());
async function fixture() {
  const owner = await f.user(),
    other = await f.user(),
    now = new Date(),
    entitlement = await f.entitlement(owner, now);
  const photo = await new LikenessPhotoService(
    new LikenessPhotoRepository(f.db),
    f.storage,
    true,
  ).ingest(owner, randomUUID(), 'image/png', f.image, ownPhotoConsent);
  const job = await new LikenessService(new LikenessRepository(f.db), {
    enabled: true,
    provider: 'fixture',
    models: { head_snow: 'human' },
  }).create(owner, randomUUID(), {
    modelId: 'head_snow',
    uploadId: photo.uploadId,
    entitlementId: entitlement,
    consent: ownPhotoConsent,
  });
  const hash = 'a'.repeat(64);
  const manifest: LikenessAssetManifest = {
    jobId: job.id,
    modelId: 'head_snow',
    sha256: hash,
    bytes: 100,
    triangles: 1,
    joints: 23,
    humanoidBones: { Hips: 'mixamorig:Hips' },
    heightMeters: 1.75,
    validatorVersion: 'fixture',
  };
  await f.pool.query(
    "UPDATE likeness_jobs SET status='processing',phase='awaiting_asset_validation',asset_sha256=$2,asset_key=$3 WHERE id=$1",
    [job.id, hash, `${randomUUID()}.glb`],
  );
  return { owner, other, job, manifest, hash, now, entitlement, photo };
}
describe('private likeness delivery', () => {
  it('resumes only owned jobs and never returns raw private storage keys', async () => {
    const x = await fixture();
    expect((await delivery.list(x.owner)).jobs.map((j) => j.id)).toEqual([x.job.id]);
    expect((await delivery.list(x.other)).jobs).toEqual([]);
    expect(JSON.stringify(await delivery.list(x.owner))).not.toContain('asset_key');
  });
  it('preview is separate from accepted playable result and owner protected', async () => {
    const x = await fixture();
    expect((await delivery.preview(x.owner, x.job.id)).sha256).toBe(x.hash);
    await expect(delivery.preview(x.other, x.job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(delivery.manifest(x.owner, x.job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      delivery.accept(x.owner, x.job.id, likenessActionReceipt(randomUUID(), 'accept'), x.now),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('validates the hash once, accepts idempotently, and persists across repository instances', async () => {
    const x = await fixture();
    expect(await delivery.validated(x.job.id, x.hash, x.manifest, x.now)).toBe(true);
    const receipt = likenessActionReceipt(randomUUID(), 'accept');
    expect(await delivery.accept(x.owner, x.job.id, receipt, x.now)).toEqual(x.manifest);
    expect(await delivery.accept(x.owner, x.job.id, receipt, x.now)).toEqual(x.manifest);
    expect((await new LikenessDeliveryRepository(f.db).list(x.owner)).acceptedJobId).toBe(x.job.id);
    await expect(delivery.manifest(x.other, x.job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(delivery.accept(x.other, x.job.id, receipt, x.now)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
  it('does not validate cancelled jobs or mismatched artifacts', async () => {
    const x = await fixture();
    expect(
      await delivery.validated(
        x.job.id,
        'b'.repeat(64),
        { ...x.manifest, sha256: 'b'.repeat(64) },
        x.now,
      ),
    ).toBe(false);
    await expect(
      delivery.validated(x.job.id, x.hash, { ...x.manifest, jobId: randomUUID() }, x.now),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await new LikenessPipelineRepository(f.db).cancel(x.owner, x.job.id, x.now);
    expect(await delivery.validated(x.job.id, x.hash, x.manifest, x.now)).toBe(false);
  });
  it('withdrawal or entitlement revocation wins over pending validation', async () => {
    const x = await fixture();
    await f.pool.query('UPDATE likeness_entitlements SET revoked_at=now() WHERE id=$1', [
      x.entitlement,
    ]);
    expect(await delivery.validated(x.job.id, x.hash, x.manifest, x.now)).toBe(false);
    await f.pool.query('UPDATE likeness_entitlements SET revoked_at=NULL WHERE id=$1', [
      x.entitlement,
    ]);
    await f.pool.query('UPDATE likeness_uploads SET deleted_at=now() WHERE id=$1', [
      x.photo.uploadId,
    ]);
    expect(await delivery.validated(x.job.id, x.hash, x.manifest, x.now)).toBe(false);
  });
  it('cancelled accepted selections no longer resume', async () => {
    const x = await fixture();
    await delivery.validated(x.job.id, x.hash, x.manifest, x.now);
    await delivery.accept(x.owner, x.job.id, likenessActionReceipt(randomUUID(), 'accept'), x.now);
    await new LikenessPipelineRepository(f.db).cancel(x.owner, x.job.id, x.now);
    expect(
      (
        await f.pool.query('SELECT fulfillment_status FROM likeness_entitlements WHERE id=$1', [
          x.entitlement,
        ])
      ).rows[0].fulfillment_status,
    ).toBe('delivered');
    expect((await delivery.list(x.owner)).acceptedJobId).toBeNull();
    await expect(delivery.manifest(x.owner, x.job.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('discovers only unused, verified, unrevoked owned entitlements', async () => {
    const x = await fixture();
    expect(await delivery.entitlement(x.owner)).toBeNull();
    const id = await f.entitlement(x.owner, x.now);
    expect(await delivery.entitlement(x.owner)).toEqual({ id, source: 'verified_purchase' });
    expect(await delivery.entitlement(x.other)).toBeNull();
    await f.pool.query('UPDATE likeness_entitlements SET revoked_at=now() WHERE id=$1', [id]);
    expect(await delivery.entitlement(x.owner)).toBeNull();
  });
  it('owner-restricted worker cannot claim another account job', async () => {
    const x = await fixture();
    await f.pool.query("UPDATE likeness_jobs SET phase='sources' WHERE id=$1", [x.job.id]);
    expect(await new LikenessPipelineRepository(f.db, [x.other]).claim(new Date())).toBeNull();
    expect((await new LikenessPipelineRepository(f.db, [x.owner]).claim(new Date()))?.id).toBe(
      x.job.id,
    );
  });
  it('reserves a provider stage only within its owned entitlement credit ceiling', async () => {
    const x = await fixture();
    await f.pool.query("UPDATE likeness_jobs SET phase='reference_ready' WHERE id=$1", [x.job.id]);
    await f.pool.query('UPDATE likeness_entitlements SET credit_budget=9 WHERE id=$1', [
      x.entitlement,
    ]);
    const repo = new LikenessPipelineRepository(f.db),
      job = await repo.claim(new Date());
    await expect(repo.reserveAttempt(job!, 'reference', new Date())).rejects.toMatchObject({
      details: { reason: 'likeness_credit_budget_exhausted' },
    });
    expect((await f.pool.query('SELECT * FROM likeness_provider_attempts')).rowCount).toBe(0);
  });
});
