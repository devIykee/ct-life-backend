/**
 * Daily clue routes (M5 #60).
 *
 *   GET  /v1/daily-clue
 *   POST /v1/daily-clue/answer
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { answer, getToday } from '../../application/daily-clue.js';

const AnswerBody = z.object({
  attempt: z.string().min(1).max(200),
});

/**
 * Register the daily-clue routes.
 */
export function registerDailyClueRoutes(app: FastifyInstance): void {
  app.get('/v1/daily-clue', { preHandler: requireAuth }, async (req, reply) => {
    const out = await getToday(req.ctx);
    return reply.send(out);
  });

  app.post(
    '/v1/daily-clue/answer',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = AnswerBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await answer(req.ctx, req.user!.sub, body.data.attempt);
      return reply.send(out);
    },
  );
}
