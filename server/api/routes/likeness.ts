/** Authenticated pre-character boundary. Production remains explicitly unconfigured. */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { LikenessService } from '../../application/likeness.js';
import { LikenessRepository } from '../../shared/db/likeness.js';
import { LikenessPipelineRepository } from '../../shared/db/likeness-pipeline.js';
import { LikenessJobActions, likenessActionReceipt } from '../../application/likeness-actions.js';
import type { LikenessPhotoService } from '../../application/likeness-photos.js';
import type { PrivateLikenessStorage } from '../../shared/infra/likeness-storage.js';
import type { Db } from '../../shared/db/pool.js';
import {
  LikenessUnavailableError,
  type LikenessReadiness,
  UNCONFIGURED_LIKENESS,
} from '../../shared/domain/likeness.js';
import { MAX_LIKENESS_PHOTO_INPUT_BYTES } from '../../shared/infra/likeness-image.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { LikenessDeliveryRepository } from '../../shared/db/likeness-delivery.js';
import { z } from 'zod';
import { LikenessCheckoutService, likenessPrice } from '../../application/likeness-checkout.js';
import { createHeliusClient } from '../../shared/solana/helius.js';
import type { FastifyRequest } from 'fastify';

/** Only an audited composition root supplies these; a client field/env boolean cannot enable them. */
export interface LikenessRouteRuntime {
  readiness: LikenessReadiness;
  photos?: LikenessPhotoService;
  storage?: PrivateLikenessStorage;
}
/** Register authenticated job actions and optionally configured private photo services. */
export function registerLikenessRoutes(
  app: FastifyInstance,
  runtime: (db: Db, userId: string) => LikenessRouteRuntime = () => ({
    readiness: UNCONFIGURED_LIKENESS,
  }),
): void {
  const checkoutMint = (req: FastifyRequest) => {
    const currency = req.ctx.configCache.load<{
      currencies: { USDC: { mint: string | null; devnetMint: string | null } };
    }>('economy').currencies.USDC;
    return req.ctx.config.solana.cluster === 'mainnet' ? currency.mint : currency.devnetMint;
  };
  const checkout = (req: FastifyRequest) => {
    const cfg = req.ctx.config,
      setup = runtime(req.ctx.db, req.user!.sub);
    const mint = checkoutMint(req);
    return new LikenessCheckoutService(
      req.ctx.db,
      {
        enabled: setup.readiness.enabled && cfg.likeness.endUserAgreementConfirmed && Boolean(mint),
        priceUsdcCents: cfg.likeness.priceUsdcCents,
        cluster: cfg.solana.cluster,
        mint: mint ?? '',
        recipient: cfg.solana.treasuryPubkey,
        models: setup.readiness.models,
      },
      createHeliusClient({ url: cfg.solana.rpcUrl, apiKey: cfg.helius.apiKey }),
    );
  };
  app.get('/v1/likeness', { preHandler: requireAuth }, async (req) => {
    const setup = runtime(req.ctx.db, req.user!.sub);
    const offering = new LikenessService(
      new LikenessRepository(req.ctx.db),
      setup.readiness,
    ).availability();
    return {
      ...offering,
      photoUploadEnabled: offering.enabled && Boolean(setup.photos),
      entitlement: await new LikenessDeliveryRepository(req.ctx.db).entitlement(req.user!.sub),
      price: likenessPrice(req.ctx.config.likeness.priceUsdcCents),
      checkoutAvailable:
        offering.enabled &&
        req.ctx.config.likeness.endUserAgreementConfirmed &&
        Boolean(likenessPrice(req.ctx.config.likeness.priceUsdcCents)) &&
        Boolean(checkoutMint(req)),
    };
  });
  app.post('/v1/likeness/checkout', { preHandler: requireAuth, bodyLimit: 1024 }, async (req) =>
    checkout(req).create(req.user!.sub, req.headers['idempotency-key'], req.body),
  );
  app.get('/v1/likeness/checkout/current', { preHandler: requireAuth }, async (req) =>
    checkout(req).current(req.user!.sub),
  );
  app.get('/v1/likeness/checkout/:id', { preHandler: requireAuth }, async (req) =>
    checkout(req).get(req.user!.sub, (req.params as { id: string }).id),
  );
  app.post(
    '/v1/likeness/checkout/:id/submitted',
    { preHandler: requireAuth, bodyLimit: 1024 },
    async (req) =>
      checkout(req).submitted(
        req.user!.sub,
        (req.params as { id: string }).id,
        req.headers['idempotency-key'],
        req.body,
      ),
  );
  app.get('/v1/likeness/jobs', { preHandler: requireAuth }, async (req) =>
    new LikenessDeliveryRepository(req.ctx.db).list(req.user!.sub),
  );
  app.get('/v1/likeness/jobs/:id/manifest', { preHandler: requireAuth }, async (req, reply) => {
    const id = ownedId((req.params as { id: string }).id);
    reply.header('cache-control', 'private, no-store');
    return new LikenessDeliveryRepository(req.ctx.db).manifest(req.user!.sub, id);
  });
  app.post(
    '/v1/likeness/jobs/:id/accept',
    { preHandler: requireAuth, bodyLimit: 1024 },
    async (req) => {
      const id = ownedId((req.params as { id: string }).id);
      if (!z.strictObject({}).safeParse(req.body ?? {}).success)
        throw new ValidationFailedError({ reason: 'invalid_likeness_acceptance' });
      return new LikenessDeliveryRepository(req.ctx.db).accept(
        req.user!.sub,
        id,
        likenessActionReceipt(req.headers['idempotency-key'], `accept/${id}`),
        new Date(),
      );
    },
  );
  app.get('/v1/likeness/jobs/:id/preview', { preHandler: requireAuth }, async (req, reply) => {
    const id = ownedId((req.params as { id: string }).id);
    const asset = await new LikenessDeliveryRepository(req.ctx.db).preview(req.user!.sub, id);
    const storage = runtime(req.ctx.db, req.user!.sub).storage;
    if (!storage) throw new LikenessUnavailableError();
    return reply
      .type('model/gltf-binary')
      .header('cache-control', 'private, no-store')
      .header('x-content-sha256', asset.sha256)
      .header('x-content-type-options', 'nosniff')
      .send(await storage.get(asset.key, 16 * 1024 * 1024));
  });
  app.post(
    '/v1/likeness/jobs',
    { preHandler: requireAuth, bodyLimit: 2048 },
    async (req, reply) => {
      const service = new LikenessService(
        new LikenessRepository(req.ctx.db),
        runtime(req.ctx.db, req.user!.sub).readiness,
      );
      return reply
        .status(202)
        .send(await service.create(req.user!.sub, req.headers['idempotency-key'], req.body));
    },
  );
  app.get('/v1/likeness/jobs/:id', { preHandler: requireAuth }, async (req) => {
    return new LikenessService(new LikenessRepository(req.ctx.db)).get(
      req.user!.sub,
      (req.params as { id: string }).id,
    );
  });
  app.post(
    '/v1/likeness/jobs/:id/reference/approve',
    { preHandler: requireAuth, bodyLimit: 1024 },
    async (req, reply) => {
      await new LikenessJobActions(new LikenessPipelineRepository(req.ctx.db)).approve(
        req.user!.sub,
        (req.params as { id: string }).id,
        req.body,
        req.headers['idempotency-key'],
      );
      return reply.status(204).send();
    },
  );
  app.delete('/v1/likeness/jobs/:id', { preHandler: requireAuth }, async (req, reply) => {
    await new LikenessJobActions(new LikenessPipelineRepository(req.ctx.db)).cancel(
      req.user!.sub,
      (req.params as { id: string }).id,
      req.headers['idempotency-key'],
    );
    return reply.status(204).send();
  });
  for (const kind of ['reference', 'result'] as const) {
    app.get(`/v1/likeness/jobs/:id/${kind}`, { preHandler: requireAuth }, async (req, reply) => {
      const actions = new LikenessJobActions(
        new LikenessPipelineRepository(req.ctx.db),
        runtime(req.ctx.db, req.user!.sub).storage,
      );
      const output = await actions[kind](req.user!.sub, (req.params as { id: string }).id);
      return reply
        .type(kind === 'reference' ? 'image/jpeg' : 'model/gltf-binary')
        .header('cache-control', 'private, no-store')
        .header('x-content-sha256', output.sha256)
        .header('x-content-type-options', 'nosniff')
        .send(output.bytes);
    });
  }
  // Scoped parsers keep binary media away from unrelated JSON endpoints. The
  // unavailable/auth check executes before buffering any private image bytes.
  app.register(async (photos) => {
    photos.addContentTypeParser(
      ['image/jpeg', 'image/png'],
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    photos.post(
      '/v1/likeness/photos',
      {
        bodyLimit: MAX_LIKENESS_PHOTO_INPUT_BYTES,
        onRequest: async (req, reply) => {
          await requireAuth(req, reply);
          if (reply.sent) return;
          const setup = runtime(req.ctx.db, req.user!.sub);
          if (!setup.photos || !setup.readiness.enabled || !setup.readiness.provider)
            throw new LikenessUnavailableError();
        },
      },
      async (req, reply) => {
        const setup = runtime(req.ctx.db, req.user!.sub),
          type = req.headers['content-type']?.split(';')[0];
        if (!setup.photos) throw new LikenessUnavailableError();
        if (!Buffer.isBuffer(req.body) || (type !== 'image/jpeg' && type !== 'image/png'))
          throw new ValidationFailedError({ reason: 'invalid_photo_content_type' });
        const upload = await setup.photos.ingest(
          req.user!.sub,
          req.headers['idempotency-key'] as string,
          type,
          req.body,
          {
            version: req.headers['x-likeness-consent-version'],
            ownPhoto: req.headers['x-likeness-own-photo'] === 'true',
            shareWithProvider: req.headers['x-likeness-share-with-provider'] === 'true',
          },
        );
        return reply.status(201).send(upload);
      },
    );
  });
  app.delete('/v1/likeness/photos/:id', { preHandler: requireAuth }, async (req, reply) => {
    const photos = runtime(req.ctx.db, req.user!.sub).photos;
    if (!photos) throw new LikenessUnavailableError();
    const key = req.headers['idempotency-key'];
    likenessActionReceipt(key, `delete-photo/${(req.params as { id: string }).id}`);
    await photos.remove(req.user!.sub, (req.params as { id: string }).id, key);
    return reply.status(204).send();
  });
}

function ownedId(id: string): string {
  if (!z.uuid().safeParse(id).success)
    throw new ValidationFailedError({ reason: 'invalid_likeness_job_id' });
  return id;
}
