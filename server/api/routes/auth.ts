/**
 * Auth routes.
 *
 * /v1/auth/challenge   GET
 * /v1/auth/verify      POST   Idempotency-Key required
 * /v1/auth/refresh     POST   Idempotency-Key required
 * /v1/auth/logout      POST   Idempotency-Key required
 * /v1/auth/dev         POST   Idempotency-Key required  (local/mock only)
 * /v1/auth/jwks        GET
 *
 * Rate limits: the verify and dev endpoints go through the per-IP
 * and global login semaphore so a Helius-slow login does not pile
 * up requests. The refresh and logout endpoints are per-user only.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, VerifyInputSchema } from '../../application/auth.js';
import {
  ForbiddenError,
  SignatureInvalidError,
  ValidationFailedError,
} from '../../shared/domain/errors.js';
import { GlobalLoginSemaphore, perIpLoginLimiter } from '../../shared/infra/rate-limit.js';
import { withIdempotency } from '../middleware/idempotency.js';

const ChallengeQuery = z.object({ wallet: z.string().optional() });

const DevAuthBody = z.object({ wallet: z.string().min(32).max(64) });

const RefreshBody = z.object({ refreshToken: z.string().min(1) });

const LogoutBody = z.object({ refreshToken: z.string().min(1) });

/**
 * Shape an authenticated user as the contract's AuthVerifyResponse.
 *
 * The contract returns `{accessToken, refreshToken, user}`. The flat
 * fields are kept alongside it so callers written against the old
 * response keep working.
 * @param user - The authenticated user from the auth service.
 * @param hasCharacter - Whether the account already created a character.
 * @returns The response body for verify, dev and refresh.
 */
function authResponse(
  user: {
    id: string;
    wallet: string;
    isSeeker: boolean;
    accessToken: string;
    refreshToken: string;
  },
  hasCharacter: boolean,
): Record<string, unknown> {
  return {
    ...user,
    hasCharacter,
    accessToken: user.accessToken,
    refreshToken: user.refreshToken,
    user: {
      id: user.id,
      wallet: user.wallet,
      isSeeker: user.isSeeker,
      hasCharacter,
    },
  };
}

/**
 * Register the auth routes.
 * @param app - The Fastify instance.
 */
export function registerAuthRoutes(app: FastifyInstance): void {
  const auth = (req: FastifyRequest): AuthService => new AuthService(req.ctx);

  // GET /v1/auth/challenge
  app.get('/v1/auth/challenge', async (req, reply) => {
    const q = ChallengeQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const result = await auth(req).issueChallenge(q.data.wallet ?? null, req.headers.origin);
    return reply.send(result);
  });

  // POST /v1/auth/verify
  app.post(
    '/v1/auth/verify',
    {
      preHandler: [
        async (req, reply) => {
          const ip = (req.ip as string) || 'unknown';
          const ipCheck = await perIpLoginLimiter(
            req.ctx.redis.main,
            ip,
            req.ctx.config.rateLimits.loginPerIpPerMin,
          );
          if (!ipCheck.allowed) {
            void reply
              .header('Retry-After', String(Math.ceil(ipCheck.retryAfterMs / 1000)))
              .status(429)
              .send({
                error: {
                  code: 'RATE_LIMITED',
                  message: 'Too many login attempts from this IP.',
                  details: {},
                },
              });
            return reply;
          }
          const sem = new GlobalLoginSemaphore(
            req.ctx.redis.main,
            req.ctx.config.rateLimits.loginGlobalConcurrent,
          );
          const acq = await sem.tryAcquire();
          if (!acq.acquired) {
            void reply
              .header('Retry-After', String(Math.ceil(acq.retryAfterMs / 1000)))
              .status(503)
              .send({
                error: {
                  code: 'SERVER_BUSY',
                  message: 'Login at capacity; retry shortly.',
                  details: {},
                },
              });
            return reply;
          }
          // Stash the semaphore on the request so the post-hook can release.
          (req as unknown as { __sem: GlobalLoginSemaphore }).__sem = sem;
        },
      ],
      preValidation: async (req) => {
        // Make sure the body parses; otherwise we want to release the semaphore.
        const parsed = VerifyInputSchema.safeParse(req.body);
        if (!parsed.success) {
          const sem = (req as unknown as { __sem?: GlobalLoginSemaphore }).__sem;
          if (sem) await sem.release();
          throw new ValidationFailedError({ issues: parsed.error.issues });
        }
      },
    },
    async (req, reply) => {
      try {
        const input = VerifyInputSchema.parse(req.body);
        const user = await auth(req).verifyAndAuthenticate(input, req.headers.origin);
        // The service already looked the character up; no second query.
        return reply.send(authResponse(user, user.hasCharacter));
      } finally {
        const sem = (req as unknown as { __sem?: GlobalLoginSemaphore }).__sem;
        if (sem) await sem.release();
      }
    },
  );

  // POST /v1/auth/refresh
  app.post(
    '/v1/auth/refresh',
    {
      preHandler: withIdempotency(),
    },
    async (req, reply) => {
      const body = RefreshBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      try {
        const out = await auth(req).refresh(body.data.refreshToken);
        const hasCharacter = await checkHasCharacter(req, out.id);
        return reply.send(authResponse(out, hasCharacter));
      } catch (e) {
        // The JWT layer throws plain Errors for malformed/invalid
        // tokens ("Invalid Compact JWS", "Not a refresh token",
        // "JWS signature verification failed"). These must surface
        // as 401, not 500.
        const err = e as { code?: string; name?: string };
        if (
          err.code === 'ERR_JWT_EXPIRED' ||
          err.code === 'ERR_JWS_INVALID' ||
          err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
          err.name === 'JWTExpired' ||
          err.name === 'JWTInvalid' ||
          err.name === 'JWSInvalid' ||
          err.name === 'JWSSignatureVerificationFailed' ||
          err.name === 'JOSEError'
        ) {
          throw new SignatureInvalidError({ reason: (e as Error).message });
        }
        throw e;
      }
    },
  );

  // POST /v1/auth/logout
  app.post('/v1/auth/logout', { preHandler: withIdempotency() }, async (req, reply) => {
    const body = LogoutBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    await auth(req).logout(body.data.refreshToken);
    return reply.status(204).send();
  });

  // POST /v1/auth/dev
  app.post('/v1/auth/dev', { preHandler: withIdempotency() }, async (req, reply) => {
    if (!req.ctx.config.auth.devAuthEnabled) {
      throw new ForbiddenError({ reason: 'dev_auth_disabled' });
    }
    const body = DevAuthBody.safeParse(req.body);
    if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
    const user = await auth(req).devAuthenticate(body.data.wallet);
    return reply.send(authResponse(user, user.hasCharacter));
  });

  // GET /v1/auth/jwks
  app.get('/v1/auth/jwks', async (req, reply) => {
    const jwks = await req.ctx.jwt.jwks();
    return reply.send(jwks);
  });
}

async function checkHasCharacter(req: FastifyRequest, userId: string): Promise<boolean> {
  const r = await req.ctx.db.withConnection((c: import('pg').PoolClient) =>
    c.query<{ id: string }>('SELECT id FROM characters WHERE user_id = $1', [userId]),
  );
  return (r.rowCount ?? 0) > 0;
}
