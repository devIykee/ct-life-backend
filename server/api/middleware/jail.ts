/**
 * Refuse a request while the caller is in CT Jail (`403 JAILED`).
 * Put it after `requireAuth`. See docs/HEAT.md for which actions it guards.
 */
import type { FastifyRequest } from 'fastify';
import { assertNotJailed } from '../../application/heat.js';

/**
 * @param req - The authenticated request.
 */
export async function requireNotJailed(req: FastifyRequest): Promise<void> {
  await assertNotJailed(req.ctx, req.user!.sub);
}
