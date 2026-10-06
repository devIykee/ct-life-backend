/**
 * Projects routes (M5 #65).
 *
 *   POST /v1/projects
 *   POST /v1/projects/{id}/hire
 *   POST /v1/projects/{id}/launch
 *   GET  /v1/projects/{id}
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { foundProject, getProject, hirePlayer, launchProject } from '../../application/projects.js';

const KINDS = ['memecoin', 'dex', 'nft_studio', 'perps_venue', 'l2'] as const;
const ROLES = ['dev', 'mod', 'kol', 'auditor'] as const;

const FoundBody = z.object({
  kind: z.enum(KINDS),
});

const HireBody = z.object({
  userId: z.string().uuid(),
  role: z.enum(ROLES),
  salaryCentsPerWeek: z.number().int().positive(),
});

/**
 * Register the projects routes.
 */
export function registerProjectRoutes(app: FastifyInstance): void {
  app.post('/v1/projects', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = FoundBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await foundProject(req.ctx, req.user!.sub, body.data.kind);
    return reply.status(201).send(out);
  });

  app.post(
    '/v1/projects/:id/hire',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = HireBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await hirePlayer(req.ctx, req.user!.sub, id, body.data);
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/projects/:id/launch',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await launchProject(req.ctx, req.user!.sub, id);
      return reply.send(out);
    },
  );

  app.get('/v1/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await getProject(req.ctx, id);
    return reply.send(out);
  });
}
