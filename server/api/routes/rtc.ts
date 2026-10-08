/**
 * RTC (Real-Time Communication) routes.
 *
 *   POST /v1/rtc/token
 *
 * Returns a LiveKit token for proximity voice, Space audio, or call media.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
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
  // POST /v1/rtc/token - B23
  app.post('/v1/rtc/token', { preHandler: requireAuth }, async (req, reply) => {
    const body = RtcTokenBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });

    const result = await req.ctx.livekit.mintRtcToken({
      userId: req.user!.sub,
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
