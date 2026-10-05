/**
 * Bearer auth middleware.
 *
 * Verifies the Authorization header against the JWT issuer and
 * stashes the claims on `request.user`. Throws `TokenExpiredError`
 * or `SignatureInvalidError` so the global error handler maps them
 * to the right envelope.
 */
import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { SignatureInvalidError, TokenExpiredError } from '../../shared/domain/errors.js';
import type { AccessClaims } from '../../shared/auth/jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessClaims;
  }
}

/**
 * Verify the bearer token. Throws on missing/invalid/expired. On
 * success, sets `request.user` to the access claims.
 */
export async function requireAuth(
  req: FastifyRequest,
  _reply?: FastifyReply,
): Promise<AccessClaims> {
  const header = req.headers.authorization;
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    throw new SignatureInvalidError({ reason: 'missing_bearer' });
  }
  const token = header.slice(7).trim();
  try {
    const claims = await req.ctx.jwt.verifyAccess(token);
    req.user = claims;
    return claims;
  } catch (e) {
    const err = e as { code?: string; name?: string; message?: string };
    if (err.name === 'JWTExpired' || err.code === 'ERR_JWT_EXPIRED') {
      throw new TokenExpiredError({});
    }
    throw new SignatureInvalidError({ reason: err.message ?? 'unknown' });
  }
}

/** Pre-handler hook wrapper. */
export const requireAuthMiddleware: preHandlerHookHandler = async (req, reply) => {
  await requireAuth(req, reply);
};
