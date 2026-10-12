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

import { buildContext, _resetContextForTests, type AppContext } from './context.js';
import { roomName, type LiveKitService } from './livekit.js';
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
  livekitCalls = [];
  livekitFailures = 0;
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

interface LiveKitCall {
  op: 'publish' | 'end';
  room: string;
  identity?: string;
  canPublish?: boolean;
}

let livekitCalls: LiveKitCall[] = [];
let livekitFailures = 0;

/** Real DB, recording LiveKit: tests never need a media server. */
async function makeCtx(): Promise<AppContext> {
  const ctx = buildContext();
  const failOrRecord = (call: LiveKitCall) => {
    if (livekitFailures > 0) {
      livekitFailures -= 1;
      return Promise.reject(new Error('livekit down'));
    }
    livekitCalls.push(call);
    return Promise.resolve();
  };
  const livekit: LiveKitService = {
    ...ctx.livekit,
    setParticipantCanPublish: (_c, a) =>
      failOrRecord({
        op: 'publish',
        room: roomName(a.kind, a.id),
        identity: a.identity,
        canPublish: a.canPublish,
      }),
    endRoom: (_c, a) => failOrRecord({ op: 'end', room: roomName(a.kind, a.id) }),
  };
  return { ...ctx, livekit };
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

describe('spaces RTC access and LiveKit sync', () => {
  async function addUser(tag: string): Promise<string> {
    const id = uuidv7();
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `${tag}-${id}`]);
    return id;
  }

  it('derives publish rights from the stored role, never the caller', async () => {
    const ctx = await makeCtx();
    const { createSpace, raiseHand, promoteSpeaker, demoteSpeaker, spaceRtcAccess } =
      await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-rtc-roles' });
    const listener = await addUser('rtc-listener');
    const stranger = await addUser('rtc-stranger');
    await raiseHand(ctx, space.spaceId, listener);

    expect(await spaceRtcAccess(ctx, space.spaceId, hostId)).toEqual({
      spaceId: space.spaceId,
      canPublish: true,
    });
    expect((await spaceRtcAccess(ctx, space.spaceId, listener)).canPublish).toBe(false);
    expect((await spaceRtcAccess(ctx, space.spaceId, stranger)).canPublish).toBe(false);

    await promoteSpeaker(ctx, space.spaceId, hostId, listener);
    expect((await spaceRtcAccess(ctx, space.spaceId, listener)).canPublish).toBe(true);
    await demoteSpeaker(ctx, space.spaceId, hostId, listener);
    expect((await spaceRtcAccess(ctx, space.spaceId, listener)).canPublish).toBe(false);

    expect(livekitCalls).toEqual([
      { op: 'publish', room: space.spaceId, identity: listener, canPublish: true },
      { op: 'publish', room: space.spaceId, identity: listener, canPublish: false },
    ]);
  });

  it('accepts a bare uuid and rejects another kind of room id', async () => {
    const ctx = await makeCtx();
    const { createSpace, spaceRtcAccess } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-rtc-ids' });
    const bare = space.spaceId.slice('space:'.length);
    expect((await spaceRtcAccess(ctx, bare, hostId)).spaceId).toBe(space.spaceId);
    await expect(spaceRtcAccess(ctx, `video:${bare}`, hostId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(spaceRtcAccess(ctx, `space:space:${bare}`, hostId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(spaceRtcAccess(ctx, `space:${uuidv7()}`, hostId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses ended Spaces and blocked callers', async () => {
    const ctx = await makeCtx();
    const { createSpace, endSpace, spaceRtcAccess } = await import('./spaces.js');
    const blocked = await addUser('rtc-blocked');
    await pool.query(
      `INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2), ($2, $1)`,
      [hostId, blocked],
    );
    const space = await createSpace(ctx, hostId, { title: 'test-rtc-ended' });
    await expect(spaceRtcAccess(ctx, space.spaceId, blocked)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await endSpace(ctx, space.spaceId, hostId);
    expect(livekitCalls).toEqual([{ op: 'end', room: space.spaceId }]);
    await expect(spaceRtcAccess(ctx, space.spaceId, hostId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('surfaces a failed LiveKit update and lets the host retry', async () => {
    const ctx = await makeCtx();
    const { createSpace, raiseHand, promoteSpeaker } = await import('./spaces.js');
    const space = await createSpace(ctx, hostId, { title: 'test-rtc-retry' });
    const listener = await addUser('rtc-retry');
    await raiseHand(ctx, space.spaceId, listener);
    livekitFailures = 3;
    await expect(promoteSpeaker(ctx, space.spaceId, hostId, listener)).rejects.toMatchObject({
      code: 'SERVER_BUSY',
    });
    await promoteSpeaker(ctx, space.spaceId, hostId, listener);
    expect(livekitCalls).toEqual([
      { op: 'publish', room: space.spaceId, identity: listener, canPublish: true },
    ]);
    const roles = await pool.query<{ role: string }>(
      `SELECT role FROM voice_speakers WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [space.spaceId, listener],
    );
    expect(roles.rows).toEqual([{ role: 'speaker' }]);
  });
});

// Touch an unused import so lint is quiet.
void randomUUID;
