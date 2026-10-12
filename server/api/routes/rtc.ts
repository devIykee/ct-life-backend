/**
 * RTC (Real-Time Communication) routes.
 *
 *   POST /v1/rtc/token
 *
 * Returns a LiveKit token for proximity voice, Space audio, or call media.
 * B3: Validates user is participant of the room before minting token.
 * Publish permission is always server-derived; client flags are ignored.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { ForbiddenError, ValidationFailedError } from '../../shared/domain/errors.js';
import type { RtcKind } from '../../application/livekit.js';
import { SPACE_TOKEN_TTL_SEC, spaceRtcAccess } from '../../application/spaces.js';
import { canonicalRoomName } from '../../shared/livekit/token.js';

// The contract body is `{kind, id}`. `roomId` is accepted as a
// deprecated alias so callers written against the old server keep
// working. `kind` stays a superset of the contract's
// [venue, space, call]: video and paid_call are used by the call flow.
// canPublish/canSubscribe are still parsed for old clients but ignored.
const RtcTokenBody = z
  .object({
    kind: z.enum(['proximity', 'space', 'call', 'venue', 'video', 'paid_call']),
    id: z.string().min(1).max(128).optional(),
    roomId: z.string().min(1).max(128).optional(),
    canPublish: z.boolean().optional(),
    canSubscribe: z.boolean().optional(),
  })
  .refine((b) => (b.id ?? b.roomId) !== undefined, {
    message: 'id is required',
    path: ['id'],
  })
  .transform((b) => ({ ...b, id: (b.id ?? b.roomId)! }));

/**
 * Register RTC routes.
 * @param app - The Fastify instance.
 */
export function registerRtcRoutes(app: FastifyInstance): void {
  // POST /v1/rtc/token - B23 with B3 validation
  app.post('/v1/rtc/token', { preHandler: requireAuth }, async (req, reply) => {
    const body = RtcTokenBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });

    const userId = req.user!.sub;
    const { kind } = body.data;
    let id = body.data.id;
    let canPublish: boolean | undefined;
    let ttlSec: number | undefined;

    if (kind === 'space') {
      const access = await spaceRtcAccess(req.ctx, id, userId);
      id = access.spaceId;
      canPublish = access.canPublish;
      ttlSec = SPACE_TOKEN_TTL_SEC;
    }

    // B3: Validate user is a participant for call/video kinds
    if (kind === 'call' || kind === 'video' || kind === 'paid_call') {
      const roomName = canonicalRoomName(kind, id);
      if (!roomName) throw new ValidationFailedError({ reason: 'invalid_room_id', kind });
      const check = await req.ctx.db.withConnection(async (c) => {
        return c.query(
          `SELECT 1 FROM voice_speakers vs
           JOIN voice_rooms vr ON vr.room_id = vs.room_id
           WHERE vs.room_id = $1 AND vs.user_id = $2 AND vs.left_at IS NULL
             AND vr.status = 'live'
           LIMIT 1`,
          [roomName, userId],
        );
      });
      if (check.rowCount === 0) {
        throw new ForbiddenError({ reason: 'not_participant', id });
      }
    }

    const result = await req.ctx.livekit.mintRtcToken({
      userId,
      kind: kind as RtcKind,
      id,
      canPublish,
      ttlSec,
    });

    return reply.send({
      token: result.token,
      url: result.url,
      roomName: result.roomName,
      identity: result.identity,
      // The contract types expiresAt as a date-time string; the issuer
      // works in epoch seconds.
      expiresAt: new Date(result.expiresAt * 1000).toISOString(),
      canPublish: result.canPublish,
    });
  });
}
