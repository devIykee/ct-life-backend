/**
 * Creator routes (M4 #51).
 *
 *   POST  /v1/creator
 *   GET   /v1/creator/:handle
 *   PATCH /v1/creator
 *   PUT   /v1/creator   creator mode for paid calls (unlock C2; capability creatorMode)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  createCreator,
  getCreatorByHandle,
  putCreatorMode,
  updateCreator,
} from '../../application/creator.js';
import { requireCapability } from '../middleware/capability.js';

const CreateBody = z.object({
  handle: z.string().min(3).max(32),
  bio: z.string().max(500).optional(),
  categories: z.array(z.string()).max(10).optional(),
});

const PatchBody = z.object({
  bio: z.string().max(500).optional(),
  bannerImageKey: z.string().nullable().optional(),
  avatarImageKey: z.string().nullable().optional(),
  categories: z.array(z.string()).max(10).optional(),
});

const ModeBody = z
  .object({
    enabled: z.boolean(),
    ratePerMinUsdc: z.string().max(12),
    maxMinutes: z.number().int(),
  })
  .strict();

/**
 * Register creator profile routes.
 * @param app - The Fastify instance.
 */
export function registerCreatorRoutes(app: FastifyInstance): void {
  app.post('/v1/creator', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = CreateBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await createCreator(req.ctx, req.user!.sub, body.data);
    return reply.status(201).send(out);
  });

  app.get('/v1/creator/:handle', { preHandler: requireAuth }, async (req, reply) => {
    const { handle } = req.params as { handle: string };
    const out = await getCreatorByHandle(req.ctx, handle);
    return reply.send(out);
  });

  app.patch('/v1/creator', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = PatchBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await updateCreator(req.ctx, req.user!.sub, body.data);
    return reply.send(out);
  });

  app.put(
    '/v1/creator',
    { preHandler: [requireCapability('creatorMode'), requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = ModeBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(await putCreatorMode(req.ctx, req.user!.sub, body.data));
    },
  );
}
