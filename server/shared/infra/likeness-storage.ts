/** Private normalized photos and validated GLBs. There is deliberately no URL/presign API.
 * Production must inject a dedicated private bucket/client with public access blocked;
 * this adapter never imports the memoized advertising bucket. Authorization is upstream.
 * The slightly longer file keeps local/S3 adapters on the same bounded contract.
 */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationFailedError,
} from '../domain/errors.js';
import { MAX_LIKENESS_PHOTO_BYTES } from './likeness-image.js';

export const MAX_LIKENESS_MODEL_BYTES = 32 * 1024 * 1024;
type ContentType = 'image/jpeg' | 'model/gltf-binary';
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|glb)$/;

export interface PrivateLikenessStorage {
  /** Keys are server-generated UUIDv4 filenames; writes are immutable. */
  put(key: string, bytes: Uint8Array, contentType?: ContentType): Promise<void>;
  /** Default photo limit; validated artifact callers can explicitly request up to 32MiB. */
  get(key: string, maxBytes?: number): Promise<Buffer>;
  /** Deleting a missing key is idempotent. */
  delete(key: string): Promise<void>;
}

export class LikenessStorageError extends DomainError {
  readonly code = 'LIKENESS_UNAVAILABLE';
  /** Stable reasons only: never expose object keys, endpoint URLs or upstream bodies. */
  constructor(reason: string) {
    super('Private character storage could not complete this request.', { reason });
    this.httpStatus = 503;
  }
}

function validateKey(key: string): void {
  if (!KEY.test(key)) throw new ValidationFailedError({ reason: 'invalid_private_object_key' });
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_LIKENESS_MODEL_BYTES)
    throw new ValidationFailedError({ reason: 'invalid_private_object_limit' });
}

function validatePut(key: string, bytes: Uint8Array, type: ContentType): void {
  validateKey(key);
  const photo = key.endsWith('.jpg');
  if (type !== (photo ? 'image/jpeg' : 'model/gltf-binary'))
    throw new ValidationFailedError({ reason: 'private_object_type_mismatch' });
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > (photo ? MAX_LIKENESS_PHOTO_BYTES : MAX_LIKENESS_MODEL_BYTES)
  )
    throw new ValidationFailedError({ reason: 'private_object_size' });
}

function storageError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const details = error as {
    code?: string;
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  if (
    details?.code === 'ENOENT' ||
    details?.name === 'NoSuchKey' ||
    details?.$metadata?.httpStatusCode === 404
  )
    throw new NotFoundError();
  if (details?.code === 'EEXIST' || details?.$metadata?.httpStatusCode === 412)
    throw new ConflictError({ reason: 'private_object_exists' });
  throw new LikenessStorageError('private_storage_failed');
}

async function bounded<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new LikenessStorageError('private_storage_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    return storageError(error);
  } finally {
    clearTimeout(timer);
  }
}

function timeout(value = 10_000): number {
  if (!Number.isFinite(value) || value < 25 || value > 30_000)
    throw new ValidationFailedError({ reason: 'invalid_private_storage_timeout' });
  return value;
}

async function readBounded(
  stream: Readable,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const cancel = () => {
    stream.destroy(new LikenessStorageError('private_storage_timeout'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw new LikenessStorageError('invalid_private_object');
      size += chunk.byteLength;
      if (size > maxBytes) throw new LikenessStorageError('private_object_too_large');
      chunks.push(Buffer.from(chunk));
    }
    if (size === 0) throw new LikenessStorageError('invalid_private_object');
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    stream.destroy();
  }
}

/** Local test/development adapter. Refuses production; files remain owner-only and immutable. */
export async function createLocalLikenessStorage(config: {
  readonly directory: string;
  readonly timeoutMs?: number;
}): Promise<PrivateLikenessStorage> {
  if (!['test', 'development'].includes(process.env.NODE_ENV ?? ''))
    throw new LikenessStorageError('local_private_storage_disabled');
  const directory = resolve(config.directory);
  const timeoutMs = timeout(config.timeoutMs);
  await bounded(timeoutMs, async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new LikenessStorageError('invalid_private_storage_directory');
    await chmod(directory, 0o700);
  });
  return {
    async put(key, bytes, contentType = 'image/jpeg') {
      validatePut(key, bytes, contentType);
      await bounded(timeoutMs, async (signal) => {
        signal.throwIfAborted();
        const path = join(directory, key);
        const file = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(bytes, { signal });
          await file.sync();
          signal.throwIfAborted();
        } catch (error) {
          await unlink(path).catch(() => undefined);
          throw error;
        } finally {
          await file.close();
        }
      });
    },
    async get(key, maxBytes = MAX_LIKENESS_PHOTO_BYTES) {
      validateKey(key);
      validateLimit(maxBytes);
      return bounded(timeoutMs, async (signal) => {
        signal.throwIfAborted();
        const file = await open(join(directory, key), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.nlink !== 1)
            throw new LikenessStorageError('invalid_private_object');
          if (info.size > maxBytes) throw new LikenessStorageError('private_object_too_large');
          return await readBounded(
            file.createReadStream({ start: 0, end: maxBytes, autoClose: false }),
            maxBytes,
            signal,
          );
        } finally {
          await file.close();
        }
      });
    },
    async delete(key) {
      validateKey(key);
      await bounded(timeoutMs, async (signal) => {
        signal.throwIfAborted();
        try {
          await unlink(join(directory, key));
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
      });
    },
  };
}

/** Inject a dedicated S3 client and private bucket; no cached ads client or public URLs. */
export function createS3LikenessStorage(config: {
  readonly client: S3Client;
  readonly bucket: string;
  /** Deployment constant such as `likeness-private/`, never a wallet/user identifier. */
  readonly prefix: string;
  readonly timeoutMs?: number;
}): PrivateLikenessStorage {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    !/^[a-z][a-z0-9-]{0,47}\/$/.test(config.prefix)
  )
    throw new ValidationFailedError({ reason: 'invalid_private_storage_config' });
  const timeoutMs = timeout(config.timeoutMs);
  const object = (key: string) => ({ Bucket: config.bucket, Key: `${config.prefix}${key}` });
  return {
    async put(key, bytes, contentType = 'image/jpeg') {
      validatePut(key, bytes, contentType);
      await bounded(timeoutMs, async (signal) => {
        await config.client.send(
          new PutObjectCommand({
            ...object(key),
            Body: bytes,
            ContentType: contentType,
            ContentLength: bytes.byteLength,
            CacheControl: 'private, no-store',
            IfNoneMatch: '*',
          }),
          { abortSignal: signal },
        );
      });
    },
    async get(key, maxBytes = MAX_LIKENESS_PHOTO_BYTES) {
      validateKey(key);
      validateLimit(maxBytes);
      return bounded(timeoutMs, async (signal) => {
        const response = await config.client.send(new GetObjectCommand(object(key)), {
          abortSignal: signal,
        });
        if (!(response.Body instanceof Readable))
          throw new LikenessStorageError('invalid_private_object');
        if ((response.ContentLength ?? 0) > maxBytes) {
          response.Body.destroy();
          throw new LikenessStorageError('private_object_too_large');
        }
        return readBounded(response.Body, maxBytes, signal);
      });
    },
    async delete(key) {
      validateKey(key);
      await bounded(timeoutMs, async (signal) => {
        await config.client.send(new DeleteObjectCommand(object(key)), { abortSignal: signal });
      });
    },
  };
}
