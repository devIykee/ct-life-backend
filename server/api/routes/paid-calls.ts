/**
 * Paid-calls routes (unlock C2; capability `paidCalls`, devnet only). See
 * server/application/paid-calls.ts for the flow and the money rules.
 *
 *   POST /v1/paid-calls                {creatorId, minutes}
 *   POST /v1/paid-calls/:id/submitted  {signature}
 *   POST /v1/paid-calls/:id/accept
 *   POST /v1/paid-calls/:id/decline
 *   POST /v1/paid-calls/:id/end        (no body: the server times the call)
 *   GET  /v1/paid-calls/:id
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  acceptPaidCall,
  declinePaidCall,
  endPaidCall,
  getPaidCall,
  startPaidCall,
  submitOpenSignature,
} from '../../application/paid-calls.js';

const StartBody = z
  .object({ creatorId: z.string().uuid(), minutes: z.number().int().min(1).max(60) })
  .strict();
const SubmittedBody = z.object({ signature: z.string().min(64).max(100) }).strict();
const Params = z.object({ id: z.string().uuid() });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationFailedError({ issues: r.error.issues });
  return r.data;
}

/**
 * Register the paid-call routes.
 * @param app - The Fastify instance.
 */
export function registerPaidCallRoutes(app: FastifyInstance): void {
  const write = { preHandler: [requireCapability('paidCalls'), requireAuth, withIdempotency()] };

  app.post('/v1/paid-calls', write, async (req, reply) => {
    const body = parse(StartBody, req.body);
    return reply.status(201).send(await startPaidCall(req.ctx, req.user!.sub, body));
  });

  app.post('/v1/paid-calls/:id/submitted', write, async (req, reply) => {
    const { id } = parse(Params, req.params);
    const { signature } = parse(SubmittedBody, req.body);
    return reply.send(await submitOpenSignature(req.ctx, id, req.user!.sub, signature));
  });

  app.post('/v1/paid-calls/:id/accept', write, async (req, reply) => {
    const { id } = parse(Params, req.params);
    return reply.send(await acceptPaidCall(req.ctx, id, req.user!.sub));
  });

  app.post('/v1/paid-calls/:id/decline', write, async (req, reply) => {
    const { id } = parse(Params, req.params);
    return reply.send(await declinePaidCall(req.ctx, id, req.user!.sub));
  });

  app.post('/v1/paid-calls/:id/end', write, async (req, reply) => {
    const { id } = parse(Params, req.params);
    return reply.send(await endPaidCall(req.ctx, id, req.user!.sub));
  });

  app.get(
    '/v1/paid-calls/:id',
    { preHandler: [requireCapability('paidCalls'), requireAuth] },
    async (req, reply) => {
      const { id } = parse(Params, req.params);
      return reply.send(await getPaidCall(req.ctx, id, req.user!.sub));
    },
  );
}
