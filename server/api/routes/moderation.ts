/**
 * Admin moderation routes (admin wallet allowlist, same as the other /admin routes).
 *
 *   GET  /v1/admin/reports                     review queue (status, limit, after)
 *   POST /v1/admin/reports/{reportId}/resolve  dismiss | remove_content | mute | ban
 *   POST /v1/admin/users/{userId}/sanction     mute | unmute | ban | unban
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../middleware/auth.js';
import { requireUuidParam } from '../middleware/uuid-param.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { listReports, resolveReport, sanctionUser } from '../../application/moderation.js';

const ListQuery = z.object({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.coerce.number().int().min(0).optional(),
});
const ResolveBody = z.strictObject({
  action: z.enum(['dismiss', 'remove_content', 'mute', 'ban']),
  hours: z.number().int().min(1).max(720).optional(),
  note: z.string().max(500).optional(),
});
const SanctionBody = z.strictObject({
  action: z.enum(['mute', 'unmute', 'ban', 'unban']),
  hours: z.number().int().min(1).max(720).optional(),
  reason: z.string().max(500).optional(),
});

/**
 * Register the admin moderation routes.
 * @param app - The Fastify instance.
 */
export function registerModerationRoutes(app: FastifyInstance): void {
  app.get('/v1/admin/reports', { preHandler: requireAdmin }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(
      await listReports(req.ctx, {
        status: q.data.status,
        limit: q.data.limit,
        ...(q.data.after !== undefined ? { after: q.data.after } : {}),
      }),
    );
  });

  app.post(
    '/v1/admin/reports/:reportId/resolve',
    { preHandler: [requireAdmin, withIdempotency()] },
    async (req, reply) => {
      const id = z.coerce
        .number()
        .int()
        .positive()
        .safeParse((req.params as { reportId: string }).reportId);
      const b = ResolveBody.safeParse(req.body);
      if (!id.success) throw new ValidationFailedError({ issues: id.error.issues });
      if (!b.success) throw new ValidationFailedError({ issues: b.error.issues });
      return reply.send(await resolveReport(req.ctx, req.user!.sub, id.data, b.data));
    },
  );

  app.post(
    '/v1/admin/users/:userId/sanction',
    { preHandler: [requireAdmin, requireUuidParam('userId'), withIdempotency()] },
    async (req, reply) => {
      const b = SanctionBody.safeParse(req.body);
      if (!b.success) throw new ValidationFailedError({ issues: b.error.issues });
      const { userId } = req.params as { userId: string };
      await sanctionUser(req.ctx, req.user!.sub, userId, b.data.action, {
        ...(b.data.hours !== undefined ? { hours: b.data.hours } : {}),
        ...(b.data.reason !== undefined ? { reason: b.data.reason } : {}),
      });
      return reply.status(204).send();
    },
  );
}
