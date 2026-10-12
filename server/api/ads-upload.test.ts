/**
 * POST /v1/uploads takes the raw PNG/JPEG body the client sends (it used to
 * answer 415 because no parser covered image types outside the likeness
 * plugin scope).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Keypair } from '@solana/web3.js';
import { buildServer, type ServerHandle } from './main.js';
import { buildContext } from '../application/context.js';
import type { S3 } from '../shared/s3/client.js';
import { createDb } from '../shared/db/pool.js';
import { uuidv7 } from '../shared/domain/uuid.js';

let handle: ServerHandle;
let token: string;
let png: Buffer;

const s3: S3 = {
  async put() {
    return {};
  },
  async presignGet(key) {
    return `https://s3.test/${key}`;
  },
  async presignPut(key) {
    return `https://s3.test/${key}`;
  },
  async ensureBucket() {},
};

function post(body: Buffer, contentType: string, auth = true) {
  return handle.app.inject({
    method: 'POST',
    url: '/v1/uploads',
    headers: {
      'content-type': contentType,
      'idempotency-key': randomUUID(),
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: body,
  });
}

beforeAll(async () => {
  const userId = uuidv7();
  const wallet = Keypair.generate().publicKey.toBase58();
  await createDb().withConnection((c) =>
    c.query('INSERT INTO users (id, wallet) VALUES ($1, $2)', [userId, wallet]),
  );
  png = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 255 } },
  })
    .png()
    .toBuffer();
  handle = await buildServer();
  handle.app.addHook('onRequest', async (req) => {
    req.ctx = { ...req.ctx, s3 };
  });
  await handle.app.ready();
  token = await buildContext().jwt.signAccess(userId, wallet, false);
});

afterAll(async () => {
  if (handle) await handle.stop();
});

describe('POST /v1/uploads', () => {
  it('accepts a raw PNG with 201 and the owned upload record', async () => {
    const res = await post(png, 'image/png');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mimeType: 'image/png', bookingId: '' });
    expect(res.json().uploadId).toBe(res.json().creativeId);
  });

  it('needs auth, a real image and at most 1 MiB', async () => {
    expect((await post(png, 'image/png', false)).statusCode).toBe(401);
    expect((await post(Buffer.from('nope'), 'image/png')).statusCode).toBe(400);
    expect((await post(Buffer.alloc(1_048_577, 1), 'image/png')).statusCode).toBe(413);
    expect((await post(png, 'image/gif')).statusCode).toBe(415);
  });
});
