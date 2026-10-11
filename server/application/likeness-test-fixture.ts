/** Real isolated Postgres and private temporary storage fixtures; no public-schema writes. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import type { Db } from '../shared/db/pool.js';
import { createLocalLikenessStorage } from '../shared/infra/likeness-storage.js';
/** Create an isolated local schema, real private storage and synthetic image data. */
export async function likenessFixture() {
  const connectionString = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (
    !connectionString ||
    !['localhost', '127.0.0.1', '::1'].includes(new URL(connectionString).hostname)
  )
    throw new Error('Likeness tests require local Postgres');
  const schema = `test_likeness_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  await pool.query('CREATE TABLE users(id uuid PRIMARY KEY,wallet text)');
  for (const file of [
    '1700000075000_likeness_jobs.sql',
    '1700000076000_likeness_pipeline.sql',
    '1700000077000_likeness_delivery.sql',
    '1700000079000_likeness_checkout.sql',
  ]) {
    const migration = readFileSync(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8');
    await pool.query(migration.split('-- Down Migration')[0]!);
  }
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
  const directory = await mkdtemp(join(tmpdir(), 'ctlife-private-fixture-'));
  const storage = await createLocalLikenessStorage({ directory });
  // Synthetic pixels contain no person's face or metadata.
  const image = await sharp({
    create: { width: 256, height: 256, channels: 3, background: '#2d5664' },
  })
    .png()
    .toBuffer();
  return {
    db,
    pool,
    storage,
    image,
    directory,
    async user() {
      const id = randomUUID();
      await pool.query('INSERT INTO users(id)VALUES($1)', [id]);
      return id;
    },
    async entitlement(userId: string, now: Date) {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO likeness_entitlements
      (id,user_id,product_id,payment_source,payment_reference,amount_base_units,currency,verified_at)
      VALUES($1,$2,'likeness_3d_v1','fixture_verified',$4,1,'FIXTURE',$3)`,
        [id, userId, now, `fixture-${id}`],
      );
      return id;
    },
    async clear() {
      await pool.query('TRUNCATE users CASCADE');
    },
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export const ownPhotoConsent = { version: 'likeness-v1', ownPhoto: true, shareWithProvider: true };
