/**
 * Payments routes.
 *
 *   POST /v1/payments/intents                 — create a topup intent
 *   POST /v1/payments/intents/{id}/submitted  — client posts the tx signature
 *   POST /v1/webhooks/helius                  — Helius signed webhook
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  createTopupIntent,
  markSubmitted,
  type TopupSku,
  type Currency,
  type TopupKind,
} from '../../application/topup.js';
import { handleHeliusWebhook } from '../../application/helius-webhook.js';
import { handleProgramWebhook } from '../../application/program-webhook.js';

const CreateIntentBody = z.object({
  kind: z.enum(['topup', 'cosmetic', 'ad', 'season_pass']),
  currency: z.enum(['USDC', 'SOL', 'SKR', 'ORE']),
  sku: z.enum(['ramen', 'bag', 'whale', 'cabal', 'custom']),
  amountCents: z.number().int().positive().optional(),
});

const SubmittedBody = z.object({
  signature: z.string().min(64).max(128),
});

/**
 * Register payments + webhooks routes.
 * @param app - The Fastify instance.
 */
export function registerPaymentsRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/payments/intents',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = CreateIntentBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const result = await createTopupIntent(req.ctx, {
        userId: req.user!.sub,
        kind: body.data.kind as TopupKind,
        currency: body.data.currency as Currency,
        sku: body.data.sku as TopupSku,
        amountCents: body.data.amountCents,
      });
      return reply.send(result);
    },
  );

  app.post(
    '/v1/payments/intents/:id/submitted',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = SubmittedBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      await markSubmitted(req.ctx, req.user!.sub, id, body.data.signature);
      return reply.status(204).send();
    },
  );

  app.post('/v1/webhooks/helius', async (req: FastifyRequest, reply) => {
    // The webhook is anonymous; signature is in a header. We
    // accept the raw body and verify.
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const signature = (req.headers['x-helius-signature'] as string | undefined) ?? undefined;
    const payload = req.body as Parameters<typeof handleHeliusWebhook>[3];
    const result = await handleHeliusWebhook(req.ctx, signature, rawBody, payload);
    return reply.send(result);
  });

  // Helius Enhanced Webhook filtered by program address (ct_escrow).
  // Receives Settled / Refunded events and reconciles the in-game
  // ledger.
  app.post('/v1/webhooks/helius-program', async (req: FastifyRequest, reply) => {
    const rawBody = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const signature = (req.headers['x-helius-signature'] as string | undefined) ?? undefined;
    const payload = req.body as Parameters<typeof handleProgramWebhook>[3];
    const result = await handleProgramWebhook(req.ctx, signature, rawBody, payload);
    return reply.send(result);
  });
}
