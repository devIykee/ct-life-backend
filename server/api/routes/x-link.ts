/**
 * Verified X link routes (M7 #9).
 *
 *   GET /v1/x/link/start
 *   GET /v1/x/link/callback?code=...&state=...
 *   GET /v1/x/link
 *   DELETE /v1/x/link   (capability xUnlink)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/capability.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { completeXLink, getXLink, startXLink, unlinkXLink } from '../../application/x-link.js';
import { createXClient } from '../../shared/x/client.js';

/**
 * Register the X link routes on the Fastify app. The routes
 * return 503 (X_LINK_DISABLED) when the feature flag is off
 * (master prompt: "If X_CLIENT_ID is absent, the feature flag
 * stays off and this is logged in UNVERIFIED.md.").
 */
export function registerXLinkRoutes(app: FastifyInstance): void {
  app.get('/v1/x/link/start', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.ctx.config.xLink.enabled) {
      return reply.status(503).send({
        error: { code: 'X_LINK_DISABLED', message: 'X link is disabled.' },
      });
    }
    const out = await startXLink(req.ctx, req.user!.sub);
    return reply.send(out);
  });

  app.get('/v1/x/link/callback', { preHandler: requireAuth }, async (req, reply) => {
    if (!req.ctx.config.xLink.enabled) {
      return reply.status(503).send({
        error: { code: 'X_LINK_DISABLED', message: 'X link is disabled.' },
      });
    }
    const q = z
      .object({
        code: z.string().min(1).max(1024),
        state: z.string().min(1).max(64),
      })
      .safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const client = req.ctx.config.xLink.clientId
      ? createXClient({
          clientId: req.ctx.config.xLink.clientId,
          clientSecret: req.ctx.config.xLink.clientSecret,
        })
      : stubXClient('999999', 'placeholder', 'https://example.com/avatar.png');
    const out = await completeXLink(req.ctx, req.user!.sub, q.data.code, q.data.state, client);
    return reply.send(out);
  });

  app.get('/v1/x/link', { preHandler: requireAuth }, async (req, reply) => {
    const out = await getXLink(req.ctx, req.user!.sub);
    return reply.send({ link: out });
  });

  // Works even with X_LINK_ENABLED off: removing your data never needs X's API.
  app.delete(
    '/v1/x/link',
    { preHandler: [requireCapability('xUnlink'), requireAuth, withIdempotency()] },
    async (req, reply) => {
      await unlinkXLink(req.ctx, req.user!.sub);
      return reply.status(204).send();
    },
  );
}

/** Stub X client for dev / tests when X_CLIENT_ID is missing. */
function stubXClient(xUserId: string, xHandle: string, xAvatarUrl: string) {
  return {
    async exchangeCode() {
      return { accessToken: 'stub-access', refreshToken: 'stub-refresh' };
    },
    async fetchMe() {
      return { xUserId, xHandle, xAvatarUrl };
    },
  };
}
