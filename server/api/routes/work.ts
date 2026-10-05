/**
 * Work routes.
 *
 *   GET  /v1/careers
 *   POST /v1/careers/{careerId}/apply
 *   POST /v1/shifts
 *   POST /v1/shifts/{shiftId}/complete
 *
 *   GET  /v1/daily-clue
 *   POST /v1/daily-clue/answer
 *
 * M2 supports the first three careers (Discord Mod, Reply Guy,
 * Spaces Host) by reading contract/config/careers.json. Shifts
 * are scored against contract/ids/mini_games.json. The complete
 * endpoint enforces the SHIFT_NOT_FINISHED contract: the shift's
 * endsAt must be in the past.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ShiftNotFinishedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { CareersService } from '../../application/careers.js';
import { ShiftsService } from '../../application/shifts.js';
import { DailyClueService } from '../../application/daily-clue.js';

const ApplyBody = z.object({}).optional();

const ShiftBody = z.object({ careerId: z.string().min(1) });

const ShiftCompleteBody = z.object({
  results: z.array(
    z.object({
      miniGameId: z.string().min(1),
      score: z.number().int().min(0),
    }),
  ),
});

const DailyClueAnswerBody = z.object({ answer: z.string().min(1).max(80) });

/**
 *
 */
export function registerWorkRoutes(app: FastifyInstance): void {
  // GET /v1/careers
  app.get('/v1/careers', { preHandler: requireAuth }, async (req, reply) => {
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

  // GET /v1/daily-clue
  app.get('/v1/daily-clue', { preHandler: requireAuth }, async (req, reply) => {
    const svc = new DailyClueService(req.ctx);
    const clue = await svc.getToday(req.user!.sub);
    return reply.send(clue);
  });

  // POST /v1/daily-clue/answer
  app.post(
    '/v1/daily-clue/answer',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = DailyClueAnswerBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const svc = new DailyClueService(req.ctx);
      const result = await svc.answer(req.user!.sub, body.data.answer);
      return reply.send(result);
    },
  );
}

// Re-export for the ShiftNotFinishedError so the shift service throws
// it where applicable; the unused import here keeps the file
// self-documenting for the contract error.
export { ShiftNotFinishedError };
