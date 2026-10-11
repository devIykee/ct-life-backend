/** Real filesystem and loopback HTTP fixtures exercise the AWS SDK transport. */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLocalLikenessStorage,
  createS3LikenessStorage,
  MAX_LIKENESS_MODEL_BYTES,
  type PrivateLikenessStorage,
} from './likeness-storage.js';

const key = () => `${randomUUID()}.jpg`;
const photo = Buffer.from([255, 216, 255, 217]); // Storage takes already-validated opaque bytes.

async function contract(store: PrivateLikenessStorage): Promise<void> {
  const id = key();
  await store.put(id, photo);
  expect(await store.get(id)).toEqual(photo);
  await expect(store.put(id, Buffer.from('replacement'))).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  expect(await store.get(id)).toEqual(photo);
  await store.delete(id);
  await store.delete(id);
  await expect(store.get(id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const model = `${randomUUID()}.glb`;
  await store.put(model, Buffer.from('validated glb bytes'), 'model/gltf-binary');
  expect(await store.get(model, MAX_LIKENESS_MODEL_BYTES)).toEqual(
    Buffer.from('validated glb bytes'),
  );
  await expect(store.put(model, photo)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  await expect(store.put(key(), photo, 'model/gltf-binary')).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  for (const invalid of [
    '../outside.jpg',
    '/outside.jpg',
    'https://example.com/photo.jpg',
    `${randomUUID()}.png`,
    'wallet-identity.jpg',
  ]) {
    await expect(store.put(invalid, photo)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(store.get(invalid)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(store.delete(invalid)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  }
  await expect(store.put(key(), Buffer.alloc(4 * 1024 * 1024 + 1))).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  await expect(store.put(key(), Buffer.alloc(0))).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  for (const limit of [0, -1, NaN, MAX_LIKENESS_MODEL_BYTES + 1])
    await expect(store.get(key(), limit)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
}

describe('local private likeness storage', () => {
  let root: string;
  let directory: string;
  let store: PrivateLikenessStorage;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ctlife-private-test-'));
    directory = join(root, 'private');
    store = await createLocalLikenessStorage({ directory });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('honors the same immutable put/get/delete contract as S3', async () => {
    await contract(store);
  });

  it('creates owner-only directories/files and rejects larger reads', async () => {
    const id = key();
    await store.put(id, photo);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, id))).mode & 0o777).toBe(0o600);
    await expect(store.get(id, 2)).rejects.toMatchObject({
      details: { reason: 'private_object_too_large' },
    });
  });

  it('refuses to read symlinks/hardlinks or overwrite an existing symlink', async () => {
    const outside = join(root, 'outside');
    await writeFile(outside, 'private fixture');
    const linked = key();
    await symlink(outside, join(directory, linked));
    await expect(store.get(linked)).rejects.toMatchObject({ code: 'LIKENESS_UNAVAILABLE' });
    await expect(store.put(linked, photo)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await readFile(outside, 'utf8')).toBe('private fixture');
    const hardlinked = key();
    await link(outside, join(directory, hardlinked));
    await expect(store.get(hardlinked)).rejects.toMatchObject({ code: 'LIKENESS_UNAVAILABLE' });
  });

  it('rejects a symlink storage root and production use', async () => {
    const alias = join(root, 'alias');
    await symlink(directory, alias);
    await expect(createLocalLikenessStorage({ directory: alias })).rejects.toMatchObject({
      code: 'LIKENESS_UNAVAILABLE',
    });
    vi.stubEnv('NODE_ENV', 'production');
    await expect(createLocalLikenessStorage({ directory })).rejects.toMatchObject({
      details: { reason: 'local_private_storage_disabled' },
    });
  });
});

describe('dedicated private S3 likeness storage over HTTP', () => {
  let server: Server;
  let client: S3Client;
  let store: PrivateLikenessStorage;
  let endpoint: string;
  const objects = new Map<string, Buffer>();
  const requests: { method: string; path: string; headers: IncomingHttpHeaders }[] = [];
  let behavior:
    'normal' | 'oversized-header' | 'oversized-stream' | 'hang-headers' | 'hang-body' | 'failure' =
    'normal';

  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      requests.push({ method: request.method ?? '', path, headers: request.headers });
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (behavior === 'hang-headers') return;
      if (behavior === 'hang-body') {
        response.writeHead(200);
        response.write('x');
        return;
      }
      if (behavior === 'oversized-header') {
        response.writeHead(200, { 'content-length': 5 * 1024 * 1024 });
        response.write('x');
        return;
      }
      if (behavior === 'oversized-stream') {
        response.writeHead(200);
        response.write(Buffer.alloc(65));
        response.end();
        return;
      }
      if (behavior === 'failure') {
        response.writeHead(500);
        response.end(
          '<Error><Code>InternalError</Code><Message>never expose fixture details</Message></Error>',
        );
        return;
      }
      if (request.method === 'PUT') {
        if (objects.has(path)) {
          response.writeHead(412);
          response.end('<Error><Code>PreconditionFailed</Code></Error>');
        } else {
          objects.set(path, Buffer.concat(chunks));
          response.writeHead(200);
          response.end();
        }
      } else if (request.method === 'DELETE') {
        objects.delete(path);
        response.writeHead(204);
        response.end();
      } else {
        const data = objects.get(path);
        if (data) {
          response.writeHead(200, { 'content-length': data.length });
          response.end(data);
        } else {
          response.writeHead(404);
          response.end('<Error><Code>NoSuchKey</Code></Error>');
        }
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    endpoint = `http://127.0.0.1:${address.port}`;
  });
  beforeEach(() => {
    objects.clear();
    requests.length = 0;
    behavior = 'normal';
    client = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'fixture-only', secretAccessKey: 'fixture-only' },
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    store = createS3LikenessStorage({
      client,
      bucket: 'private-likeness-test',
      prefix: 'likeness-private/',
      timeoutMs: 250,
    });
  });
  afterEach(() => {
    client.destroy();
    server.closeAllConnections();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('honors immutable put/get/delete using the real AWS SDK', async () => {
    await contract(store);
  });

  it('sends only opaque names in a dedicated prefix with no caching/public ACL', async () => {
    const id = key();
    await store.put(id, photo);
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      path: `/private-likeness-test/likeness-private/${id}`,
      headers: {
        'content-type': 'image/jpeg',
        'cache-control': 'private, no-store',
        'if-none-match': '*',
      },
    });
    expect(requests[0]?.headers['x-amz-acl']).toBeUndefined();
    expect(Object.keys(store).sort()).toEqual(['delete', 'get', 'put']);
  });

  it('rejects oversized Content-Length before reading the response body', async () => {
    behavior = 'oversized-header';
    await expect(store.get(key())).rejects.toMatchObject({
      details: { reason: 'private_object_too_large' },
    });
  });

  it('bounds chunked responses even when no length is declared', async () => {
    behavior = 'oversized-stream';
    await expect(store.get(key(), 16)).rejects.toMatchObject({
      details: { reason: 'private_object_too_large' },
    });
  });

  it.each(['hang-headers', 'hang-body'] as const)(
    'aborts %s within the configured deadline',
    async (mode) => {
      behavior = mode;
      await expect(store.get(key())).rejects.toMatchObject({ code: 'LIKENESS_UNAVAILABLE' });
    },
  );

  it('sanitizes provider errors without exposing remote bodies', async () => {
    behavior = 'failure';
    await expect(store.get(key())).rejects.toMatchObject({
      message: 'Private character storage could not complete this request.',
      details: { reason: 'private_storage_failed' },
    });
  });

  it('rejects arbitrary paths and identity-shaped prefixes at composition', () => {
    for (const prefix of ['../', 'https://example.com/', 'wallet/user/', ''])
      expect(() =>
        createS3LikenessStorage({ client, bucket: 'private-likeness-test', prefix }),
      ).toThrow();
  });
});
