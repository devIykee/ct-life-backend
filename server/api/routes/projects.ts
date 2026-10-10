/**
 * Projects routes (M5 #65).
 *
 *   GET  /v1/projects?scope=mine|hiring|all
 *   GET  /v1/me/project-offers
 *   GET  /v1/vc-row/deals
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
import {
  foundProject,
  getProject,
  hirePlayer,
  launchProject,
  listMyProjectOffers,
  listProjects,
  listVcDeals,
} from '../../application/projects.js';

const KINDS = ['memecoin', 'dex', 'nft_studio', 'perps_venue', 'l2'] as const;
const ROLES = ['dev', 'mod', 'kol', 'auditor'] as const;

const FoundBody = z.object({
  kind: z.enum(KINDS),
  // The spec adds name and an optional ticker to POST /v1/projects.
  name: z.string().min(1).max(40).optional(),
  ticker: z.string().min(1).max(12).optional(),
});

const OfferQuery = z.object({
  status: z.enum(['pending', 'accepted', 'declined', 'expired', 'withdrawn']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const DealQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const ListQuery = z.object({
  scope: z.enum(['mine', 'hiring', 'all']).default('mine'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
  // GET /v1/me/project-offers - was 404 "No route".
  app.get('/v1/me/project-offers', { preHandler: requireAuth }, async (req, reply) => {
    const q = OfferQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const offers = await listMyProjectOffers(
      req.ctx,
      req.user!.sub,
      q.data.status ?? null,
      q.data.limit,
    );
    return reply.send({ offers, nextCursor: null });
  });

  // GET /v1/vc-row/deals - was 404 "No route".
  app.get('/v1/vc-row/deals', { preHandler: requireAuth }, async (req, reply) => {
    const q = DealQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send({ deals: await listVcDeals(req.ctx, q.data.limit), nextCursor: null });
  });

  // GET /v1/projects - the Builder Hills boards. Was never registered, so
  // every scope answered 404 "No route".
  app.get('/v1/projects', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const projects = await listProjects(req.ctx, req.user!.sub, q.data.scope, q.data.limit);
    return reply.send({ projects, nextCursor: null });
  });

  app.post('/v1/projects', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = FoundBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const out = await foundProject(
      req.ctx,
      req.user!.sub,
      body.data.kind,
      body.data.name,
      body.data.ticker,
    );
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
