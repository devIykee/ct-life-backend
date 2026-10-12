/**
 * Spaces service (audio rooms).
 *
 * Endpoints:
 *
 *   POST   /v1/spaces                       — create a space; mints
 *                                            the host token, sets
 *                                            voice_rooms row, adds the
 *                                            host as the first speaker
 *   GET    /v1/spaces?live=true             — list live spaces (50/page)
 *   GET    /v1/spaces/{id}                  — get a space
 *   POST   /v1/spaces/{id}/hand             — raise hand (listener)
 *   DELETE /v1/spaces/{id}/hand             — lower hand
 *   GET    /v1/spaces/{id}/speakers         — current speakers
 *   POST   /v1/spaces/{id}/speakers/{userId}  — host promotes
 *   DELETE /v1/spaces/{id}/speakers/{userId}  — host demotes
 *   POST   /v1/spaces/{id}/end              — host ends the space
 *
 * Concurrency: the host promotion/demote/end paths are server-side
 * state changes plus a LiveKit permission mutation. We run the
 * DB mutation inside `runInTransaction` so the row, the speaker
 * record, and the hand queue stay consistent. LiveKit errors do
 * not roll back the DB state — the Spaces Room (server/realtime
 * rooms/space.ts) re-syncs from the DB if the SDK fails.
 *
 * Capacity: 200 spaces per realtime instance (per
 * docs/CAPACITY.md), each with up to 8 speakers. The voice_rooms
 * row's `max_speakers` defaults to 8 (enforced by the DB CHECK).
 * Promotion beyond `max_speakers` is rejected with VALIDATION_FAILED.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  ForbiddenError,
  NotFoundError,
  ServerBusyError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { canonicalRoomName } from '../shared/livekit/token.js';
import type { AppContext } from './context.js';

export interface SpaceRow {
  readonly spaceId: string;
  readonly hostUserId: string;
  readonly title: string;
  readonly status: 'live' | 'ended';
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly maxSpeakers: number;
  readonly speakerUserIds: string[];
  readonly handUserIds: string[];
  readonly listenerCount: number;
}

export interface CreateSpaceArgs {
  readonly title: string;
}

const TITLE_MAX = 80;
/** Space join tokens are short-lived so a new token re-checks role and status. */
export const SPACE_TOKEN_TTL_SEC = 10 * 60;
const LIVEKIT_SYNC_ATTEMPTS = 3;

/** Normalize a bare uuid or `space:<uuid>` to the stored room id. */
export function spaceRoomId(id: string): string {
  const name = canonicalRoomName('space', id);
  if (!name) throw new ValidationFailedError({ reason: 'invalid_space_id' });
  return name;
}

async function selectRoom(
  ctx: AppContext,
  spaceId: string,
): Promise<{
  host: string;
  status: 'live' | 'ended';
  startedAt: Date;
  endedAt: Date | null;
  title: string;
  maxSpeakers: number;
} | null> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{
      host_user_id: string;
      status: 'live' | 'ended';
      started_at: Date;
      ended_at: Date | null;
      title: string;
      max_speakers: number;
    }>(
      `SELECT host_user_id, status, started_at, ended_at, title, max_speakers
       FROM voice_rooms WHERE room_id = $1 AND kind = 'space'`,
      [spaceId],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      host: row.host_user_id,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      title: row.title,
      maxSpeakers: row.max_speakers,
    };
  });
}

/** Create a space; the host is added as a 'host' speaker row. */
export async function createSpace(
  ctx: AppContext,
  hostUserId: string,
  args: CreateSpaceArgs,
): Promise<SpaceRow> {
  void ctx;
  if (args.title.length < 1 || args.title.length > TITLE_MAX) {
    throw new ValidationFailedError({ reason: 'title length 1..80' });
  }
  const spaceId = `space:${uuidv7()}`;
  const speakerId = uuidv7();
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO voice_rooms (room_id, host_user_id, kind, title)
       VALUES ($1, $2, 'space', $3)`,
      [spaceId, hostUserId, args.title],
    );
    await client.query(
      `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
       VALUES ($1, $2, $3, 'host')`,
      [speakerId, spaceId, hostUserId],
    );
  });
  return {
    spaceId,
    hostUserId,
    title: args.title,
    status: 'live',
    startedAt: new Date().toISOString(),
    endedAt: null,
    maxSpeakers: 8,
    speakerUserIds: [hostUserId],
    handUserIds: [],
    listenerCount: 0,
  };
}

/** List live spaces, newest first, 50/page. */
export async function listLiveSpaces(ctx: AppContext): Promise<SpaceRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      room_id: string;
      host_user_id: string;
      title: string;
      started_at: Date;
      max_speakers: number;
    }>(
      `SELECT room_id, host_user_id, title, started_at, max_speakers
       FROM voice_rooms WHERE kind = 'space' AND status = 'live'
       ORDER BY started_at DESC LIMIT 50`,
    );
  });
  return Promise.all(
    r.rows.map(async (row) => {
      const speakers = await listSpeakers(ctx, row.room_id);
      const hand = await listHand(ctx, row.room_id);
      return {
        spaceId: row.room_id,
        hostUserId: row.host_user_id,
        title: row.title,
        status: 'live' as const,
        startedAt: row.started_at.toISOString(),
        endedAt: null,
        maxSpeakers: row.max_speakers,
        speakerUserIds: speakers.map((s) => s.userId),
        handUserIds: hand.map((h) => h.userId),
        listenerCount: await countListeners(ctx, row.room_id),
      };
    }),
  );
}

/** Look up a single space. Throws NotFoundError if missing. */
export async function getSpace(ctx: AppContext, rawSpaceId: string): Promise<SpaceRow> {
  const spaceId = spaceRoomId(rawSpaceId);
  const row = await selectRoom(ctx, spaceId);
  if (!row) {
    throw new NotFoundError({ resource: 'space', id: spaceId });
  }
  const speakers = await listSpeakers(ctx, spaceId);
  const hand = await listHand(ctx, spaceId);
  return {
    spaceId,
    hostUserId: row.host,
    title: row.title,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    maxSpeakers: row.maxSpeakers,
    speakerUserIds: speakers.map((s) => s.userId),
    handUserIds: hand.map((h) => h.userId),
    listenerCount: await countListeners(ctx, spaceId),
  };
}

interface SpeakerRow {
  readonly speakerId: string;
  readonly userId: string;
  readonly role: 'host' | 'speaker' | 'listener';
  readonly joinedAt: string;
  readonly handRaisedAt: string | null;
}

async function listSpeakers(ctx: AppContext, spaceId: string): Promise<SpeakerRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      speaker_id: string;
      user_id: string;
      role: 'host' | 'speaker' | 'listener';
      joined_at: Date;
      hand_raised_at: Date | null;
    }>(
      `SELECT speaker_id, user_id, role, joined_at, hand_raised_at
       FROM voice_speakers
       WHERE room_id = $1 AND left_at IS NULL AND role IN ('host', 'speaker')
       ORDER BY joined_at ASC`,
      [spaceId],
    );
  });
  return r.rows.map((row) => ({
    speakerId: row.speaker_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
    handRaisedAt: row.hand_raised_at ? row.hand_raised_at.toISOString() : null,
  }));
}

async function listHand(ctx: AppContext, spaceId: string): Promise<SpeakerRow[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      speaker_id: string;
      user_id: string;
      role: 'host' | 'speaker' | 'listener';
      joined_at: Date;
      hand_raised_at: Date;
    }>(
      `SELECT speaker_id, user_id, role, joined_at, hand_raised_at
       FROM voice_speakers
       WHERE room_id = $1 AND left_at IS NULL AND hand_raised_at IS NOT NULL
       ORDER BY hand_raised_at ASC`,
      [spaceId],
    );
  });
  return r.rows.map((row) => ({
    speakerId: row.speaker_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at.toISOString(),
    handRaisedAt: row.hand_raised_at.toISOString(),
  }));
}

async function countListeners(ctx: AppContext, spaceId: string): Promise<number> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM voice_speakers
       WHERE room_id = $1 AND left_at IS NULL AND role = 'listener'`,
      [spaceId],
    );
    return Number(r.rows[0]?.count ?? '0');
  });
}

/**
 * Listener raises their hand. The row is upserted: a hand from a
 * previous session is updated; a new listener creates one. The
 * UNIQUE (room_id, user_id) WHERE left_at IS NULL ensures we
 * don't double-write.
 */
export async function raiseHand(
  ctx: AppContext,
  rawSpaceId: string,
  userId: string,
): Promise<void> {
  const spaceId = spaceRoomId(rawSpaceId);
  const room = await selectRoom(ctx, spaceId);
  if (!room) throw new NotFoundError({ resource: 'space', id: spaceId });
  if (room.status !== 'live') {
    throw new ValidationFailedError({ reason: 'space is not live' });
  }
  await runInTransaction(async (client) => {
    // Upsert: if the user already has an open listener row, flip
    // hand_raised_at; else insert.
    await client.query(
      `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role, hand_raised_at)
       VALUES ($1, $2, $3, 'listener', now())
       ON CONFLICT (room_id, user_id) WHERE left_at IS NULL
       DO UPDATE SET hand_raised_at = now()`,
      [uuidv7(), spaceId, userId],
    );
  });
}

/** Lower your hand. */
export async function lowerHand(
  ctx: AppContext,
  rawSpaceId: string,
  userId: string,
): Promise<void> {
  const spaceId = spaceRoomId(rawSpaceId);
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `UPDATE voice_speakers SET hand_raised_at = NULL
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [spaceId, userId],
    );
  });
}

/** List current speakers. Public read. */
export async function getSpeakers(ctx: AppContext, rawSpaceId: string): Promise<SpeakerRow[]> {
  const spaceId = spaceRoomId(rawSpaceId);
  return listSpeakers(ctx, spaceId);
}

/**
 * Host promotes a listener (or themselves on initial join) to a
 * speaker. Throws ForbiddenError if the caller is not the host.
 * Throws ValidationFailedError if max_speakers is hit.
 */
export async function promoteSpeaker(
  ctx: AppContext,
  rawSpaceId: string,
  callerUserId: string,
  targetUserId: string,
): Promise<void> {
  const spaceId = spaceRoomId(rawSpaceId);
  const room = await selectRoom(ctx, spaceId);
  if (!room) throw new NotFoundError({ resource: 'space', id: spaceId });
  if (room.host !== callerUserId) {
    throw new ForbiddenError({ reason: 'NOT_SPACE_HOST' });
  }
  if (room.status !== 'live') {
    throw new ValidationFailedError({ reason: 'space is not live' });
  }
  if (await blockedBetween(ctx, room.host, targetUserId)) {
    throw new ForbiddenError({ reason: 'blocked' });
  }
  await runInTransaction(async (client) => {
    const target = await client.query<{ role: string }>(
      `SELECT role FROM voice_speakers
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL FOR UPDATE`,
      [spaceId, targetUserId],
    );
    const role = target.rows[0]?.role;
    if (role === 'host' || role === 'speaker') return;
    const cur = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM voice_speakers
       WHERE room_id = $1 AND left_at IS NULL AND role IN ('host','speaker')`,
      [spaceId],
    );
    if (Number(cur.rows[0]?.count ?? '0') >= room.maxSpeakers) {
      throw new ValidationFailedError({ reason: 'max_speakers reached' });
    }
    if (role === undefined) {
      await client.query(
        `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
         VALUES ($1, $2, $3, 'speaker')`,
        [uuidv7(), spaceId, targetUserId],
      );
    } else {
      await client.query(
        `UPDATE voice_speakers SET role = 'speaker', hand_raised_at = NULL
         WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [spaceId, targetUserId],
      );
    }
  });
  // The DB role is authoritative; a failed LiveKit update surfaces as
  // SERVER_BUSY so the host retries (promotion is idempotent).
  await syncLiveKit(() =>
    ctx.livekit.setParticipantCanPublish(ctx, {
      kind: 'space',
      id: spaceId,
      identity: targetUserId,
      canPublish: true,
    }),
  );
}

/** Host demotes a speaker back to listener. */
export async function demoteSpeaker(
  ctx: AppContext,
  rawSpaceId: string,
  callerUserId: string,
  targetUserId: string,
): Promise<void> {
  const spaceId = spaceRoomId(rawSpaceId);
  const room = await selectRoom(ctx, spaceId);
  if (!room) throw new NotFoundError({ resource: 'space', id: spaceId });
  if (room.host !== callerUserId) {
    throw new ForbiddenError({ reason: 'NOT_SPACE_HOST' });
  }
  if (room.host === targetUserId) {
    throw new ValidationFailedError({ reason: 'cannot demote host' });
  }
  await ctx.db.withConnection(async (c) => {
    await c.query(
      `UPDATE voice_speakers SET role = 'listener'
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [spaceId, targetUserId],
    );
  });
  // Revoking canPublish also unpublishes the member's tracks.
  await syncLiveKit(() =>
    ctx.livekit.setParticipantCanPublish(ctx, {
      kind: 'space',
      id: spaceId,
      identity: targetUserId,
      canPublish: false,
    }),
  );
}

/** End the space; close every open speaker row, close LiveKit room. */
export async function endSpace(
  ctx: AppContext,
  rawSpaceId: string,
  callerUserId: string,
): Promise<void> {
  const spaceId = spaceRoomId(rawSpaceId);
  const room = await selectRoom(ctx, spaceId);
  if (!room) throw new NotFoundError({ resource: 'space', id: spaceId });
  if (room.host !== callerUserId) {
    throw new ForbiddenError({ reason: 'NOT_SPACE_HOST' });
  }
  await runInTransaction(async (client) => {
    await client.query(
      `UPDATE voice_rooms SET status = 'ended', ended_at = now() WHERE room_id = $1`,
      [spaceId],
    );
    await client.query(
      `UPDATE voice_speakers SET left_at = now()
       WHERE room_id = $1 AND left_at IS NULL`,
      [spaceId],
    );
  });
  // Ended Spaces mint no tokens; closing the media room is retried by
  // repeating the (idempotent) end call.
  await syncLiveKit(() => ctx.livekit.endRoom(ctx, { kind: 'space', id: spaceId }));
}

/**
 * Server-derived RTC access for a Space. Only a live Space the caller is
 * not blocked from yields a token; host and speaker rows may publish,
 * everyone else joins subscribe-only. Client permission flags are ignored.
 */
export async function spaceRtcAccess(
  ctx: AppContext,
  rawSpaceId: string,
  userId: string,
): Promise<{ spaceId: string; canPublish: boolean }> {
  const spaceId = spaceRoomId(rawSpaceId);
  const room = await selectRoom(ctx, spaceId);
  if (!room) throw new NotFoundError({ resource: 'space', id: spaceId });
  if (room.status !== 'live') throw new ForbiddenError({ reason: 'space_ended' });
  if (await blockedBetween(ctx, room.host, userId)) {
    throw new ForbiddenError({ reason: 'blocked' });
  }
  const r = await ctx.db.withConnection((c) =>
    c.query<{ role: string }>(
      `SELECT role FROM voice_speakers
       WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
      [spaceId, userId],
    ),
  );
  const role = r.rows[0]?.role;
  return { spaceId, canPublish: role === 'host' || role === 'speaker' };
}

async function blockedBetween(ctx: AppContext, a: string, b: string): Promise<boolean> {
  if (a === b) return false;
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `SELECT 1 FROM blocks
       WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
          OR (blocker_user_id = $2 AND blocked_user_id = $1)
       LIMIT 1`,
      [a, b],
    ),
  );
  return (r.rowCount ?? 0) > 0;
}

async function syncLiveKit(op: () => Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= LIVEKIT_SYNC_ATTEMPTS; attempt++) {
    try {
      await op();
      return;
    } catch (e) {
      last = e;
      if (attempt < LIVEKIT_SYNC_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  throw new ServerBusyError(2000, {
    reason: 'livekit_sync',
    cause: last instanceof Error ? last.message : String(last),
  });
}
