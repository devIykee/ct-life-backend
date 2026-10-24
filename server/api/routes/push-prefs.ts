/**
 * Push preference routes: quiet hours and per-type opt-outs.
 *
 *   GET /v1/push/prefs
 *   PUT /v1/push/prefs
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { getPushPrefs, PushPrefsBody, setPushPrefs } from '../../application/push-delivery.js';

/**
 * Register the push preference routes.
 */
export function registerPushPrefsRoutes(app: FastifyInstance): void {
  app.get('/v1/push/prefs', { preHandler: requireAuth }, async (req, reply) => {
    return reply.send(await getPushPrefs(req.ctx, req.user!.sub));
  });

  app.put(
    '/v1/push/prefs',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = PushPrefsBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(await setPushPrefs(req.ctx, req.user!.sub, body.data));
    },
  );
}
