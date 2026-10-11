/** Real HTTP provider protocol, disk storage, Sharp and isolated Postgres; synthetic inputs only.
 * The shared lifecycle fixture justifies exceeding the 300-line soft limit for failure/race coverage. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { likenessFixture, ownPhotoConsent } from './likeness-test-fixture.js';
import { LikenessPhotoRepository } from '../shared/db/likeness-photos.js';
import { LikenessPhotoService } from './likeness-photos.js';
import { LikenessPipelineRepository } from '../shared/db/likeness-pipeline.js';
import { LikenessGenerationWorker } from './likeness-worker.js';
import { LikenessJobActions } from './likeness-actions.js';
import { LikenessService } from './likeness.js';
import { LikenessRepository } from '../shared/db/likeness.js';
import { TripoAdapter } from '../shared/infra/tripo.js';
import { LikenessArtifactReader } from '../shared/infra/likeness-artifacts.js';
import { createRiggedGlbFixture } from '../shared/infra/likeness-fixture.test-helper.js';
let f: Awaited<ReturnType<typeof likenessFixture>>, server: Server, base: string;
let repo: LikenessPipelineRepository,
  worker: LikenessGenerationWorker,
  actions: LikenessJobActions,
  photos: LikenessPhotoService,
  now: Date;
let tasks: Array<{ id: string; body: Record<string, unknown> }>,
  uploads: number,
  polls: number,
  submitLost: boolean,
  pollUnavailable: boolean,
  rigType: string,
  taskStatus: string;
let onSubmit: (() => Promise<void>) | undefined;
const configuration = {
  apiKey: 'fixture-not-a-real-key',
  endUserAgreementConfirmed: true,
  timeoutMs: 1000,
};
beforeAll(async () => {
  f = await likenessFixture();
  repo = new LikenessPipelineRepository(f.db);
  server = createServer(async (req, res) => {
    if (req.url === '/reference.jpg') {
      res.writeHead(200, { 'content-type': 'image/png' }).end(f.image);
      return;
    }
    if (req.url === '/avatar.glb') {
      res.writeHead(200, { 'content-type': 'model/gltf-binary' }).end(createRiggedGlbFixture());
      return;
    }
    if (req.headers.authorization !== 'Bearer fixture-not-a-real-key') {
      res.writeHead(401).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === '/upload') {
      uploads++;
      res.end(JSON.stringify({ code: 0, data: { image_token: `token-${uploads}` } }));
      return;
    }
    if (req.url === '/task' && req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
        id = `task-${tasks.length + 1}`;
      tasks.push({ id, body });
      if (onSubmit) await onSubmit();
      if (submitLost) {
        res.destroy();
        return;
      }
      res.end(JSON.stringify({ code: 0, data: { task_id: id } }));
      return;
    }
    if (req.url?.startsWith('/task/')) {
      polls++;
      if (pollUnavailable) {
        res.writeHead(503).end();
        return;
      }
      const id = req.url.slice('/task/'.length),
        task = tasks.find((t) => t.id === id);
      const output =
        task?.body.type === 'generate_image'
          ? { generated_image: `${base}/reference.jpg` }
          : task?.body.type === 'animate_prerigcheck'
            ? { riggable: true, rig_type: rigType }
            : task?.body.type === 'animate_rig'
              ? { model: `${base}/avatar.glb` }
              : {};
      res.end(
        JSON.stringify({
          code: 0,
          data: {
            task_id: id,
            status: taskStatus,
            consumed_credit: task?.body.type === 'animate_prerigcheck' ? 0 : 1,
            output,
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  worker = new LikenessGenerationWorker(
    repo,
    f.storage,
    { load: async () => ({ bytes: f.image, contentType: 'image/png', revision: 'fixture-1' }) },
    new TripoAdapter(configuration, base),
    new LikenessArtifactReader(['127.0.0.1']),
    true,
    () => now,
  );
  actions = new LikenessJobActions(repo, f.storage, () => now);
  photos = new LikenessPhotoService(new LikenessPhotoRepository(f.db), f.storage, true, () => now);
});
beforeEach(async () => {
  await f.clear();
  now = new Date();
  tasks = [];
  uploads = 0;
  polls = 0;
  submitLost = false;
  pollUnavailable = false;
  rigType = 'biped';
  taskStatus = 'success';
  onSubmit = undefined;
});
afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await f?.close();
});
async function job() {
  const userId = await f.user(),
    photo = await photos.ingest(userId, randomUUID(), 'image/png', f.image, ownPhotoConsent);
  const jobs = new LikenessService(
    new LikenessRepository(f.db),
    { enabled: true, provider: 'tripo', models: { head_snow: 'human' } },
    () => now,
  );
  const created = await jobs.create(userId, randomUUID(), {
    modelId: 'head_snow',
    uploadId: photo.uploadId,
    entitlementId: await f.entitlement(userId, now),
    consent: ownPhotoConsent,
  });
  await f.pool.query('UPDATE likeness_jobs SET next_run_at=$2,deadline_at=$3 WHERE id=$1', [
    created.id,
    now,
    new Date(now.getTime() + 86400_000),
  ]);
  return { userId, id: created.id, photoId: photo.uploadId };
}
async function state(id: string) {
  return (await f.pool.query('SELECT * FROM likeness_jobs WHERE id=$1', [id])).rows[0];
}
async function preview() {
  const j = await job();
  for (let i = 0; i < 3; i++) expect(await worker.tick()).toBe(true);
  expect((await state(j.id)).phase).toBe('awaiting_reference_approval');
  return j;
}

describe('durable likeness generation pipeline', () => {
  it('conditions selected reference, waits for owner approval, then creates and structurally checks a rig without claiming playable completion', async () => {
    const j = await preview(),
      other = await f.user(),
      row = await state(j.id);
    expect(tasks.map((t) => t.body.type)).toEqual(['generate_image']);
    expect(uploads).toBe(2);
    expect(await worker.tick()).toBe(false);
    await expect(actions.reference(other, j.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(
      actions.approve(other, j.id, { referenceSha256: row.reference_sha256 }, randomUUID()),
    ).rejects.toMatchObject({ httpStatus: 404 });
    await expect(
      actions.approve(j.userId, j.id, { referenceSha256: 'b'.repeat(64) }, randomUUID()),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect((await actions.reference(j.userId, j.id)).sha256).toBe(row.reference_sha256);
    await actions.approve(j.userId, j.id, { referenceSha256: row.reference_sha256 }, randomUUID());
    await actions.approve(j.userId, j.id, { referenceSha256: row.reference_sha256 }, randomUUID());
    for (let i = 0; i < 7; i++) expect(await worker.tick()).toBe(true);
    const result = await state(j.id);
    expect(result).toMatchObject({
      status: 'processing',
      phase: 'awaiting_asset_validation',
      reference_revision: 'fixture-1',
    });
    expect(result.asset_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await worker.tick()).toBe(false);
    expect(tasks.map((t) => t.body.type)).toEqual([
      'generate_image',
      'image_to_model',
      'animate_prerigcheck',
      'animate_rig',
    ]);
    expect(tasks[1]?.body.file).toEqual({ type: 'jpeg', file_token: 'token-3' });
    // A structurally valid downloaded file still needs Unity/skeleton/material QA.
    await expect(actions.result(j.userId, j.id)).rejects.toMatchObject({ httpStatus: 404 });
    expect(
      (
        await f.pool.query(
          "SELECT count(*) FROM likeness_provider_attempts WHERE state='succeeded'",
        )
      ).rows[0].count,
    ).toBe('4');
  });
  it('two workers cannot reserve or submit the same paid stage twice', async () => {
    const j = await job();
    await worker.tick();
    await Promise.all([worker.tick(), worker.tick()]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.body.type).toBe('generate_image');
    expect(['reference_polling', 'awaiting_reference_approval']).toContain(
      (await state(j.id)).phase,
    );
  });
  it('holds ambiguous paid POST without retrying after response loss', async () => {
    const j = await job();
    await worker.tick();
    submitLost = true;
    await worker.tick();
    expect(await state(j.id)).toMatchObject({
      phase: 'reconciliation_required',
      failure_reason: 'provider_submission_unknown',
    });
    now = new Date(now.getTime() + 120_000);
    for (let i = 0; i < 5; i++) expect(await worker.tick()).toBe(false);
    expect(tasks).toHaveLength(1);
    expect((await repo.attempt(j.id, 'reference'))?.state).toBe('ambiguous');
  });
  it('holds a crashed submitting lease rather than assuming the provider never received it', async () => {
    const j = await job();
    await worker.tick();
    const claim = await repo.claim(now);
    expect(claim).not.toBeNull();
    await repo.reserveAttempt(claim!, 'reference', now);
    now = new Date(now.getTime() + 121_000);
    await worker.tick();
    expect((await state(j.id)).phase).toBe('reconciliation_required');
    expect(tasks).toHaveLength(0);
  });
  it('persists a returned provider task ID even when cancellation races its response', async () => {
    const j = await job();
    await worker.tick();
    onSubmit = () => actions.cancel(j.userId, j.id, randomUUID());
    await worker.tick();
    expect((await state(j.id)).status).toBe('cancelled');
    expect((await repo.attempt(j.id, 'reference'))?.provider_task_id).toBe('task-1');
    expect(await worker.tick()).toBe(false);
    expect(tasks).toHaveLength(1);
  });
  it('retries bounded read-only polling but never re-submits the paid job', async () => {
    const j = await job();
    await worker.tick();
    await worker.tick();
    pollUnavailable = true;
    for (let i = 0; i < 3; i++) {
      await worker.tick();
      now = new Date(now.getTime() + 31_000);
    }
    expect((await state(j.id)).phase).toBe('reconciliation_required');
    expect(polls).toBe(3);
    expect(tasks).toHaveLength(1);
    expect(await worker.tick()).toBe(false);
  });
  it('copies the same completed artifact safely after a crash before DB acknowledgement', async () => {
    const j = await preview(),
      row = await state(j.id);
    // The durable object exists, but the persisted phase represents lost acknowledgement.
    await f.pool.query(
      "UPDATE likeness_jobs SET phase='reference_polling',reference_sha256=NULL,next_run_at=$2 WHERE id=$1",
      [j.id, now],
    );
    await worker.tick();
    expect((await state(j.id)).reference_sha256).toBe(row.reference_sha256);
    expect(tasks).toHaveLength(1);
  });
  it('does not pay to rig an incompatible generated skeleton', async () => {
    const j = await preview();
    await actions.approve(
      j.userId,
      j.id,
      {
        referenceSha256: (await state(j.id)).reference_sha256,
      },
      randomUUID(),
    );
    rigType = 'aquatic';
    for (let i = 0; i < 5; i++) await worker.tick();
    expect(await state(j.id)).toMatchObject({
      status: 'failed',
      failure_reason: 'generated_model_not_biped_riggable',
    });
    expect(tasks.map((t) => t.body.type)).toEqual([
      'generate_image',
      'image_to_model',
      'animate_prerigcheck',
    ]);
  });
  it('photo withdrawal blocks every subsequent provider stage and removes copied private artifacts', async () => {
    const j = await preview(),
      row = await state(j.id);
    await photos.remove(j.userId, j.photoId);
    await expect(actions.reference(j.userId, j.id)).rejects.toMatchObject({ httpStatus: 404 });
    expect(await worker.tick()).toBe(false);
    expect(tasks).toHaveLength(1);
    expect(await worker.cleanup()).toBe(1);
    await expect(f.storage.get(row.reference_key)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await state(j.id)).provider_face_token).toBeNull();
  });
  it('does not touch the queue or provider while disabled', async () => {
    const j = await job();
    const off = new LikenessGenerationWorker(
      repo,
      f.storage,
      {
        load: async () => {
          throw new Error('must not load');
        },
      },
      new TripoAdapter(configuration, base),
      new LikenessArtifactReader(['127.0.0.1']),
    );
    expect(await off.tick()).toBe(false);
    expect((await state(j.id)).status).toBe('queued');
    expect(uploads).toBe(0);
    expect(tasks).toHaveLength(0);
  });
  it('a provider terminal failure never retries generation', async () => {
    const j = await job();
    await worker.tick();
    await worker.tick();
    taskStatus = 'banned';
    await worker.tick();
    expect((await state(j.id)).failure_reason).toBe('provider_banned');
    expect(await worker.tick()).toBe(false);
    expect(tasks).toHaveLength(1);
  });
  it('durably replays an action key and rejects using it for a different action', async () => {
    const j = await preview(),
      key = randomUUID(),
      body = { referenceSha256: (await state(j.id)).reference_sha256 };
    await actions.approve(j.userId, j.id, body, key);
    await actions.approve(j.userId, j.id, body, key);
    await expect(actions.cancel(j.userId, j.id, key)).rejects.toMatchObject({
      details: { reason: 'idempotency_body_mismatch' },
    });
    expect((await state(j.id)).phase).toBe('mesh_ready');
    await actions.cancel(j.userId, j.id, randomUUID());
    // A replay acknowledges the already recorded approval, without resuming cancelled work.
    await actions.approve(j.userId, j.id, body, key);
    expect((await state(j.id)).status).toBe('cancelled');
  });
  it('returns final bytes only to the owner after a separate trusted runtime acceptance', async () => {
    const j = await preview();
    await actions.approve(
      j.userId,
      j.id,
      { referenceSha256: (await state(j.id)).reference_sha256 },
      randomUUID(),
    );
    for (let i = 0; i < 7; i++) await worker.tick();
    await expect(actions.result(j.userId, j.id)).rejects.toMatchObject({ httpStatus: 404 });
    // Fixture represents a future trusted Unity QA acceptance, not a public completion endpoint.
    await f.pool.query(
      "UPDATE likeness_jobs SET status='succeeded',phase='completed' WHERE id=$1",
      [j.id],
    );
    await expect(actions.result(await f.user(), j.id)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await actions.result(j.userId, j.id)).bytes).toEqual(createRiggedGlbFixture());
  });
  it('retains artifact deletion tombstones after a late private write', async () => {
    const j = await preview(),
      row = await state(j.id),
      bytes = (await actions.reference(j.userId, j.id)).bytes;
    await actions.cancel(j.userId, j.id, randomUUID());
    expect(await worker.cleanup()).toBe(1);
    // A timed-out object-store PUT may complete after the initial DELETE acknowledgement.
    await f.storage.put(row.reference_key, bytes);
    expect(await worker.cleanup()).toBe(0);
    now = new Date(now.getTime() + 300_001);
    expect(await worker.cleanup()).toBe(1);
    await expect(f.storage.get(row.reference_key)).rejects.toMatchObject({ httpStatus: 404 });
  });
  it.each(['sources', 'mesh_ready'])(
    'rechecks withdrawal after a delayed real private read in %s',
    async (phase) => {
      const j = phase === 'sources' ? await job() : await preview();
      if (phase === 'mesh_ready')
        await actions.approve(
          j.userId,
          j.id,
          { referenceSha256: (await state(j.id)).reference_sha256 },
          randomUUID(),
        );
      const priorUploads = uploads;
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        reading = new Promise<void>((resolve) => {
          started = resolve;
        });
      // Delay completion of a real disk read; all bytes/storage and provider HTTP remain real.
      const storage = {
        put: f.storage.put.bind(f.storage),
        delete: f.storage.delete.bind(f.storage),
        get: async (key: string, max?: number) => {
          const bytes = await f.storage.get(key, max);
          started();
          await gate;
          return bytes;
        },
      };
      const delayed = new LikenessGenerationWorker(
        repo,
        storage,
        { load: async () => ({ bytes: f.image, contentType: 'image/png', revision: 'fixture-1' }) },
        new TripoAdapter(configuration, base),
        new LikenessArtifactReader(['127.0.0.1']),
        true,
        () => now,
      );
      const pending = delayed.tick();
      await reading;
      await photos.remove(j.userId, j.photoId);
      release();
      await pending;
      expect(uploads).toBe(priorUploads);
      expect((await state(j.id)).status).toBe('cancelled');
    },
  );
});
