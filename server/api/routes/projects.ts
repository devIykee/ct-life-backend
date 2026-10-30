/**
 * Projects routes (Builder).
 *
 *   GET    /v1/projects?scope=mine|hiring|all
 *   POST   /v1/projects
 *   GET    /v1/projects/{id}
 *   GET    /v1/me/project-offers
 *   GET    /v1/vc-row/deals
 *   POST   /v1/projects/{id}/hire                 410 GONE {reason:'use_offers'}
 *
 * Behind the `builder` capability (503 CAPABILITY_OFF until it is in
 * CAPABILITIES_ON):
 *
 *   POST   /v1/projects/{id}/offers
 *   POST   /v1/project-offers/{offerId}/accept
 *   POST   /v1/project-offers/{offerId}/decline
 *   POST   /v1/projects/{id}/fund
 *   DELETE /v1/projects/{id}/members/{userId}
 *   GET    /v1/projects/{id}/launch-quote
 *   POST   /v1/projects/{id}/launch
 *   GET    /v1/projects/{id}/events
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { GoneError, ValidationFailedError } from '../../shared/domain/errors.js';
import { HIRE_ROLES, PROJECT_KINDS } from '../../shared/domain/projects.js';
import {
  foundProject,
  fundProject,
  getProject,
  listProjects,
  listVcDeals,
  removeMember,
} from '../../application/projects.js';
import {
  acceptOffer,
  createOffer,
  declineOffer,
  listMyProjectOffers,
} from '../../application/project-offers.js';
import { getLaunchQuote, launchProject } from '../../application/project-launch.js';
import { listProjectEvents } from '../../application/project-events.js';

const FoundBody = z.object({
  kind: z.enum(PROJECT_KINDS),
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

const OfferBody = z.object({
  userId: z.string().uuid(),
  role: z.enum(HIRE_ROLES),
  salaryCentsPerWeek: z.number().int().positive(),
});

const FundBody = z.object({ cashCents: z.number().int().positive() });

const LaunchBody = z.object({
  ticker: z.string().regex(/^[A-Z0-9]{2,8}$/),
  quotedCostCents: z.number().int().nonnegative(),
});

const EventsQuery = z.object({
  cursor: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ValidationFailedError({ issues: r.error.issues });
  return r.data;
}

const builder = requireCapability('builder');

/**
 * Register the projects routes.
 */
export function registerProjectRoutes(app: FastifyInstance): void {
  app.get('/v1/me/project-offers', { preHandler: requireAuth }, async (req, reply) => {
    const q = parse(OfferQuery, req.query);
    const offers = await listMyProjectOffers(req.ctx, req.user!.sub, q.status ?? null, q.limit);
    return reply.send({ offers, nextCursor: null });
  });

  app.get('/v1/vc-row/deals', { preHandler: requireAuth }, async (req, reply) => {
    const q = parse(DealQuery, req.query);
    return reply.send({ deals: await listVcDeals(req.ctx, q.limit), nextCursor: null });
  });

  app.get('/v1/projects', { preHandler: requireAuth }, async (req, reply) => {
    const q = parse(ListQuery, req.query);
    const projects = await listProjects(req.ctx, req.user!.sub, q.scope, q.limit);
    return reply.send({ projects, nextCursor: null });
  });

  app.post('/v1/projects', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = parse(FoundBody, req.body);
    const out = await foundProject(req.ctx, req.user!.sub, body.kind, body.name, body.ticker);
    return reply.status(201).send(out);
  });

  // Direct hiring debited the founder and credited the hire without consent
  // (Cash between players). Gone for good, whatever the capability says.
  app.post('/v1/projects/:id/hire', { preHandler: requireAuth }, async () => {
    throw new GoneError({ reason: 'use_offers', use: 'POST /v1/projects/{id}/offers' });
  });

  app.post(
    '/v1/projects/:id/offers',
    { preHandler: [builder, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parse(OfferBody, req.body);
      return reply.status(201).send(await createOffer(req.ctx, req.user!.sub, id, body));
    },
  );

  app.post(
    '/v1/project-offers/:offerId/accept',
    { preHandler: [builder, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { offerId } = req.params as { offerId: string };
      return reply.send(await acceptOffer(req.ctx, req.user!.sub, offerId));
    },
  );

  app.post(
    '/v1/project-offers/:offerId/decline',
    { preHandler: [builder, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { offerId } = req.params as { offerId: string };
      return reply.send(await declineOffer(req.ctx, req.user!.sub, offerId));
    },
  );

  app.post(
    '/v1/projects/:id/fund',
    { preHandler: [builder, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parse(FundBody, req.body);
      return reply.send(await fundProject(req.ctx, req.user!.sub, id, body.cashCents));
    },
  );

  app.delete(
    '/v1/projects/:id/members/:userId',
    { preHandler: [builder, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id, userId } = req.params as { id: string; userId: string };
      await removeMember(req.ctx, req.user!.sub, id, userId);
      return reply.status(204).send();
    },
  );

  app.get(
    '/v1/projects/:id/launch-quote',
    { preHandler: [builder, requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      return reply.send(await getLaunchQuote(req.ctx, req.user!.sub, id));
    },
  );

  app.post(
    '/v1/projects/:id/launch',
    { preHandler: [builder, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = parse(LaunchBody, req.body);
      return reply.send(await launchProject(req.ctx, req.user!.sub, id, body));
    },
  );

  app.get('/v1/projects/:id/events', { preHandler: [builder, requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = parse(EventsQuery, req.query);
    return reply.send(await listProjectEvents(req.ctx, id, q.cursor ?? null, q.limit));
  });

  app.get('/v1/projects/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(await getProject(req.ctx, id));
  });
}
