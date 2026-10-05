/**
 * Video calls tests (real DB).
 *
 * Covers 1:1 + group setup, end-closes-LiveKit, capacity cap,
 * and the ForbiddenError on non-host end.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let hostId: string;
let p1: string;
let p2: string;

beforeAll(async () => {
  hostId = uuidv7();
  p1 = uuidv7();
  p2 = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4), ($5, $6)`, [
    hostId,
    `vcHost-${hostId}`,
    p1,
    `vcP1-${p1}`,
    p2,
    `vcP2-${p2}`,
  ]);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await pool.query(
    `DELETE FROM voice_speakers WHERE room_id IN
       (SELECT room_id FROM voice_rooms WHERE host_user_id = $1
         AND title LIKE 'video call %')`,
    [hostId],
  );
  await pool.query(
    `DELETE FROM voice_rooms WHERE host_user_id = $1 AND title LIKE 'video call %'`,
    [hostId],
  );
});

function makeCtx(): import('./context.js').AppContext {
  // Build a context with a LiveKit stub that returns deterministic
  // tokens without contacting the SDK / server.
  const ctx = buildContext();
  (ctx as unknown as { livekit: unknown }).livekit = {
    mintRtcToken: vi.fn(async (args: { userId: string; kind: string; id: string }) => ({
      token: `tkn-${args.kind}-${args.id}-${args.userId}`,
      url: 'ws://localhost:7880',
      roomName: `${args.kind}:${args.id}`,
      identity: args.userId,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      canPublish: true,
    })),
    endRoom: vi.fn(async () => undefined),
    setParticipantCanPublish: vi.fn(async () => undefined),
  };
  return ctx;
}

describe('video calls service', () => {
  it('startVideoCall 1:1 writes room + speakers + tokens', async () => {
    const ctx = makeCtx();
    const { startVideoCall } = await import('./video-calls.js');
    const out = await startVideoCall(ctx, hostId, { participantUserIds: [p1] });
    expect(out.call.hostUserId).toBe(hostId);
    expect(out.call.participantUserIds).toEqual([p1]);
    expect(out.tokens.length).toBe(2);
    expect(out.tokens.map((t) => t.userId).sort()).toEqual([hostId, p1].sort());
    expect(out.tokens.every((t) => t.canPublish)).toBe(true);
    // Room + 2 speakers persisted.
    const room = await pool.query<{ kind: string; status: string; max_speakers: number }>(
      `SELECT kind, status, max_speakers FROM voice_rooms WHERE room_id = $1`,
      [out.call.callId.startsWith('video:') ? out.call.callId : `video:${out.call.callId}`],
    );
    expect(room.rows[0]?.kind).toBe('video');
    expect(room.rows[0]?.status).toBe('live');
    expect(room.rows[0]?.max_speakers).toBe(8);
  });

  it('startVideoCall group setup mints one token per participant', async () => {
    const ctx = makeCtx();
    const { startVideoCall } = await import('./video-calls.js');
    const out = await startVideoCall(ctx, hostId, { participantUserIds: [p1, p2] });
    expect(out.tokens.length).toBe(3);
    expect(out.tokens.find((t) => t.userId === hostId)).toBeTruthy();
    expect(out.tokens.find((t) => t.userId === p1)).toBeTruthy();
    expect(out.tokens.find((t) => t.userId === p2)).toBeTruthy();
  });

  it('startVideoCall refuses more than 8 participants', async () => {
    const ctx = makeCtx();
    const { startVideoCall } = await import('./video-calls.js');
    const ids = Array.from({ length: 8 }, () => uuidv7());
    await expect(startVideoCall(ctx, hostId, { participantUserIds: ids })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('endVideoCall flips status, closes speakers, ends LiveKit', async () => {
    const ctx = makeCtx();
    const { startVideoCall, endVideoCall } = await import('./video-calls.js');
    const out = await startVideoCall(ctx, hostId, { participantUserIds: [p1] });
    const callId = out.call.callId;
    await endVideoCall(ctx, callId, hostId);
    const r = await pool.query<{ status: string }>(
      `SELECT status FROM voice_rooms WHERE room_id = $1`,
      [`video:${callId}`],
    );
    expect(r.rows[0]?.status).toBe('ended');
    const sp = await pool.query<{ left_at: Date | null }>(
      `SELECT left_at FROM voice_speakers WHERE room_id = $1 AND left_at IS NULL`,
      [`video:${callId}`],
    );
    expect(sp.rows.length).toBe(0);
    const endCalls = (ctx.livekit.endRoom as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(endCalls.some((c) => (c[1] as { id: string }).id === callId)).toBe(true);
  });

  it('endVideoCall throws ForbiddenError for non-host', async () => {
    const ctx = makeCtx();
    const { startVideoCall, endVideoCall } = await import('./video-calls.js');
    const out = await startVideoCall(ctx, hostId, { participantUserIds: [p1] });
    await expect(endVideoCall(ctx, out.call.callId, p1)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('endVideoCall throws NotFoundError for unknown id', async () => {
    const ctx = makeCtx();
    const { endVideoCall } = await import('./video-calls.js');
    await expect(endVideoCall(ctx, uuidv7(), hostId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('listMyVideoCalls returns calls the user is on', async () => {
    const ctx = makeCtx();
    const { startVideoCall, listMyVideoCalls } = await import('./video-calls.js');
    const out = await startVideoCall(ctx, hostId, { participantUserIds: [p1] });
    const callsHost = await listMyVideoCalls(ctx, hostId);
    const callsP1 = await listMyVideoCalls(ctx, p1);
    expect(callsHost.find((c) => c.callId === out.call.callId)).toBeTruthy();
    expect(callsP1.find((c) => c.callId === out.call.callId)).toBeTruthy();
  });
});
