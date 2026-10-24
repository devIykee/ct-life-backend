/**
 * Fastify composition root.
 *
 * The entry point for the REST API. Builds the AppContext, registers
 * the error handler, the request-id hook, the auth hook, the
 * idempotency middleware, the rate limiter, and every Phase 1
 * route. The server starts on `Config.port` (or `PORT_API`) and
 * shuts down on SIGINT/SIGTERM.
 */
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildContext, type AppContext, _resetContextForTests } from '../application/context.js';
import { toErrorEnvelope, type MappedError } from '../shared/infra/error-envelope.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerSocialRoutes } from './routes/social.js';
import { registerWorkRoutes } from './routes/work.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerPaymentsRoutes } from './routes/payments.js';
import { registerMarketRoutes } from './routes/markets.js';
import { registerPerpRoutes } from './routes/perps.js';
import { registerOreRoutes } from './routes/ore.js';
import { registerPredictionRoutes } from './routes/predictions.js';
import { registerAlphaRoutes } from './routes/alpha.js';
import { registerSocialGraphRoutes } from './routes/social-graph.js';
import { registerSpaceRoutes } from './routes/spaces.js';
import { registerRtcRoutes } from './routes/rtc.js';
import { registerVideoCallRoutes } from './routes/video-calls.js';
import { registerCreatorRoutes } from './routes/creator.js';
import { registerPaidCallRoutes } from './routes/paid-calls.js';
import { registerHomeRoutes } from './routes/homes.js';
import { registerTipRoutes } from './routes/tips.js';
import { registerBankRoutes } from './routes/bank.js';
import { registerPushMetaAdRoutes } from './routes/push-meta-ads.js';
import { registerCosmeticRoutes } from './routes/cosmetics.js';
import { registerShopRoutes } from './routes/shop.js';
import { REDACT_PATHS } from '../shared/logger/logger.js';
import { registerEventRoutes } from './routes/events.js';
import { closeShopQueue } from '../application/shop-queue.js';
import { registerDailyClueRoutes } from './routes/daily-clue.js';
import { registerSeasonPassRoutes } from './routes/season-pass.js';
import { registerBusinessRoutes } from './routes/businesses.js';
import { registerGigRoutes } from './routes/gigs.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerNftMintRoutes } from './routes/nft-mint.js';
import { registerEntitlementRoutes } from './routes/entitlements.js';
import { registerTribeRoutes } from './routes/tribes.js';
import { registerLeagueRoutes } from './routes/leagues.js';
import { registerRatioArenaRoutes } from './routes/ratio-arena.js';
import { registerAirdropRoutes } from './routes/airdrop-farm.js';
import { registerVenuesGatingRoutes } from './routes/venues-gating.js';
import { registerLlmNpcRoutes } from './routes/llm-npcs.js';
import { registerXLinkRoutes } from './routes/x-link.js';
import { registerLikenessRoutes } from './routes/likeness.js';
import { buildLikenessRuntime } from '../application/likeness-runtime.js';
import { idempotencyOnSend } from './middleware/idempotency.js';

declare module 'fastify' {
  interface FastifyRequest {
    ctx: AppContext;
    requestId: string;
  }
}

export interface ServerHandle {
  app: FastifyInstance;
  start(): Promise<string>;
  stop(): Promise<void>;
}

/**
 *
 */
export async function buildServer(): Promise<ServerHandle> {
  const ctx = buildContext();
  const app = Fastify({
    logger: {
      level: ctx.config.logLevel,
      // Bodies are not logged by default; redact them (and any coordinates) anyway.
      redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
      // Minimal pino-style config; the shared logger has more.
    },
    disableRequestLogging: false,
    trustProxy: true,
  });

  // requestId hook (also exposed as a header for clients).
  app.addHook('onRequest', (req, reply, done) => {
    const id = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
    req.requestId = id;
    reply.header('x-request-id', id);
    req.ctx = ctx;
    done();
  });

  // Capture the raw body for signed webhook routes. The body
  // is the same JSON Fastify would otherwise parse; we just
  // preserve the original string for HMAC verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      const parsed = body === '' ? {} : JSON.parse(body as string);
      done(null, parsed);
    } catch (e) {
      done(e as Error, undefined);
    }
  });

  // Global onSend hook: caches idempotent responses.
  app.addHook('onSend', idempotencyOnSend());

  // Global error handler: maps DomainError to the contract envelope.
  app.setErrorHandler((err, req, reply): FastifyReply | void => {
    // Fastify raises this when a downstream hook (the idempotency
    // replay path) already sent the response. There is nothing to
    // write; the error is informational.
    if ((err as { code?: string }).code === 'FST_ERR_REP_ALREADY_SENT') {
      return reply;
    }
    const mapped: MappedError = toErrorEnvelope(err, {
      error(msg, extra) {
        req.log.error({ msg, extra, requestId: req.requestId, err: (err as Error).message });
      },
    });
    for (const [k, v] of Object.entries(mapped.headers)) {
      reply.header(k, v);
    }
    void reply.status(mapped.status).send(mapped.envelope);
  });

  // 404 handler returns the error envelope shape, not Fastify's default.
  app.setNotFoundHandler((req, reply) => {
    void reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'No route for this path and method.',
        details: { path: req.url, method: req.method },
      },
    });
  });

  // Routes.
  registerAuthRoutes(app);
  registerCoreRoutes(app);
  registerSocialRoutes(app);
  registerWorkRoutes(app);
  registerOpsRoutes(app, ctx);
  registerPaymentsRoutes(app);
  registerMarketRoutes(app);
  registerPerpRoutes(app);
  registerOreRoutes(app);
  registerPredictionRoutes(app);
  registerAlphaRoutes(app);
  registerSocialGraphRoutes(app);
  registerSpaceRoutes(app);
  registerRtcRoutes(app); // B23: Add RTC token endpoint
  registerVideoCallRoutes(app);
  registerCreatorRoutes(app);
  registerPaidCallRoutes(app);
  registerHomeRoutes(app);
  registerTipRoutes(app);
  registerBankRoutes(app);
  registerPushMetaAdRoutes(app);
  registerCosmeticRoutes(app);
  registerShopRoutes(app);
  registerEventRoutes(app);
  registerDailyClueRoutes(app);
  registerSeasonPassRoutes(app);
  registerBusinessRoutes(app);
  registerGigRoutes(app);
  registerProjectRoutes(app);
  registerNftMintRoutes(app);
  registerEntitlementRoutes(app);
  registerTribeRoutes(app);
  registerLeagueRoutes(app);
  registerRatioArenaRoutes(app);
  registerAirdropRoutes(app);
  registerVenuesGatingRoutes(app);
  registerLlmNpcRoutes(app);
  registerXLinkRoutes(app);
  const likeness = await buildLikenessRuntime(ctx.config, ctx.db);
  registerLikenessRoutes(app, (_db, userId) => likeness.forOwner(userId));

  // /healthz, /readyz are registered in ops routes.

  return {
    app,
    async start() {
      const port = ctx.config.port;
      await app.listen({ port, host: '0.0.0.0' });
      return `http://0.0.0.0:${port}`;
    },
    async stop() {
      await app.close();
      await closeShopQueue();
      await ctx.db.close();
      await ctx.redis.close();
    },
  };
}

// Direct execution: `node server/api/main.ts` or `tsx server/api/main.ts`.
const isDirect = typeof process.argv[1] === 'string' && process.argv[1].endsWith('main.ts');
if (isDirect) {
  buildServer()
    .then(async (h) => {
      const url = await h.start();
      // eslint-disable-next-line no-console
      console.log(`[api] listening on ${url}`);
    })
    .catch((e: Error) => {
      console.error('[api] failed to start:', e);
      process.exit(1);
    });
  const shutdown = async (): Promise<void> => {
    const h = await buildServer();
    await h.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

// Re-export for tests.
export { _resetContextForTests };
