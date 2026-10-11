/** Explicit assembly for private delivery and optionally authorized human generation. */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { Config } from '../shared/config/config.js';
import type { Db } from '../shared/db/pool.js';
import {
  createLocalLikenessStorage,
  createS3LikenessStorage,
  type PrivateLikenessStorage,
} from '../shared/infra/likeness-storage.js';
import { LikenessPhotoRepository } from '../shared/db/likeness-photos.js';
import { LikenessPipelineRepository } from '../shared/db/likeness-pipeline.js';
import { LikenessDeliveryRepository } from '../shared/db/likeness-delivery.js';
import { LikenessPhotoService } from './likeness-photos.js';
import { LikenessGenerationWorker, type CharacterReferences } from './likeness-worker.js';
import { TripoAdapter } from '../shared/infra/tripo.js';
import { LikenessArtifactReader } from '../shared/infra/likeness-artifacts.js';
import { validateLikenessHumanoid } from '../shared/infra/likeness-humanoid.js';
import { UNCONFIGURED_LIKENESS, type LikenessReadiness } from '../shared/domain/likeness.js';
import { ValidationFailedError } from '../shared/domain/errors.js';

const Human = z.enum(['head_snow', 'head_rain', 'head_ubc_m', 'head_ubc_f']);
const References = z
  .array(
    z.strictObject({
      modelId: Human,
      path: z.string().refine(isAbsolute),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  )
  .max(4);
async function loadReferences(
  path: string,
): Promise<{ references: CharacterReferences; models: Record<string, 'human'> }> {
  const rows = path ? References.parse(JSON.parse(await readFile(path, 'utf8'))) : [];
  if (new Set(rows.map((r) => r.modelId)).size !== rows.length)
    throw new Error('Duplicate character reference');
  const models = Object.fromEntries(rows.map((r) => [r.modelId, 'human' as const]));
  return {
    models,
    references: {
      async load(modelId) {
        const row = rows.find((r) => r.modelId === modelId);
        if (!row) throw new ValidationFailedError({ reason: 'missing_character_reference' });
        const bytes = await readFile(row.path);
        if (
          bytes.length > 8 * 1024 * 1024 ||
          createHash('sha256').update(bytes).digest('hex') !== row.sha256
        )
          throw new ValidationFailedError({ reason: 'character_reference_changed' });
        return {
          bytes,
          contentType: bytes[0] === 137 ? 'image/png' : 'image/jpeg',
          revision: row.sha256,
        };
      },
    },
  };
}

/** Assemble storage even while new generation is disabled, preserving owned result access. */
export async function buildLikenessRuntime(config: Config, db: Db) {
  const c = config.likeness;
  for (const id of c.operatorUserIds)
    if (!z.uuid().safeParse(id).success) throw new Error('Invalid LIKENESS_OPERATOR_USER_IDS');
  let storage: PrivateLikenessStorage | undefined;
  if (c.localDirectory && config.nodeEnv !== 'production' && config.appEnv === 'local')
    storage = await createLocalLikenessStorage({ directory: c.localDirectory });
  else if (c.privateBucket && c.privateStorageConfirmed) {
    if (c.privateBucket === config.s3.bucketAds)
      throw new Error('Likeness storage must use a dedicated private bucket');
    const s3 = c.privateS3;
    if (!s3.accessKey || !s3.secretKey)
      throw new Error(
        'Likeness storage requires LIKENESS_S3_ACCESS_KEY and LIKENESS_S3_SECRET_KEY',
      );
    if (s3.accessKey === config.s3.accessKey)
      throw new Error('Likeness storage must not reuse the ads bucket credentials');
    storage = createS3LikenessStorage({
      bucket: c.privateBucket,
      prefix: 'likeness-private/',
      client: new S3Client({
        endpoint: s3.endpoint,
        region: s3.region,
        forcePathStyle: s3.forcePathStyle,
        credentials: { accessKeyId: s3.accessKey, secretAccessKey: s3.secretKey },
      }),
    });
  }
  if (!storage)
    return {
      forOwner: (_userId: string) => ({ readiness: UNCONFIGURED_LIKENESS }),
      worker: undefined,
      photos: undefined,
    };
  const { references, models } = await loadReferences(c.referenceManifest);
  const operator = c.operatorEvaluationEnabled && c.operatorUserIds.length > 0;
  const ready =
    c.generationEnabled &&
    Boolean(c.apiKey) &&
    c.runtimeProfileConfirmed &&
    Object.keys(models).length > 0 &&
    (c.endUserAgreementConfirmed || operator);
  const photos = new LikenessPhotoService(new LikenessPhotoRepository(db), storage, ready);
  const provider = new TripoAdapter({
    apiKey: c.apiKey,
    endUserAgreementConfirmed: c.endUserAgreementConfirmed,
    authorizedOperatorEvaluation: operator,
  });
  const repository = new LikenessPipelineRepository(
    db,
    c.endUserAgreementConfirmed ? undefined : c.operatorUserIds,
  );
  const delivery = new LikenessDeliveryRepository(db);
  const worker = new LikenessGenerationWorker(
    repository,
    storage,
    references,
    provider,
    new LikenessArtifactReader(['tripo-data.rg1.data.tripo3d.com']),
    ready,
    () => new Date(),
    c.runtimeProfileConfirmed
      ? async (job, bytes) => {
          const manifest = await validateLikenessHumanoid(bytes, job.id, job.model_id);
          await delivery.validated(job.id, manifest.sha256, manifest, new Date());
        }
      : undefined,
  );
  return {
    worker,
    photos,
    forOwner(userId: string) {
      const allowed = ready && (c.endUserAgreementConfirmed || c.operatorUserIds.includes(userId));
      const readiness: LikenessReadiness = {
        enabled: allowed,
        provider: allowed ? 'tripo' : null,
        models: allowed ? models : {},
      };
      return { readiness, photos, storage };
    },
  };
}
