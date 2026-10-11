import { createHash, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { likenessFixture, ownPhotoConsent } from './likeness-test-fixture.js';
import { LikenessPhotoRepository } from '../shared/db/likeness-photos.js';
import { LikenessPhotoService } from './likeness-photos.js';
import { normalizeLikenessPhoto } from '../shared/infra/likeness-image.js';
import { LikenessService } from './likeness.js';
import { LikenessRepository } from '../shared/db/likeness.js';
let f: Awaited<ReturnType<typeof likenessFixture>>;
let repo: LikenessPhotoRepository, service: LikenessPhotoService, now: Date;
beforeAll(async () => {
  f = await likenessFixture();
  repo = new LikenessPhotoRepository(f.db);
  service = new LikenessPhotoService(repo, f.storage, true, () => now);
});
beforeEach(async () => {
  await f.clear();
  now = new Date();
});
afterAll(async () => {
  await f?.close();
});

describe('private photo ingestion journal', () => {
  it('stores only normalized private JPEG and replays its original upload ID', async () => {
    const owner = await f.user(),
      key = randomUUID();
    const uploaded = await service.ingest(owner, key, 'image/png', f.image, ownPhotoConsent);
    expect(await service.ingest(owner, key, 'image/png', f.image, ownPhotoConsent)).toEqual(
      uploaded,
    );
    const rows = await f.pool.query('SELECT * FROM likeness_uploads');
    expect(rows.rowCount).toBe(1);
    const row = rows.rows[0],
      bytes = await f.storage.get(row.object_key);
    expect(row.content_type).toBe('image/jpeg');
    expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(row.content_sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(row.object_key).toBe(`${uploaded.uploadId}.jpg`);
    await expect(
      service.ingest(owner, key, 'image/jpeg', f.image, ownPhotoConsent),
    ).rejects.toMatchObject({ details: { reason: 'idempotency_body_mismatch' } });
  });
  it('accepts only one concurrent active photo per owner', async () => {
    const owner = await f.user();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.ingest(owner, randomUUID(), 'image/png', f.image, ownPhotoConsent),
      ),
    );
    expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of attempts)
      if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ httpStatus: 403 });
    expect((await f.pool.query('SELECT count(*) FROM likeness_uploads')).rows[0].count).toBe('1');
  });
  it('recovers the same request after crash between private write and DB completion', async () => {
    const owner = await f.user(),
      key = randomUUID(),
      id = randomUUID();
    const hash = createHash('sha256')
      .update('image/png')
      .update('\0')
      .update(f.image)
      .digest('hex');
    const reserved = await repo.reserve({
      id,
      userId: owner,
      key,
      hash,
      objectKey: `${id}.jpg`,
      consentVersion: 'likeness-v1',
      now,
      expiresAt: new Date(now.getTime() + 86400_000),
    });
    const normalized = await normalizeLikenessPhoto(f.image, 'image/png');
    await f.storage.put(reserved.session.object_key, normalized.bytes);
    await expect(
      service.ingest(owner, key, 'image/png', f.image, ownPhotoConsent),
    ).rejects.toMatchObject({ code: 'IN_FLIGHT' });
    now = new Date(now.getTime() + 91_000);
    expect((await service.ingest(owner, key, 'image/png', f.image, ownPhotoConsent)).uploadId).toBe(
      id,
    );
    expect((await f.pool.query('SELECT count(*) FROM likeness_uploads')).rows[0].count).toBe('1');
  });
  it('does not let a stale upload lease delete a recovered owner photo', async () => {
    const owner = await f.user(),
      key = randomUUID(),
      id = randomUUID();
    const input = {
      id,
      userId: owner,
      key,
      hash: 'a'.repeat(64),
      objectKey: `${id}.jpg`,
      consentVersion: 'likeness-v1',
      now,
      expiresAt: new Date(now.getTime() + 86400_000),
    };
    const first = await repo.reserve(input);
    now = new Date(now.getTime() + 91_000);
    const second = await repo.reserve({ ...input, now });
    expect(second.acquired).toBe(true);
    expect(await repo.failAndCanClean(first.session)).toBe(false);
    await expect(
      repo.complete(first.session, { sha256: 'b'.repeat(64), size: 10 }, now),
    ).rejects.toMatchObject({ httpStatus: 403 });
  });
  it('requires explicit consent and refuses uploads while disabled before storing anything', async () => {
    const owner = await f.user();
    await expect(
      new LikenessPhotoService(repo, f.storage).ingest(
        owner,
        randomUUID(),
        'image/png',
        f.image,
        ownPhotoConsent,
      ),
    ).rejects.toMatchObject({ code: 'LIKENESS_UNAVAILABLE' });
    await expect(
      service.ingest(owner, randomUUID(), 'image/png', f.image, {
        ...ownPhotoConsent,
        ownPhoto: false,
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      service.ingest(
        owner,
        randomUUID(),
        'image/png',
        new Uint8Array(8 * 1024 * 1024 + 1),
        ownPhotoConsent,
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(
      (await f.pool.query('SELECT count(*) FROM likeness_upload_sessions')).rows[0].count,
    ).toBe('0');
  });
  it('invalid encoded input leaves no verified upload or retained object', async () => {
    const owner = await f.user(),
      before = await readdir(f.directory);
    await expect(
      service.ingest(
        owner,
        randomUUID(),
        'image/png',
        Buffer.from('not an image'),
        ownPhotoConsent,
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(await readdir(f.directory)).toEqual(before);
    expect((await f.pool.query('SELECT count(*) FROM likeness_uploads')).rows[0].count).toBe('0');
    expect((await f.pool.query('SELECT state FROM likeness_upload_sessions')).rows[0].state).toBe(
      'deleted',
    );
  });
  it('deleting own photo cancels pending jobs and another user cannot delete it', async () => {
    const owner = await f.user(),
      other = await f.user(),
      photo = await service.ingest(owner, randomUUID(), 'image/png', f.image, ownPhotoConsent);
    const jobs = new LikenessService(
      new LikenessRepository(f.db),
      { enabled: true, provider: 'fixture', models: { head_snow: 'human' } },
      () => now,
    );
    const job = await jobs.create(owner, randomUUID(), {
      modelId: 'head_snow',
      uploadId: photo.uploadId,
      entitlementId: await f.entitlement(owner, now),
      consent: ownPhotoConsent,
    });
    await expect(service.remove(other, photo.uploadId)).rejects.toMatchObject({ httpStatus: 404 });
    await service.remove(owner, photo.uploadId);
    await service.remove(owner, photo.uploadId);
    expect((await jobs.get(owner, job.id)).status).toBe('cancelled');
    await expect(f.storage.get(`${photo.uploadId}.jpg`)).rejects.toMatchObject({ httpStatus: 404 });
  });
  it('expires source photos through bounded cleanup even when generation is disabled', async () => {
    const owner = await f.user(),
      photo = await service.ingest(owner, randomUUID(), 'image/png', f.image, ownPhotoConsent);
    now = new Date(now.getTime() + 86400_001);
    expect(await new LikenessPhotoService(repo, f.storage, false, () => now).cleanup()).toBe(1);
    await expect(f.storage.get(`${photo.uploadId}.jpg`)).rejects.toMatchObject({ httpStatus: 404 });
  });
  it('keeps deleted-photo tombstones eligible to remove a late object-store write', async () => {
    const owner = await f.user(),
      photo = await service.ingest(owner, randomUUID(), 'image/png', f.image, ownPhotoConsent),
      key = `${photo.uploadId}.jpg`;
    const normalized = await f.storage.get(key);
    await service.remove(owner, photo.uploadId);
    await f.storage.put(key, normalized);
    expect(await service.cleanup()).toBe(0);
    now = new Date(now.getTime() + 300_001);
    expect(await service.cleanup()).toBe(1);
    await expect(f.storage.get(key)).rejects.toMatchObject({ httpStatus: 404 });
  });
});
