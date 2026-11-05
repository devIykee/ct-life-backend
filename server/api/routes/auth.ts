import {
  LOGIN_NETWORKS,
  issueLoginChallenge,
  completeLoginChallenge,
  listLoginIdentities,
  listAccountAccessEvents,
} from '../../application/wallet-auth.js';
import { assertRecentAuthentication } from '../../application/login-credentials.js';
import {
  revokeLoginIdentity,
  issuePrimarySolanaChallenge,
  completePrimarySolanaChallenge,
} from '../../application/wallet-auth-lifecycle.js';
import { requireAuth } from '../middleware/auth.js';
import { withRateLimit } from '../middleware/rate-limit.js';
import type { AuthMethod } from '../../shared/auth/jwt.js';
import type { SessionIdentity } from '../../application/auth.js';
import { RateLimitedError, ServerBusyError } from '../../shared/domain/errors.js';
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
    wallet: string | null;
    authMethod: AuthMethod;
    loginIdentity: SessionIdentity;
    loginIdentityVersion: number;
    authenticatedAt: number | null;
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
      authMethod: user.authMethod,
      loginIdentity: user.loginIdentity,
      loginIdentityVersion: user.loginIdentityVersion,
      authenticatedAt: user.authenticatedAt,
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

  const walletBody = z
    .object({ network: z.enum(LOGIN_NETWORKS), address: z.string().min(2).max(128) })
    .strict();
  const proofBody = z
    .object({
      challengeId: z.string().uuid(),
      signature: z.string().min(1).max(256),
      publicKey: z.string().min(1).max(64).optional(),
    })
    .strict();
  const limit = async (req: FastifyRequest): Promise<void> => {
    const r = await perIpLoginLimiter(
      req.ctx.redis.main,
      req.ip,
      req.ctx.config.rateLimits.loginPerIpPerMin,
    );
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
  };
  const recentAuth = async (req: FastifyRequest): Promise<void> => {
    assertRecentAuthentication(req.ctx.config, req.user!);
  };
  for (const purpose of ['login', 'enrolment'] as const) {
    const path = purpose === 'login' ? '/v1/auth/wallet' : '/v1/auth/identities';
    const guards =
      purpose === 'login' ? [limit] : [requireAuth, recentAuth, withRateLimit(), limit];
    app.post(`${path}/challenge`, { preHandler: guards }, async (req, reply) => {
      const body = walletBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply
        .code(201)
        .send(
          await issueLoginChallenge(
            req.ctx,
            purpose,
            purpose === 'login' ? null : req.user!.sub,
            body.data,
            req.headers.origin,
            purpose === 'login' ? undefined : req.user,
          ),
        );
    });
    app.post(`${path}/verify`, { preHandler: guards }, async (req, reply) => {
      const body = proofBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const sem = new GlobalLoginSemaphore(
        req.ctx.redis.main,
        req.ctx.config.rateLimits.loginGlobalConcurrent,
      );
      const acquired = await sem.tryAcquire();
      if (!acquired.acquired) throw new ServerBusyError(acquired.retryAfterMs);
      try {
        const proof = {
          signature: body.data.signature,
          ...(body.data.publicKey === undefined ? {} : { publicKey: body.data.publicKey }),
        };
        if (purpose === 'login') {
          const user = await auth(req).walletAuthenticate(
            body.data.challengeId,
            proof,
            req.headers.origin,
          );
          return reply.send(authResponse(user, user.hasCharacter));
        }
        const result = await completeLoginChallenge(
          req.ctx,
          purpose,
          req.user!.sub,
          body.data.challengeId,
          proof,
          req.headers.origin,
          undefined,
          req.user,
        );
        return reply.send({ identity: result.identity });
      } finally {
        await sem.release();
      }
    });
  }
  app.get('/v1/auth/identities', { preHandler: [requireAuth, withRateLimit()] }, async (req) => ({
    identities: await listLoginIdentities(req.ctx, req.user!.sub),
    securityEvents: await listAccountAccessEvents(req.ctx, req.user!.sub),
  }));

  app.delete(
    '/v1/auth/identities/:id',
    { preHandler: [requireAuth, recentAuth, withRateLimit()] },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).strict().safeParse(req.params);
      if (!params.success || req.body !== undefined)
        throw new ValidationFailedError({ reason: 'invalid_identity_revocation' });
      await revokeLoginIdentity(req.ctx, req.user!, params.data.id, req.headers.origin);
      return reply.code(204).send();
    },
  );
  app.post(
    '/v1/auth/primary-solana/challenge',
    { preHandler: [requireAuth, recentAuth, withRateLimit(), limit] },
    async (req, reply) => {
      const body = z
        .object({ address: z.string().min(32).max(44) })
        .strict()
        .safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply
        .code(201)
        .send(
          await issuePrimarySolanaChallenge(
            req.ctx,
            req.user!,
            body.data.address,
            req.headers.origin,
          ),
        );
    },
  );
  app.post(
    '/v1/auth/primary-solana/verify',
    { preHandler: [requireAuth, recentAuth, withRateLimit(), limit] },
    async (req, reply) => {
      const body = z
        .object({ challengeId: z.string().uuid(), signature: z.string().length(88) })
        .strict()
        .safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const sem = new GlobalLoginSemaphore(
        req.ctx.redis.main,
        req.ctx.config.rateLimits.loginGlobalConcurrent,
      );
      const acquired = await sem.tryAcquire();
      if (!acquired.acquired) throw new ServerBusyError(acquired.retryAfterMs);
      try {
        return reply.send(
          await completePrimarySolanaChallenge(
            req.ctx,
            req.user!,
            body.data.challengeId,
            body.data.signature,
            req.headers.origin,
          ),
        );
      } finally {
        await sem.release();
      }
    },
  );

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
        return reply.send(authResponse(out, out.hasCharacter));
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
