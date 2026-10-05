/**
 * Spaces routes (M4 #49).
 *
 *   POST   /v1/spaces
 *   GET    /v1/spaces?live=true
 *   GET    /v1/spaces/:id
 *   POST   /v1/spaces/:id/hand
 *   DELETE /v1/spaces/:id/hand
 *   GET    /v1/spaces/:id/speakers
 *   POST   /v1/spaces/:id/speakers/:userId
 *   DELETE /v1/spaces/:id/speakers/:userId
 *   POST   /v1/spaces/:id/end
 *
 * Auth: every endpoint requires a Bearer token. Host-only
 * endpoints (`speakers/:userId` POST/DELETE and `end`) require
 * the caller to be the room's host; the service layer raises
 * ForbiddenError otherwise.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  createSpace,
  demoteSpeaker,
  endSpace,
  getSpace,
  getSpeakers,
  listLiveSpaces,
  lowerHand,
  promoteSpeaker,
  raiseHand,
} from '../../application/spaces.js';

const CreateBody = z.object({
  title: z.string().min(1).max(80),
});

const ListQuery = z.object({
  live: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v !== 'false'),
});

/**
 * Register M4 space routes.
 * @param app - The Fastify instance.
 */
export function registerSpaceRoutes(app: FastifyInstance): void {
  // POST /v1/spaces
  app.post('/v1/spaces', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const space = await createSpace(req.ctx, req.user!.sub, { title: body.data.title });
    return reply.status(201).send(space);
  });

  // GET /v1/spaces?live=true
  app.get('/v1/spaces', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    // For now the only public listing is the live set. An
    // `?includeEnded=true` option can be added in a later milestone.
    void q;
    const rows = await listLiveSpaces(req.ctx);
    return reply.send({ spaces: rows });
  });

  // GET /v1/spaces/:id
  app.get('/v1/spaces/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const space = await getSpace(req.ctx, id);
    return reply.send(space);
  });

  // POST /v1/spaces/:id/hand
  app.post(
    '/v1/spaces/:id/hand',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await raiseHand(req.ctx, id, req.user!.sub);
      return reply.status(204).send();
    },
  );

  // DELETE /v1/spaces/:id/hand
  app.delete(
    '/v1/spaces/:id/hand',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await lowerHand(req.ctx, id, req.user!.sub);
      return reply.status(204).send();
    },
  );

  // GET /v1/spaces/:id/speakers
  app.get('/v1/spaces/:id/speakers', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const speakers = await getSpeakers(req.ctx, id);
    return reply.send({ speakers });
  });

  // POST /v1/spaces/:id/speakers/:userId  (host promotes)
  app.post(
    '/v1/spaces/:id/speakers/:userId',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      await promoteSpeaker(req.ctx, id, req.user!.sub, userId);
      return reply.status(204).send();
    },
  );

  // DELETE /v1/spaces/:id/speakers/:userId  (host demotes)
  app.delete(
    '/v1/spaces/:id/speakers/:userId',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      await demoteSpeaker(req.ctx, id, req.user!.sub, userId);
      return reply.status(204).send();
    },
  );

  // POST /v1/spaces/:id/end  (host ends)
  app.post(
    '/v1/spaces/:id/end',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await endSpace(req.ctx, id, req.user!.sub);
      return reply.status(204).send();
    },
  );
}
