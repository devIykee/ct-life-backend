/**
 * 18+ confirmation after character creation (docs/REAL-MARKETS.md "18+ after creation").
 *
 *   POST /v1/me/age-confirm   {confirmed: true}   (Idempotency-Key; X-Client-Version recorded)
 *     -> 200 {ageConfirmed: true, ageConfirmedAt, alreadyConfirmed}
 *
 * Sets `characters.age_confirmed_at`, the flag `GET /me` and `GET /casino/state` report as
 * `ageConfirmed` and every 18+ feature checks. No capability: the casino and the Factory
 * need it too.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { confirmAge } from '../../application/age-confirm.js';

const Body = z.object({ confirmed: z.literal(true) }).strict();
const ClientVersion = z.string().regex(/^[0-9A-Za-z.+_-]{1,32}$/);

/**
 * @param app - The Fastify instance.
 */
export function registerMeAgeRoutes(app: FastifyInstance): void {
  app.post(
    '/v1/me/age-confirm',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = Body.safeParse(req.body);
      if (!body.success) {
        throw new ValidationFailedError({ reason: 'confirm_required', issues: body.error.issues });
      }
      const raw = req.headers['x-client-version'];
      const header = Array.isArray(raw) ? raw[0] : raw;
      let clientVersion: string | null = null;
      if (header !== undefined && header !== '') {
        const v = ClientVersion.safeParse(header);
        if (!v.success) throw new ValidationFailedError({ reason: 'invalid_client_version' });
        clientVersion = v.data;
      }
      return reply.send(await confirmAge(req.ctx, req.user!.sub, clientVersion));
    },
  );
}
