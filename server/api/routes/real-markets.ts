/**
 * Real Markets routes: real-money prediction markets the player trades from their own
 * wallet on Solana mainnet (docs/REAL-MARKETS.md). Capability `realMarkets` (Panta);
 * `provider=jupiter` also needs `realMarketsJupiter`. Every route needs auth; every route
 * but /config runs the gate (451 geo, 403 AGE_REQUIRED, 403 wallet_required). POSTs need
 * an Idempotency-Key. No route takes, pays or shows Cash.
 *
 *   GET  /v1/real-markets/config                      eligibility, chain, providers, risk copy
 *   GET  /v1/real-markets/markets?provider&category&cursor&limit
 *   GET  /v1/real-markets/markets/:marketId?provider
 *   POST /v1/real-markets/quote                        {provider, marketId, side, amountUsdc}
 *   POST /v1/real-markets/order/build                  {..., quoteId?, maxSlippageBps?, wallet?, riskAccepted}
 *                                                      -> {orderId, txBase64, expiresAt, provider, chain, ...}
 *   POST /v1/real-markets/order/submitted              {orderId, signature}
 *   GET  /v1/real-markets/orders?limit                 my order records
 *   GET  /v1/real-markets/orders/:orderId              one order (re-verifies while submitted)
 *   GET  /v1/real-markets/positions?provider           my linked wallet's positions
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireCapability } from '../middleware/capability.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import { REAL_MARKET_PROVIDERS } from '../../shared/domain/real-markets.js';
import { readGeo, type RequestGeo } from '../../application/real-markets-gate.js';
import {
  MAX_SLIPPAGE_BPS,
  buildRealOrder,
  getRealMarket,
  listRealMarkets,
  quoteRealOrder,
  realMarketsConfig,
} from '../../application/real-markets.js';
import {
  getOrder,
  listOrders,
  orderSubmitted,
  positionsFor,
} from '../../application/real-markets-orders.js';

const Provider = z.enum(REAL_MARKET_PROVIDERS).default('panta');
const MarketId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Base58Sig = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
const Base58Key = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const Amount = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);

const ListQuery = z.object({
  provider: Provider,
  category: z.string().min(1).max(32).optional(),
  cursor: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const MarketParams = z.object({ marketId: MarketId });
const ProviderQuery = z.object({ provider: Provider });
const QuoteBody = z
  .object({
    provider: Provider,
    marketId: MarketId,
    side: z.enum(['yes', 'no']),
    amountUsdc: Amount,
  })
  .strict();
const BuildBody = z
  .object({
    provider: Provider,
    marketId: MarketId,
    side: z.enum(['yes', 'no']),
    amountUsdc: Amount,
    quoteId: z.string().min(1).max(128).optional(),
    maxSlippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS).optional(),
    wallet: Base58Key.optional(),
    riskAccepted: z.boolean(),
    riskWarningVersion: z.string().max(32).optional(),
  })
  .strict();
const SubmittedBody = z.object({ orderId: z.string().uuid(), signature: Base58Sig }).strict();
const OrderParams = z.object({ orderId: z.string().uuid() });
const OrdersQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationFailedError({ issues: r.error.issues });
  return r.data;
}

function geo(req: FastifyRequest): RequestGeo {
  return readGeo(req.ctx.config, req.headers);
}

/**
 * Register the Real Markets routes.
 * @param app - The Fastify instance.
 */
export function registerRealMarketsRoutes(app: FastifyInstance): void {
  const read = { preHandler: [requireCapability('realMarkets'), requireAuth] };
  const write = {
    preHandler: [requireCapability('realMarkets'), requireAuth, withIdempotency()],
  };

  app.get('/v1/real-markets/config', read, async (req, reply) =>
    reply.send(await realMarketsConfig(req.ctx, req.user!.sub, geo(req))),
  );

  app.get('/v1/real-markets/markets', read, async (req, reply) => {
    const q = parse(ListQuery, req.query);
    return reply.send(
      await listRealMarkets(req.ctx, req.user!.sub, geo(req), {
        provider: q.provider,
        category: q.category ?? null,
        cursor: q.cursor ?? null,
        limit: q.limit,
      }),
    );
  });

  app.get('/v1/real-markets/markets/:marketId', read, async (req, reply) => {
    const { marketId } = parse(MarketParams, req.params);
    const { provider } = parse(ProviderQuery, req.query);
    return reply.send(await getRealMarket(req.ctx, req.user!.sub, geo(req), provider, marketId));
  });

  app.post('/v1/real-markets/quote', write, async (req, reply) =>
    reply.send(await quoteRealOrder(req.ctx, req.user!.sub, geo(req), parse(QuoteBody, req.body))),
  );

  app.post('/v1/real-markets/order/build', write, async (req, reply) =>
    reply
      .status(201)
      .send(await buildRealOrder(req.ctx, req.user!.sub, geo(req), parse(BuildBody, req.body))),
  );

  app.post('/v1/real-markets/order/submitted', write, async (req, reply) => {
    const b = parse(SubmittedBody, req.body);
    return reply.send(
      await orderSubmitted(req.ctx, req.user!.sub, geo(req), b.orderId, b.signature),
    );
  });

  app.get('/v1/real-markets/orders', read, async (req, reply) => {
    const q = parse(OrdersQuery, req.query);
    return reply.send(await listOrders(req.ctx, req.user!.sub, geo(req), q.limit));
  });

  app.get('/v1/real-markets/orders/:orderId', read, async (req, reply) => {
    const { orderId } = parse(OrderParams, req.params);
    return reply.send(await getOrder(req.ctx, req.user!.sub, geo(req), orderId));
  });

  app.get('/v1/real-markets/positions', read, async (req, reply) => {
    const { provider } = parse(ProviderQuery, req.query);
    return reply.send(await positionsFor(req.ctx, req.user!.sub, geo(req), provider));
  });
}
