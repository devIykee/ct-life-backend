/**
 * NFT image proxy (unlock D4, capability `nftGallery`).
 *
 *   GET /v1/img/:hash  -> image/png (<= 512 px, <= 512 KiB), or 404
 *
 * No auth: the client's image loader fetches it like any image, and a hash
 * only exists for a URL the server itself read from DAS. The bytes never
 * change for a hash, so responses are cached for a day.
 * See server/application/nft-images.ts for the fetch rules.
 */
import type { FastifyInstance } from 'fastify';
import { requireCapability } from '../middleware/capability.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { proxiedImage } from '../../application/nft-images.js';

/**
 * Register the image proxy route.
 * @param app - The Fastify instance.
 */
export function registerImgProxyRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/img/:hash',
    { preHandler: [requireCapability('nftGallery')] },
    async (req, reply) => {
      const { hash } = req.params as { hash: string };
      const img = await proxiedImage(req.ctx, hash);
      if (!img) throw new NotFoundError({ resource: 'image', id: hash });
      return reply
        .header('content-type', 'image/png')
        .header('cache-control', 'public, max-age=86400, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(img.png);
    },
  );
}
