/**
 * S3 client.
 *
 * Thin wrapper around @aws-sdk/client-s3. Used in M5 for ad uploads.
 * M2 only needs the client and a `presign` helper. The bucket is
 * created lazily on first write if it does not exist; the MinIO dev
 * server auto-creates on PUT.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandInput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { loadConfig } from '../config/config.js';

export interface S3 {
  /** Upload a key with body and content type. Returns the etag and versionId. */
  put(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<{ etag?: string; versionId?: string }>;
  /** Presigned GET URL (e.g. for the Unity client to download an ad creative). */
  presignGet(key: string, ttlSec: number): Promise<string>;
  /** Presigned PUT URL (e.g. for direct browser upload of a creative). */
  presignPut(key: string, contentType: string, ttlSec: number): Promise<string>;
  /** Delete a key. Deleting a missing key succeeds. */
  remove(key: string): Promise<void>;
  /** Create the configured bucket if it does not exist. Idempotent. */
  ensureBucket(): Promise<void>;
}

let cached: S3 | null = null;

/**
 * Build the process-wide S3 client. Uses the path-style endpoint and
 * MinIO credentials from config. Memoised; second call returns the
 * same instance.
 */
export function createS3(overrides: { bucket?: string } = {}): S3 {
  if (cached !== null) return cached;
  const cfg = loadConfig();
  const client = new S3Client({
    region: cfg.s3.region,
    endpoint: cfg.s3.endpoint,
    forcePathStyle: cfg.s3.forcePathStyle,
    credentials: {
      accessKeyId: cfg.s3.accessKey,
      secretAccessKey: cfg.s3.secretKey,
    },
  });
  const bucket = overrides.bucket ?? cfg.s3.bucketAds;

  cached = {
    async put(key, body, contentType) {
      const input: PutObjectCommandInput = {
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      };
      const res = await client.send(new PutObjectCommand(input));
      return { etag: res.ETag, versionId: res.VersionId };
    },
    async presignGet(key, ttlSec) {
      const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      return getSignedUrl(client, cmd, { expiresIn: ttlSec });
    },
    async presignPut(key, contentType, ttlSec) {
      const cmd = new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType });
      return getSignedUrl(client, cmd, { expiresIn: ttlSec });
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    async ensureBucket() {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
      } catch (e) {
        // Already exists or no permission; MinIO returns BucketAlreadyOwnedByYou.
        if ((e as { name?: string }).name === 'BucketAlreadyOwnedByYou') return;
        if ((e as { name?: string }).name === 'BucketAlreadyExists') return;
        // For other errors, rethrow.
        throw e;
      }
    },
  };
  return cached;
}

/** Test-only: drop the cached client. */
export function _resetS3ForTests(): void {
  cached = null;
}
