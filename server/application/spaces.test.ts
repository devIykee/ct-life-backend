/**
 * Spaces service tests (real DB).
 *
 * Uses the dev Postgres so the SERIALIZABLE transactions, UNIQUE
 * partial indexes, and CHECK constraints all actually run. Each
 * test inserts fresh users + rooms; the unique partial index on
 * (room_id, user_id) WHERE left_at IS NULL ensures we can run the
 * suite repeatedly.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let hostId: string;
let otherId: string;

beforeAll(async () => {
  // Use one-shot wallets so re-runs don't collide.
  hostId = uuidv7();
  otherId = uuidv7();
  await pool.query('INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4)', [
    hostId,
    `SpacesHost-${hostId}`,
    otherId,
    `SpacesOther-${otherId}`,
  ]);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Clean spaces for these two test users; cascades free the
  // speaker rows.
  await pool.query(
    `DELETE FROM voice_speakers WHERE room_id IN
        (SELECT room_id FROM voice_rooms WHERE host_user_id = $1
          AND title LIKE 'test-%')`,
    [hostId],
  );
  await pool.query(`DELETE FROM voice_rooms WHERE host_user_id = $1 AND title LIKE 'test-%'`, [
    hostId,
  ]);
});

async function makeCtx() {
  return buildContext();
}

describe('spaces service', () => {
  it('createSpace writes a room + host speaker row', async () => {
    const ctx = await makeCtx();
    const { createSpace } = await import('./spaces.js');
    const out = await createSpace(ctx, hostId, { title: 'test-create' });
    expect(out.spaceId.startsWith('space:')).toBe(true);
    expect(out.hostUserId).toBe(hostId);
    expect(out.speakerUserIds).toContain(hostId);
    const r = await pool.query<{ status: string; kind: string; max_speakers: number }>(
      `SELECT status, kind, max_speakers FROM voice_rooms WHERE room_id = $1`,
      [out.spaceId],
    );
    expect(r.rows[0]?.kind).toBe('space');
    expect(r.rows[0]?.status).toBe('live');
    expect(r.rows[0]?.max_speakers).toBe(8);
  });

  it('promoteSpeaker throws ForbiddenError for non-host', async () => {
    const ctx = await makeCtx();
    const { createSpace, promoteSpeaker } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-forbid' });
    await expect(promoteSpeaker(ctx, space.spaceId, otherId, otherId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('promoteSpeaker flips listener -> speaker and clears hand', async () => {
    const ctx = await makeCtx();
    const { createSpace, raiseHand, promoteSpeaker } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-promote' });
    await raiseHand(ctx, space.spaceId, otherId);
    const before = await pool.query<{ role: string; hand_raised_at: Date | null }>(
      `SELECT role, hand_raised_at FROM voice_speakers
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [space.spaceId, otherId],
    );
    expect(before.rows[0]?.role).toBe('listener');
    expect(before.rows[0]?.hand_raised_at).not.toBeNull();
    await promoteSpeaker(ctx, space.spaceId, hostId, otherId);
    const after = await pool.query<{ role: string; hand_raised_at: Date | null }>(
      `SELECT role, hand_raised_at FROM voice_speakers
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [space.spaceId, otherId],
    );
    expect(after.rows[0]?.role).toBe('speaker');
    expect(after.rows[0]?.hand_raised_at).toBeNull();
  });

  it('promoteSpeaker refuses once max_speakers is reached', async () => {
    const ctx = await makeCtx();
    const { createSpace, promoteSpeaker } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-cap' });
    // Fill 7 listener rows manually so promote doesn't have to drive
    // the hand-raise path.
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const id = uuidv7();
      ids.push(id);
      await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `cap-${id}`]);
      await pool.query(
        `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
         VALUES ($1, $2, $3, 'listener')`,
        [uuidv7(), space.spaceId, id],
      );
    }
    for (let i = 0; i < 7; i += 1) {
      await promoteSpeaker(ctx, space.spaceId, hostId, ids[i]!);
    }
    // Add an 8th listener, then attempt the 8th promote.
    const lastId = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [
      lastId,
      `caplast-${lastId}`,
    ]);
    await pool.query(
      `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
       VALUES ($1, $2, $3, 'listener')`,
      [uuidv7(), space.spaceId, lastId],
    );
    await expect(promoteSpeaker(ctx, space.spaceId, hostId, lastId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('endSpace flips status, closes speakers', async () => {
    const ctx = await makeCtx();
    const { createSpace, endSpace } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-end' });
    await endSpace(ctx, space.spaceId, hostId);
    const r = await pool.query<{ status: string; ended_at: Date | null }>(
      `SELECT status, ended_at FROM voice_rooms WHERE room_id = $1`,
      [space.spaceId],
    );
    expect(r.rows[0]?.status).toBe('ended');
    expect(r.rows[0]?.ended_at).not.toBeNull();
    const sp = await pool.query<{ left_at: Date | null }>(
      `SELECT left_at FROM voice_speakers
       WHERE room_id = $1 AND user_id = $2`,
      [space.spaceId, hostId],
    );
    expect(sp.rows[0]?.left_at).not.toBeNull();
  });

  it('endSpace throws ForbiddenError for non-host', async () => {
    const ctx = await makeCtx();
    const { createSpace, endSpace } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-endforbid' });
    await expect(endSpace(ctx, space.spaceId, otherId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('hand-raise queue is ordered by hand_raised_at ASC', async () => {
    const ctx = await makeCtx();
    const { createSpace, raiseHand, getSpace } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-queue' });
    const ids = [uuidv7(), uuidv7(), uuidv7()];
    for (const id of ids) {
      await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `q-${id}`]);
    }
    await raiseHand(ctx, space.spaceId, ids[0]!);
    await new Promise((r) => setTimeout(r, 5));
    await raiseHand(ctx, space.spaceId, ids[1]!);
    await new Promise((r) => setTimeout(r, 5));
    await raiseHand(ctx, space.spaceId, ids[2]!);
    const s = await getSpace(ctx, space.spaceId);
    expect(s.handUserIds).toEqual(ids);
  });
});

// Touch an unused import so lint is quiet.
void randomUUID;
