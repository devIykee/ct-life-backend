/**
 * RTC (Real-Time Communication) routes.
 *
 *   POST /v1/rtc/token
 *
 * Returns a LiveKit token for proximity voice, Space audio, or call media.
 * B3: Validates user is participant of the room before minting token.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { ForbiddenError, ValidationFailedError } from '../../shared/domain/errors.js';
import type { RtcKind } from '../../application/livekit.js';

// The contract body is `{kind, id}`. `roomId` is accepted as a
// deprecated alias so callers written against the old server keep
// working. `kind` stays a superset of the contract's
// [venue, space, call]: video and paid_call are used by the call flow.
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
    const { kind, id } = body.data;

    // B3: Validate user is a participant for call/video kinds
    if (kind === 'call' || kind === 'video' || kind === 'paid_call') {
      const roomName = `${kind}:${id}`;
      const check = await req.ctx.db.withConnection(async (c) => {
        return c.query(
          `SELECT 1 FROM voice_speakers
           WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL
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
      kind: body.data.kind as RtcKind,
      id: body.data.id,
      canPublish: body.data.canPublish,
      canSubscribe: body.data.canSubscribe,
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
