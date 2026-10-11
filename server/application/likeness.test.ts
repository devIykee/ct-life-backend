/** Real Postgres tests in a unique schema; never migrate or clear public data. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../shared/db/pool.js';
import { LikenessRepository } from '../shared/db/likeness.js';
import { LikenessService } from './likeness.js';
import { LikenessUnavailableError } from '../shared/domain/likeness.js';

const schema = `test_likeness_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let pool: Pool;
let repo: LikenessRepository;
let ready: LikenessService;
const now = new Date('2026-10-11T12:00:00Z');

beforeAll(async () => {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (
    !connectionString ||
    !['localhost', '127.0.0.1', '::1'].includes(new URL(connectionString).hostname)
  ) {
    throw new Error('Likeness integration tests require a local Postgres database');
  }
  admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await pool.query('CREATE TABLE users (id uuid PRIMARY KEY)');
  const migration = readFileSync(
    new URL('../../db/migrations/1700000075000_likeness_jobs.sql', import.meta.url),
    'utf8',
  );
  await pool.query(migration.split('-- Down Migration')[0]!);
  const db: Db = {
    pool,
    connect: () => pool.connect(),
    close: () => pool.end(),
    async withConnection(fn) {
      const c = await pool.connect();
      try {
        return await fn(c);
      } finally {
        c.release();
      }
    },
  };
  repo = new LikenessRepository(db);
  ready = new LikenessService(
    repo,
    {
      enabled: true,
      provider: 'integration-test',
      models: { head_snow: 'human', head_hero_gynoid: 'stylized' },
    },
    () => now,
  );
});

afterAll(async () => {
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});

async function fixture() {
  const userId = randomUUID(),
    entitlementId = randomUUID(),
    uploadId = randomUUID();
  await pool.query('INSERT INTO users (id) VALUES ($1)', [userId]);
  await pool.query(
    `INSERT INTO likeness_entitlements
    (id,user_id,product_id,payment_source,payment_reference,amount_base_units,currency,verified_at)
    VALUES ($1,$2,'likeness_3d_v1','fixture_verified',$4,'1000000','USDC',$3)`,
    [entitlementId, userId, now, `fixture-${entitlementId}`],
  );
  await pool.query(
    `INSERT INTO likeness_uploads
    (id,user_id,object_key,content_sha256,content_type,size_bytes,verified_at,expires_at)
    VALUES ($1,$2,$6,$3,'image/png',100,$4,$5)`,
    [
      uploadId,
      userId,
      'a'.repeat(64),
      now,
      new Date(now.getTime() + 60_000),
      `private/${uploadId}`,
    ],
  );
  return {
    userId,
    input: {
      modelId: 'head_snow',
      entitlementId,
      uploadId,
      consent: { version: 'likeness-v1', ownPhoto: true, shareWithProvider: true },
    },
  };
}

describe('likeness payment and ownership boundary', () => {
  it('is disabled by default and accepts no job or entitlement consumption', async () => {
    const f = await fixture(),
      service = new LikenessService(repo);
    expect(service.availability()).toMatchObject({
      enabled: false,
      photoUploadEnabled: false,
      price: null,
      reason: 'provider_not_configured',
    });
    await expect(service.create(f.userId, randomUUID(), f.input)).rejects.toBeInstanceOf(
      LikenessUnavailableError,
    );
    const count = await pool.query('SELECT count(*) FROM likeness_jobs WHERE user_id = $1', [
      f.userId,
    ]);
    expect(count.rows[0].count).toBe('0');
  });

  it('queues an owned verified purchase and records server-derived mode and consent time', async () => {
    const f = await fixture();
    const job = await ready.create(f.userId, randomUUID(), f.input);
    expect(job).toMatchObject({
      modelId: 'head_snow',
      mode: 'human',
      status: 'queued',
      createdAt: now.toISOString(),
    });
    expect(await repo.get(f.userId, job.id)).toEqual(job);
    // Disabling new generation must not hide an existing owned job.
    expect(await new LikenessService(repo).get(f.userId, job.id)).toEqual(job);
    expect(job).not.toHaveProperty('object_key');
    const row = await pool.query(
      'SELECT consent_version,consent_at FROM likeness_jobs WHERE id = $1',
      [job.id],
    );
    expect(row.rows[0].consent_version).toBe('likeness-v1');
    expect(row.rows[0].consent_at).toEqual(now);
  });

  it('replays the same job under concurrent retries without spending twice', async () => {
    const f = await fixture(),
      key = randomUUID();
    const results = await Promise.all([
      ready.create(f.userId, key, f.input),
      ready.create(f.userId, key, f.input),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(
      (await pool.query('SELECT count(*) FROM likeness_jobs WHERE user_id=$1', [f.userId])).rows[0]
        .count,
    ).toBe('1');
  });

  it('refuses reusing a purchase with another request key', async () => {
    const f = await fixture();
    await ready.create(f.userId, randomUUID(), f.input);
    await expect(ready.create(f.userId, randomUUID(), f.input)).rejects.toMatchObject({
      details: { reason: 'likeness_purchase_already_used' },
    });
  });

  it('accepts only one of simultaneous distinct requests for the same purchase', async () => {
    const f = await fixture();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, () => ready.create(f.userId, randomUUID(), f.input)),
    );
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of outcomes) {
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({
          details: { reason: 'likeness_purchase_already_used' },
        });
    }
    expect(
      (await pool.query('SELECT count(*) FROM likeness_jobs WHERE user_id=$1', [f.userId])).rows[0]
        .count,
    ).toBe('1');
  });

  it('refuses different payload under the same request key', async () => {
    const f = await fixture(),
      key = randomUUID();
    await ready.create(f.userId, key, f.input);
    await expect(
      ready.create(f.userId, key, { ...f.input, modelId: 'head_hero_gynoid' }),
    ).rejects.toMatchObject({ details: { reason: 'idempotency_body_mismatch' } });
  });

  it('does not accept another user purchase or reveal their job', async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      ready.create(a.userId, randomUUID(), { ...a.input, entitlementId: b.input.entitlementId }),
    ).rejects.toMatchObject({ httpStatus: 403 });
    const job = await ready.create(b.userId, randomUUID(), b.input);
    await expect(repo.get(a.userId, job.id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('does not accept another user photo', async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(
      ready.create(a.userId, randomUUID(), { ...a.input, uploadId: b.input.uploadId }),
    ).rejects.toMatchObject({ httpStatus: 404 });
    // Failed upload validation did not consume the purchase.
    expect((await ready.create(a.userId, randomUUID(), a.input)).status).toBe('queued');
  });

  it.each(['expires_at', 'deleted_at'])(
    'refuses photo when %s disallows processing',
    async (column) => {
      const f = await fixture();
      await pool.query(`UPDATE likeness_uploads SET ${column}=$1 WHERE id=$2`, [
        now,
        f.input.uploadId,
      ]);
      await expect(ready.create(f.userId, randomUUID(), f.input)).rejects.toMatchObject({
        httpStatus: 404,
      });
    },
  );

  it('refuses a revoked purchase', async () => {
    const f = await fixture();
    await pool.query('UPDATE likeness_entitlements SET revoked_at=$1 WHERE id=$2', [
      now,
      f.input.entitlementId,
    ]);
    await expect(ready.create(f.userId, randomUUID(), f.input)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it.each([
    { consent: { version: 'likeness-v1', ownPhoto: false, shareWithProvider: true } },
    { consent: { version: 'old', ownPhoto: true, shareWithProvider: true } },
    { consent: { version: 'likeness-v1', ownPhoto: true, shareWithProvider: false } },
    { imageUrl: 'https://example.com/photo.jpg' },
    { userId: randomUUID() },
    { paid: true },
  ])(
    'rejects missing consent, client ownership/payment claims and arbitrary URLs %j',
    async (override) => {
      const f = await fixture();
      await expect(
        ready.create(f.userId, randomUUID(), { ...f.input, ...override }),
      ).rejects.toMatchObject({ httpStatus: 400 });
    },
  );

  it('rejects unsupported model and malformed idempotency key', async () => {
    const f = await fixture();
    await expect(
      ready.create(f.userId, randomUUID(), { ...f.input, modelId: 'head_unknown' }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(ready.create(f.userId, '', f.input)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('reports unavailable when readiness has no provider', () => {
    const service = new LikenessService(repo, { enabled: true, provider: null, models: {} });
    expect(service.availability()).toMatchObject({
      enabled: false,
      reason: 'provider_not_configured',
    });
  });
});
