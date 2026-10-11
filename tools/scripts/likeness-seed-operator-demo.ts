/** Import the already-paid synthetic operator trial into LOCAL owned delivery.
 * No provider request, purchase, automatic acceptance, or production execution.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { loadConfig } from '../../server/shared/config/config.js';
import { createDb } from '../../server/shared/db/pool.js';
import { LikenessPhotoRepository } from '../../server/shared/db/likeness-photos.js';
import { LikenessPhotoService } from '../../server/application/likeness-photos.js';
import { LikenessRepository } from '../../server/shared/db/likeness.js';
import { LikenessService } from '../../server/application/likeness.js';
import { createLocalLikenessStorage } from '../../server/shared/infra/likeness-storage.js';
import { validateLikenessHumanoid } from '../../server/shared/infra/likeness-humanoid.js';
import { normalizeLikenessPhoto } from '../../server/shared/infra/likeness-image.js';

async function main() {
  const [walletFile, evidence, privateDirectory] = process.argv.slice(2),
    cfg = loadConfig();
  if (
    cfg.appEnv !== 'local' ||
    cfg.nodeEnv !== 'development' ||
    !['127.0.0.1', 'localhost', '::1'].includes(new URL(cfg.databaseUrl).hostname)
  )
    throw Error('Local development only');
  if (
    !walletFile ||
    !evidence ||
    !privateDirectory ||
    ![walletFile, evidence, privateDirectory].every(isAbsolute)
  )
    throw Error('Three absolute paths required');
  const wallet = (await readFile(walletFile, 'utf8')).trim(),
    db = createDb();
  try {
    const user = await db.withConnection((c) =>
      c.query<{ id: string }>('SELECT id FROM users WHERE wallet=$1', [wallet]),
    );
    if (!user.rows[0]) throw Error('Operator account must sign in first');
    const userId = user.rows[0].id;
    const paymentReference = `synthetic-human1-mixamo/${userId}`;
    const existing = await db.withConnection((c) =>
      c.query<{ id: string }>(
        'SELECT j.id FROM likeness_jobs j JOIN likeness_entitlements e ON e.id=j.entitlement_id WHERE e.payment_source=$1 AND e.payment_reference=$2',
        ['operator_evaluation', paymentReference],
      ),
    );
    if (existing.rows[0]) {
      console.log(JSON.stringify({ jobId: existing.rows[0].id, alreadyImported: true }));
      return;
    }
    const bytes = await readFile(join(evidence, 'synthetic-human1-mixamo/rigged-unapproved.glb'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (hash !== '605c745cd6bda53e806d0abdf324ef81320af0cfa717b6d33caa1a324a3ec97c')
      throw Error('Authorized artifact changed');
    await validateLikenessHumanoid(bytes, randomUUID(), 'head_snow');
    const storage = await createLocalLikenessStorage({ directory: privateDirectory }),
      now = new Date();
    const entitlement = randomUUID();
    const granted = await db.withConnection((c) =>
      c.query<{ id: string }>(
        `INSERT INTO likeness_entitlements(id,user_id,product_id,payment_source,payment_reference,amount_base_units,currency,verified_at,credit_budget)
       VALUES($1,$2,'likeness_3d_v1','operator_evaluation',$3,'0','TEST',$4,0)
       ON CONFLICT(payment_source,payment_reference)DO UPDATE SET payment_reference=EXCLUDED.payment_reference RETURNING id`,
        [entitlement, userId, paymentReference, now],
      ),
    );
    const photoKey = createHash('sha256').update(`photo/${paymentReference}`).digest();
    photoKey[6] = (photoKey[6]! & 15) | 64;
    photoKey[8] = (photoKey[8]! & 63) | 128;
    const hex = photoKey.subarray(0, 16).toString('hex'),
      key = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const consent = { version: 'likeness-v1', ownPhoto: true, shareWithProvider: true };
    const photo = await new LikenessPhotoService(
      new LikenessPhotoRepository(db),
      storage,
      true,
    ).ingest(
      userId,
      key,
      'image/jpeg',
      await readFile(join(evidence, 'synthetic-human1/face.jpg')),
      consent,
    );
    const job = await new LikenessService(new LikenessRepository(db), {
      enabled: true,
      provider: 'tripo',
      models: { head_snow: 'human' },
    }).create(userId, randomUUID(), {
      modelId: 'head_snow',
      uploadId: photo.uploadId,
      entitlementId: granted.rows[0]!.id,
      consent,
    });
    const reference = await normalizeLikenessPhoto(
      await readFile(join(evidence, 'synthetic-human1/conditioned.jpg')),
      'image/jpeg',
    );
    const referenceKey = `${randomUUID()}.jpg`,
      assetKey = `${randomUUID()}.glb`;
    await storage.put(referenceKey, reference.bytes, 'image/jpeg');
    await storage.put(assetKey, bytes, 'model/gltf-binary');
    await db.withConnection((c) =>
      c.query(
        `UPDATE likeness_jobs SET status='processing',phase='awaiting_asset_validation',reference_key=$2,reference_sha256=$3,
       reference_approved_at=$4,asset_key=$5,asset_sha256=$6,reference_revision='synthetic-operator-evaluation',prompt_version='ctlife-reference-v1'
       WHERE id=$1`,
        [job.id, referenceKey, reference.sha256, now, assetKey, hash],
      ),
    );
    await writeFile(
      join(evidence, 'operator-demo-import.json'),
      JSON.stringify(
        {
          jobId: job.id,
          userId,
          sha256: hash,
          source: 'synthetic_operator_evaluation',
          publicGeneration: false,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        jobId: job.id,
        status: 'awaiting_asset_validation',
        newProviderCredits: 0,
        syntheticDemo: true,
      }),
    );
  } finally {
    await db.close();
  }
}
main().catch(() => {
  console.error('Operator demo import failed; no provider calls were made.');
  process.exitCode = 1;
});
