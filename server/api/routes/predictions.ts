/**
 * Prediction routes.
 *
 *   POST /v1/predictions
 *   GET  /v1/predictions?status=
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  listPredictions,
  placePrediction,
  type Horizon,
  type PredictionStatus,
} from '../../application/predictions.js';

const PlaceBody = z.object({
  outcomeId: z.string().min(1).max(64),
  stakeCents: z.number().int().positive(),
  horizon: z.enum(['5m', '15m', '1h', 'daily']),
});

const ListQuery = z.object({
  status: z.enum(['open', 'won', 'lost', 'cancelled']).optional(),
});

/**
 * Register prediction routes.
 * @param app - The Fastify instance.
 */
export function registerPredictionRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/predictions',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = PlaceBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const result = await placePrediction(req.ctx, {
        userId: req.user!.sub,
        outcomeId: body.data.outcomeId,
        stakeCents: body.data.stakeCents,
        horizon: body.data.horizon as Horizon,
      });
      return reply.status(201).send(result);
    },
  );

  app.get('/v1/predictions', { preHandler: requireAuth }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const predictions = await listPredictions(
      req.ctx,
      req.user!.sub,
      (q.data.status ?? null) as PredictionStatus | null,
    );
    return reply.send({ predictions });
  });
}
