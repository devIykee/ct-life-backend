/**
 * Refuse a route while its capability is off (`503 CAPABILITY_OFF {capability}`).
 * Put it first in the preHandler list, before `requireAuth`, so a dark feature
 * answers the same way for everyone. See server/shared/domain/capabilities.ts.
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { assertCapabilityOn } from '../../application/capabilities.js';
import type { CapabilityName } from '../../shared/domain/capabilities.js';

/**
 * @param name - The capability the route needs.
 * @returns A preHandler that throws `CapabilityOffError` while `name` is off.
 */
export function requireCapability(name: CapabilityName): preHandlerAsyncHookHandler {
  return async function capabilityGate(req: FastifyRequest): Promise<void> {
    assertCapabilityOn(req.ctx, name);
  };
}
