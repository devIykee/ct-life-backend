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

const RtcTokenBody = z.object({
  kind: z.enum(['proximity', 'space', 'call', 'venue', 'video', 'paid_call']),
  roomId: z.string().min(1).max(128),
  canPublish: z.boolean().optional(),
  canSubscribe: z.boolean().optional(),
});

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
    const { kind, roomId } = body.data;

    // B3: Validate user is a participant for call/video kinds
    if (kind === 'call' || kind === 'video' || kind === 'paid_call') {
      const roomName = `${kind}:${roomId}`;
      const check = await req.ctx.db.withConnection(async (c) => {
        return c.query(
          `SELECT 1 FROM voice_speakers
           WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL
           LIMIT 1`,
          [roomName, userId],
        );
      });
      if (check.rowCount === 0) {
        throw new ForbiddenError({ reason: 'not_participant', roomId });
      }
    }

    const result = await req.ctx.livekit.mintRtcToken({
      userId,
      kind: body.data.kind as RtcKind,
      id: body.data.roomId,
      canPublish: body.data.canPublish,
      canSubscribe: body.data.canSubscribe,
    });

    return reply.send({
      token: result.token,
      url: result.url,
      roomName: result.roomName,
      identity: result.identity,
      expiresAt: result.expiresAt,
      canPublish: result.canPublish,
    });
  });
}
