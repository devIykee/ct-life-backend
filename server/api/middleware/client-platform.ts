/**
 * Client platform hook: reads `X-Client-Platform`, `X-Client-Build` and `Origin`, puts
 * the result on `req.client`, and swaps `req.ctx` for the platform-scoped context so
 * the per-platform kill-list (`CAPABILITIES_OFF_BY_PLATFORM`) applies to every
 * capability gate on the request.
 *
 * Webhook routes (`/v1/webhooks/*`) are never scoped: they are server-to-server and
 * must see the deployment's full capability set whatever headers they carry.
 * See server/shared/domain/client-platform.ts for the resolution rules.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { contextForPlatform } from '../../application/capabilities.js';
import { resolveClientPlatform, type ClientIdentity } from '../../shared/domain/client-platform.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Which client build is calling (set by the client-platform hook). */
    client: ClientIdentity;
  }
}

const WEBHOOK_PREFIX = '/v1/webhooks/';

/**
 * @param req - The request.
 * @returns True when the matched route is a server-to-server webhook.
 */
function isWebhookRoute(req: FastifyRequest): boolean {
  const url = req.routeOptions?.url ?? req.url;
  return typeof url === 'string' && url.startsWith(WEBHOOK_PREFIX);
}

/**
 * Register the hook. Must run after the hook that sets `req.ctx`.
 * @param app - The Fastify instance.
 */
export function registerClientPlatformHook(app: FastifyInstance): void {
  app.decorateRequest('client', null as unknown as ClientIdentity);
  app.addHook('onRequest', async (req) => {
    const id = resolveClientPlatform({
      platform: req.headers['x-client-platform'],
      build: req.headers['x-client-build'],
      origin: req.headers.origin,
    });
    const webhook = isWebhookRoute(req);
    req.client = webhook ? { ...id, scoped: false } : id;
    if (req.client.scoped) req.ctx = contextForPlatform(req.ctx, req.client.platform);
    if (id.declared !== null || id.build !== null) {
      req.log = req.log.child({ clientPlatform: id.platform, clientBuild: id.build });
    }
  });
}
