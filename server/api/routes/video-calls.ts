/**
 * Video calls routes (M4 #50).
 *
 *   POST /v1/video-calls
 *   GET  /v1/video-calls
 *   POST /v1/video-calls/:id/end
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { endVideoCall, listMyVideoCalls, startVideoCall } from '../../application/video-calls.js';

const StartBody = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(7),
});

/**
 * Register M4 video-call routes.
 * @param app - The Fastify instance.
 */
export function registerVideoCallRoutes(app: FastifyInstance): void {
  // POST /v1/video-calls
  app.post(
    '/v1/video-calls',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = StartBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await startVideoCall(req.ctx, req.user!.sub, {
        participantUserIds: body.data.userIds,
      });
      return reply.status(201).send(out);
    },
  );

  // GET /v1/video-calls
  app.get('/v1/video-calls', { preHandler: requireAuth }, async (req, reply) => {
    const calls = await listMyVideoCalls(req.ctx, req.user!.sub);
    return reply.send({ calls });
  });

  // POST /v1/video-calls/:id/end
  app.post(
    '/v1/video-calls/:id/end',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await endVideoCall(req.ctx, id, req.user!.sub);
      return reply.status(204).send();
    },
  );
}
