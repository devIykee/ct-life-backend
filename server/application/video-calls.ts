/**
 * Video calls service (free 1:1 and group).
 *
 * Endpoints:
 *
 *   POST /v1/video-calls                 — start a 1:1 or group call
 *   GET  /v1/video-calls                 — list the user's active calls
 *   POST /v1/video-calls/{id}/end        — end the call
 *
 * The call is a `voice_rooms` row with `kind='video'`. The call's
 * `voice_speakers` rows are the participants (each as 'speaker'
 * since video calls allow publishing for everyone). No payment
 * is required; paid calls live in `paid-calls.ts`.
 *
 * Capacity per call: 8 (1 host + 7 participants, per the spec).
 * The `voice_rooms.max_speakers` CHECK enforces 1..8; the
 * video-calls service uses the default 8.
 *
 * The endpoint mints a LiveKit token for each participant and
 * returns the URL + tokens so the client can connect.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ForbiddenError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';

const MAX_PARTICIPANTS = 8;

export interface VideoCallRow {
  readonly callId: string;
  readonly hostUserId: string;
  readonly participantUserIds: string[];
  readonly status: 'live' | 'ended';
  readonly startedAt: string;
  readonly endedAt: string | null;
}

export interface StartVideoCallArgs {
  readonly participantUserIds: string[];
}

export interface VideoCallToken {
  readonly userId: string;
  readonly token: string;
  readonly url: string;
  readonly roomName: string;
  readonly identity: string;
  readonly canPublish: boolean;
  readonly expiresAt: number;
}

export interface StartVideoCallResult {
  readonly call: VideoCallRow;
  readonly tokens: VideoCallToken[];
}

function participantsList(host: string, ids: string[]): string[] {
  const set = new Set<string>([host, ...ids]);
  return [...set];
}

/** Start a 1:1 or group video call. Returns the call + tokens. */
export async function startVideoCall(
  ctx: AppContext,
  hostUserId: string,
  args: StartVideoCallArgs,
): Promise<StartVideoCallResult> {
  if (args.participantUserIds.length < 1) {
    throw new ValidationFailedError({ reason: 'at least one participant' });
  }
  if (args.participantUserIds.includes(hostUserId)) {
    throw new ValidationFailedError({ reason: 'host included in participants' });
  }
  const participants = participantsList(hostUserId, args.participantUserIds);
  if (participants.length > MAX_PARTICIPANTS) {
    throw new ValidationFailedError({
      reason: `max ${MAX_PARTICIPANTS} participants`,
    });
  }
  const callId = uuidv7();
  const roomId = `video:${callId}`;
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO voice_rooms (room_id, host_user_id, kind, title)
       VALUES ($1, $2, 'video', $3)`,
      [roomId, hostUserId, `video call ${callId.slice(0, 8)}`],
    );
    for (const userId of participants) {
      const speakerId = uuidv7();
      const role = userId === hostUserId ? 'host' : 'speaker';
      await client.query(
        `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
         VALUES ($1, $2, $3, $4)`,
        [speakerId, roomId, userId, role],
      );
    }
  });
  const tokens = await Promise.all(
    participants.map(async (userId) => {
      const t = await ctx.livekit.mintRtcToken({
        userId,
        kind: 'video',
        id: callId,
        canPublish: true,
      });
      return {
        userId,
        token: t.token,
        url: t.url,
        roomName: t.roomName,
        identity: t.identity,
        canPublish: t.canPublish,
        expiresAt: t.expiresAt,
      };
    }),
  );
  return {
    call: {
      callId,
      hostUserId,
      participantUserIds: args.participantUserIds,
      status: 'live',
      startedAt: new Date().toISOString(),
      endedAt: null,
    },
    tokens,
  };
}

/** List the user's currently-live video calls (host or participant). */
export async function listMyVideoCalls(ctx: AppContext, userId: string): Promise<VideoCallRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      room_id: string;
      host_user_id: string;
      started_at: Date;
      ended_at: Date | null;
    }>(
      `SELECT vr.room_id, vr.host_user_id, vr.started_at, vr.ended_at
       FROM voice_rooms vr
       JOIN voice_speakers vs ON vs.room_id = vr.room_id AND vs.left_at IS NULL
       WHERE vr.kind = 'video' AND vr.status = 'live' AND vs.user_id = $1
       ORDER BY vr.started_at DESC LIMIT 50`,
      [userId],
    );
  });
  const out: VideoCallRow[] = [];
  for (const row of r.rows) {
    const ps = await ctx.db.withConnection(async (c) => {
      return c.query<{ user_id: string }>(
        `SELECT user_id FROM voice_speakers
         WHERE room_id = $1 AND left_at IS NULL AND role IN ('speaker','host')
         ORDER BY joined_at ASC`,
        [row.room_id],
      );
    });
    out.push({
      callId: row.room_id.replace(/^video:/, ''),
      hostUserId: row.host_user_id,
      participantUserIds: ps.rows.map((x) => x.user_id).filter((u) => u !== row.host_user_id),
      status: 'live',
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    });
  }
  return out;
}

/** End a video call. Host only. */
export async function endVideoCall(
  ctx: AppContext,
  callId: string,
  callerUserId: string,
): Promise<void> {
  const roomId = `video:${callId}`;
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ host_user_id: string; status: string }>(
      `SELECT host_user_id, status FROM voice_rooms WHERE room_id = $1`,
      [roomId],
    );
  });
  const room = r.rows[0];
  if (!room) throw new NotFoundError({ resource: 'video_call', id: callId });
  if (room.host_user_id !== callerUserId) {
    throw new ForbiddenError({ reason: 'only host can end call' });
  }
  if (room.status !== 'live') {
    throw new ValidationFailedError({ reason: 'call already ended' });
  }
  await runInTransaction(async (client) => {
    await client.query(
      `UPDATE voice_rooms SET status = 'ended', ended_at = now() WHERE room_id = $1`,
      [roomId],
    );
    await client.query(
      `UPDATE voice_speakers SET left_at = now()
       WHERE room_id = $1 AND left_at IS NULL`,
      [roomId],
    );
  });
  try {
    await ctx.livekit.endRoom(ctx, { kind: 'video', id: callId });
  } catch {
    /* best-effort */
  }
}
