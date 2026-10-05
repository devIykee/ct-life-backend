/**
 * Paid-calls routes (M4 #51).
 *
 *   POST /v1/paid-calls
 *   POST /v1/paid-calls/:id/submitted
 *   POST /v1/paid-calls/:id/accept
 *   POST /v1/paid-calls/:id/decline
 *   POST /v1/paid-calls/:id/end
 *   GET  /v1/paid-calls/:id
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  acceptPaidCall,
  declinePaidCall,
  endPaidCall,
  loadPaidCall,
  startPaidCall,
  submitFundingSignature,
} from '../../application/paid-calls.js';

const StartBody = z.object({
  payeeUserId: z.string().uuid(),
  pricePerMinuteCents: z.number().int().min(25).max(5000),
  maxMinutes: z.number().int().min(1).max(240),
});

const SubmittedBody = z.object({
  signature: z.string().min(10).max(200),
});

const EndBody = z.object({
  secondsUsed: z.number().int().min(0),
});

export function registerPaidCallRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/paid-calls',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = StartBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await startPaidCall(req.ctx, req.user!.sub, body.data);
      return reply.status(201).send(out);
    },
  );

  app.post(
    '/v1/paid-calls/:id/submitted',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = SubmittedBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await submitFundingSignature(req.ctx, id, req.user!.sub, body.data.signature);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/paid-calls/:id/accept',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await acceptPaidCall(req.ctx, id, req.user!.sub);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/paid-calls/:id/decline',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const out = await declinePaidCall(req.ctx, id, req.user!.sub);
      return reply.send(out);
    },
  );

  app.post(
    '/v1/paid-calls/:id/end',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = EndBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const out = await endPaidCall(req.ctx, id, req.user!.sub, body.data.secondsUsed);
      return reply.send(out);
    },
  );

  app.get('/v1/paid-calls/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const out = await loadPaidCall(req.ctx, id);
    return reply.send(out);
  });
}
