import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withRateLimit } from '../middleware/rate-limit.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { WALLET_LINK_NETWORKS } from '../../application/wallet-links-proofs.js';
import {
  assertWalletLinkUuid,
  completeWalletLink,
  issueWalletLinkChallenge,
  listWalletLinks,
  revokeWalletLink,
} from '../../application/wallet-links.js';

/** Authenticated identity links only. Existing SIWS login/session behavior is unchanged. */
export function registerWalletLinkRoutes(app: FastifyInstance): void {
  app.get('/v1/me/wallet-links', { preHandler: requireAuth }, async (req) => ({
    links: await listWalletLinks(req.ctx, req.user!.sub),
  }));
  app.post(
    '/v1/me/wallet-links/challenges',
    { preHandler: [requireAuth, withRateLimit()] },
    async (req, reply) => {
      const body = z
        .object({
          network: z.enum(WALLET_LINK_NETWORKS),
          address: z.string().min(2).max(128),
          nearCallbackMode: z.enum(['none', 'uri']).optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply
        .code(201)
        .send(
          await issueWalletLinkChallenge(req.ctx, req.user!.sub, body.data, req.headers.origin),
        );
    },
  );
  app.post(
    '/v1/me/wallet-links/verify',
    { preHandler: [requireAuth, withRateLimit()] },
    async (req) => {
      const body = z
        .object({
          challengeId: z.string().uuid(),
          signature: z.string().min(1).max(256),
          publicKey: z.string().max(64).optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return {
        link: await completeWalletLink(
          req.ctx,
          req.user!.sub,
          body.data.challengeId,
          {
            signature: body.data.signature,
            ...(body.data.publicKey === undefined ? {} : { publicKey: body.data.publicKey }),
          },
          req.headers.origin,
        ),
      };
    },
  );
  app.delete(
    '/v1/me/wallet-links/:id',
    { preHandler: [requireAuth, withRateLimit()] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      assertWalletLinkUuid(id);
      await revokeWalletLink(req.ctx, req.user!.sub, id);
      return reply.code(204).send();
    },
  );
}
