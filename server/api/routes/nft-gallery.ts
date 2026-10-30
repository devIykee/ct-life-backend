/**
 * Home NFT gallery routes (unlock D4, capability `nftGallery`).
 *
 *   GET /v1/nfts/me?limit=&cursor=
 *   GET /v1/homes/:ownerId/gallery
 *   PUT /v1/homes/me/gallery
 *
 * See server/application/nft-gallery.ts. Read-only: nothing here mints or
 * moves an asset.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/capability.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { getGallery, listMyNfts, putGallery } from '../../application/nft-gallery.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(12).optional(),
});

const Frames = z
  .object({
    frames: z
      .array(z.object({ slot: z.number().int(), assetId: z.string().min(32).max(64) }).strict())
      .max(64),
  })
  .strict();

const OwnerParams = z.object({ ownerId: z.union([z.literal('me'), z.string().uuid()]) });

/**
 * Register the gallery routes.
 * @param app - The Fastify instance.
 */
export function registerNftGalleryRoutes(app: FastifyInstance): void {
  const gate = requireCapability('nftGallery');

  app.get('/v1/nfts/me', { preHandler: [gate, requireAuth] }, async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    return reply.send(await listMyNfts(req.ctx, req.user!.sub, q.data));
  });

  app.get('/v1/homes/:ownerId/gallery', { preHandler: [gate, requireAuth] }, async (req, reply) => {
    const p = OwnerParams.safeParse(req.params);
    if (!p.success) throw new ValidationFailedError({ issues: p.error.issues });
    return reply.send(await getGallery(req.ctx, req.user!.sub, p.data.ownerId));
  });

  app.put(
    '/v1/homes/me/gallery',
    { preHandler: [gate, requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = Frames.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.send(await putGallery(req.ctx, req.user!.sub, body.data.frames));
    },
  );
}
