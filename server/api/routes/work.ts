/**
 * Work routes.
 *
 *   GET  /v1/careers                     (?view=ladders: career ladders)
 *   POST /v1/careers/{ladderId}/join
 *   POST /v1/careers/{careerId}/apply
 *   POST /v1/shifts
 *   POST /v1/shifts/{shiftId}/complete
 *
 * The daily-clue routes live in `routes/daily-clue.ts`
 * (M5 #60). They were split out of this file when the
 * `DailyClueService` class was replaced with the M5 table-
 * backed free functions (`getToday`, `answer`, `seedClue`).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ShiftNotFinishedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { CareersService } from '../../application/careers.js';
import { ShiftsService } from '../../application/shifts.js';
import { getLadders, joinLadder } from '../../application/ladders.js';

const ApplyBody = z.object({}).optional();

const CareersQuery = z.object({ view: z.enum(['jobs', 'ladders']).default('jobs') });

const ShiftBody = z.object({ careerId: z.string().min(1) });

const ShiftCompleteBody = z.object({
  results: z.array(
    z.object({
      miniGameId: z.string().min(1),
      score: z.number().int().min(0),
    }),
  ),
});

/**
 *
 */
export function registerWorkRoutes(app: FastifyInstance): void {
  // GET /v1/careers
  app.get('/v1/careers', { preHandler: requireAuth }, async (req, reply) => {
    // `?view=ladders` is the career-ladder screen; the default stays the job list so
    // clients written against the job list keep working.
    const q = CareersQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    if (q.data.view === 'ladders') return reply.send(await getLadders(req.ctx, req.user!.sub));
    const svc = new CareersService(req.ctx);
    const list = await svc.list(req.user!.sub);
    return reply.send(list);
  });

  // POST /v1/careers/{careerId}/apply
  app.post(
    '/v1/careers/:careerId/apply',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { careerId } = req.params as { careerId: string };
      ApplyBody.parse(req.body);
      const svc = new CareersService(req.ctx);
      const job = await svc.apply(req.user!.sub, careerId);
      return reply.send(job);
    },
  );

  // POST /v1/careers/{ladderId}/join
  app.post(
    '/v1/careers/:ladderId/join',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { ladderId } = req.params as { ladderId: string };
      ApplyBody.parse(req.body);
      return reply.send(await joinLadder(req.ctx, req.user!.sub, ladderId));
    },
  );

  // POST /v1/shifts
  app.post('/v1/shifts', { preHandler: [requireAuth, withIdempotency()] }, async (req, reply) => {
    const body = ShiftBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const svc = new ShiftsService(req.ctx);
    const shift = await svc.start(req.user!.sub, body.data.careerId);
    return reply.send(shift);
  });

  // POST /v1/shifts/{shiftId}/complete
  app.post(
    '/v1/shifts/:shiftId/complete',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { shiftId } = req.params as { shiftId: string };
      const body = ShiftCompleteBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const svc = new ShiftsService(req.ctx);
      const result = await svc.complete(req.user!.sub, shiftId, body.data.results);
      return reply.send(result);
    },
  );
}

// Re-export for the ShiftNotFinishedError so the shift service throws
// it where applicable; the unused import here keeps the file
// self-documenting for the contract error.
export { ShiftNotFinishedError };
