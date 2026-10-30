/**
 * Real Factory routes (Meteora DBC; docs/FACTORY-REAL.md).
 *
 * Unlock C3: launching (prepare / confirm / submit) needs the `factory` capability
 * (`503 CAPABILITY_OFF` while off); the reads, metadata and the webhook stay open.
 *
 *   GET  /v1/factory/config                     fees, cluster, risk warning, limits
 *   POST /v1/factory/launch/prepare             {name, ticker, description?, imageBase64, riskAccepted}
 *   POST /v1/factory/launch/confirm             {launchId, signature}
 *   POST /v1/factory/launch/submit              {launchId, signedTxBase64}   (fallback)
 *   GET  /v1/factory/launch/:launchId           status
 *   GET  /v1/factory/tokens?view=new|trending|mine&limit=
 *   GET  /v1/factory/tokens/:mint
 *   GET  /v1/factory/tokens/:mint/trades?limit=
 *   GET  /v1/factory/metadata/:id               public token image / metadata ('self' store)
 *   POST /v1/webhooks/helius/factory            Helius raw webhook (Authorization header)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireNotJailed } from '../middleware/jail.js';
import { requireCapability } from '../middleware/capability.js';
import {
  ForbiddenError,
  NotFoundError,
  ValidationFailedError,
} from '../../shared/domain/errors.js';
import {
  confirmLaunch,
  getRealFactoryConfig,
  getToken,
  listTokens,
  listTrades,
  prepareLaunch,
  processFactoryWebhook,
  submitLaunch,
  webhookAuthorized,
  type RawTx,
} from '../../application/factory-real.js';
import { readSelfStored } from '../../application/factory-metadata.js';

const PrepareBody = z
  .object({
    name: z.string().min(1).max(64),
    ticker: z.string().min(1).max(16),
    description: z.string().max(400).optional(),
    imageBase64: z.string().min(1).max(3_000_000),
    riskAccepted: z.boolean(),
    riskWarningVersion: z.string().max(32).optional(),
  })
  .strict();
const ConfirmBody = z
  .object({ launchId: z.string().uuid(), signature: z.string().min(64).max(100) })
  .strict();
const SubmitBody = z
  .object({ launchId: z.string().uuid(), signedTxBase64: z.string().min(1).max(4000) })
  .strict();
const LaunchParams = z.object({ launchId: z.string().uuid() });
const MintParams = z.object({ mint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/) });
const ListQuery = z.object({
  view: z.enum(['new', 'trending', 'mine']).default('new'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const TradesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const MetaParams = z.object({ id: z.string().regex(/^[0-9a-f]{40}\.(png|json)$/) });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationFailedError({ issues: r.error.issues });
  return r.data;
}

/**
 * Register the real Factory routes.
 * @param app - The Fastify instance.
 */
export function registerFactoryRealRoutes(app: FastifyInstance): void {
  app.get('/v1/factory/config', { preHandler: requireAuth }, async (req, reply) =>
    reply.send(await getRealFactoryConfig(req.ctx)),
  );

  app.post(
    '/v1/factory/launch/prepare',
    {
      // Jail is answered before the capability (a jailed player always sees JAILED).
      preHandler: [requireAuth, requireNotJailed, requireCapability('factory'), withIdempotency()],
      bodyLimit: 4 * 1024 * 1024,
    },
    async (req, reply) =>
      reply
        .status(201)
        .send(await prepareLaunch(req.ctx, req.user!.sub, parse(PrepareBody, req.body))),
  );
  app.post(
    '/v1/factory/launch/confirm',
    { preHandler: [requireAuth, requireCapability('factory'), withIdempotency()] },
    async (req, reply) => {
      const b = parse(ConfirmBody, req.body);
      return reply.send(await confirmLaunch(req.ctx, req.user!.sub, b.launchId, b.signature));
    },
  );
  app.post(
    '/v1/factory/launch/submit',
    { preHandler: [requireAuth, requireCapability('factory'), withIdempotency()] },
    async (req, reply) => {
      const b = parse(SubmitBody, req.body);
      return reply.send(await submitLaunch(req.ctx, req.user!.sub, b.launchId, b.signedTxBase64));
    },
  );
  app.get('/v1/factory/launch/:launchId', { preHandler: requireAuth }, async (req, reply) => {
    const { launchId } = parse(LaunchParams, req.params);
    const r = await req.ctx.db.withConnection((c) =>
      c.query(
        `SELECT launch_id AS "launchId", mint, pool, cluster, name, ticker, status, signature, error,
                expires_at AS "expiresAt", confirmed_at AS "confirmedAt"
           FROM factory_launches WHERE launch_id = $1 AND user_id = $2`,
        [launchId, req.user!.sub],
      ),
    );
    if (!r.rows[0]) throw new NotFoundError({ kind: 'launch', id: launchId });
    return reply.send(r.rows[0]);
  });

  app.get('/v1/factory/tokens', { preHandler: requireAuth }, async (req, reply) => {
    const q = parse(ListQuery, req.query);
    return reply.send({ tokens: await listTokens(req.ctx, req.user!.sub, q.view, q.limit) });
  });
  app.get('/v1/factory/tokens/:mint', { preHandler: requireAuth }, async (req, reply) => {
    const { mint } = parse(MintParams, req.params);
    const t = await getToken(req.ctx, mint);
    if (!t) throw new NotFoundError({ kind: 'token', id: mint });
    return reply.send(t);
  });
  app.get('/v1/factory/tokens/:mint/trades', { preHandler: requireAuth }, async (req, reply) => {
    const { mint } = parse(MintParams, req.params);
    const q = parse(TradesQuery, req.query);
    return reply.send({ trades: await listTrades(req.ctx, mint, q.limit) });
  });

  // Public: wallets and explorers fetch the token's metadata and image.
  app.get('/v1/factory/metadata/:id', async (req, reply) => {
    const { id } = parse(MetaParams, req.params);
    const obj = await readSelfStored(req.ctx.db, id);
    if (!obj) throw new NotFoundError({ kind: 'metadata', id });
    return reply
      .header('content-type', obj.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(obj.content);
  });

  app.post('/v1/webhooks/helius/factory', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    if (!webhookAuthorized(req.ctx, req.headers.authorization)) {
      throw new ForbiddenError({ reason: 'bad webhook auth' });
    }
    const body = req.body as unknown;
    const txs = (Array.isArray(body) ? body : [body]) as RawTx[];
    return reply.send(await processFactoryWebhook(req.ctx, txs));
  });
}
