/**
 * Social routes (M3 #45).
 *
 *   GET  /v1/dms                  - inbox threads; ?peerUserId= reads one thread
 *   GET  /v1/dms/:userId?before=
 *   POST /v1/dms/:userId
 *   GET  /v1/feed?tab=foryou|following|city&type=&before=   (scope=global|following still works)
 *   POST /v1/feed/posts          {text, withPlace?}
 *   POST /v1/feed/checkins       {venueId}
 *   POST /v1/follows/:userId
 *   DELETE /v1/follows/:userId
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireUuidParam } from '../middleware/uuid-param.js';
import { RateLimitedError, ValidationFailedError } from '../../shared/domain/errors.js';
import {
  follow,
  isFollowing,
  listDms,
  listDmThreads,
  sendDm,
  unfollow,
} from '../../application/social-graph.js';
import { checkIn, CITY_KINDS, createPlayerPost, listTimeline } from '../../application/timeline.js';
import { withRateLimit } from '../middleware/rate-limit.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';

/** Timeline posts: a burst of 3, then one every 20 s, per player (separate from the write bucket). */
function feedPostLimit(): preHandlerHookHandler {
  return async (req) => {
    const d = await perUserTokenBucket(
      req.ctx.redis.main,
      `rl:feedpost:${req.user?.sub ?? 'anon'}`,
      3,
      1 / 20,
      1,
    );
    if (!d.allowed) throw new RateLimitedError(d.retryAfterMs, { limit: 3 });
  };
}

const DmBody = z.object({ text: z.string().min(1).max(500) });
const DmListQuery = z.object({
  peerUserId: z.string().uuid().optional(),
  before: z.string().optional(),
});
const DmPeerQuery = z.object({ before: z.string().optional() });
const FeedQuery = z.object({
  tab: z.enum(['foryou', 'following', 'city']).optional(),
  /** Older clients: global = For you, following = Following. */
  scope: z.enum(['global', 'following']).optional(),
  type: z.enum(['all', ...CITY_KINDS]).optional(),
  before: z.string().datetime().optional(),
});
const PostBody = z.object({
  text: z.string().min(1).max(280),
  withPlace: z.boolean().optional(),
});
const CheckinBody = z.object({ venueId: z.string().min(1).max(64) });

/**
 * Register M3 social routes (DMs, feed, follows).
 * @param app - The Fastify instance.
 */
export function registerSocialGraphRoutes(app: FastifyInstance): void {
  // GET /v1/dms: the inbox, one thread per peer. `?peerUserId=` is the
  // older spelling of GET /v1/dms/:userId and still returns that thread.
  app.get('/v1/dms', { preHandler: requireAuth }, async (req, reply) => {
    const q = DmListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    if (q.data.peerUserId === undefined) {
      return reply.send({ threads: await listDmThreads(req.ctx, req.user!.sub) });
    }
    const dms = await listDms(req.ctx, req.user!.sub, q.data.peerUserId, q.data.before ?? null);
    return reply.send({ messages: dms });
  });

  // GET /v1/dms/:userId?before=
  app.get(
    '/v1/dms/:userId',
    { preHandler: [requireAuth, requireUuidParam('userId')] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const q = DmPeerQuery.safeParse(req.query);
      if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
      const dms = await listDms(req.ctx, req.user!.sub, userId, q.data.before ?? null);
      return reply.send({ messages: dms });
    },
  );

  // POST /v1/dms/:userId
  app.post(
    '/v1/dms/:userId',
    { preHandler: [requireAuth, requireUuidParam('userId'), withIdempotency()] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      const body = DmBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const dm = await sendDm(req.ctx, req.user!.sub, userId, body.data.text);
      return reply.status(201).send(dm);
    },
  );

  // GET /v1/feed?tab=foryou|following|city&type=&before=
  app.get('/v1/feed', { preHandler: requireAuth }, async (req, reply) => {
    const q = FeedQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const tab = q.data.tab ?? (q.data.scope === 'following' ? 'following' : 'foryou');
    const page = await listTimeline(req.ctx, req.user!.sub, {
      tab,
      type: q.data.type,
      before: q.data.before ?? null,
    });
    return reply.send(page);
  });

  // POST /v1/feed/posts {text, withPlace?}
  app.post(
    '/v1/feed/posts',
    { preHandler: [requireAuth, withIdempotency(), withRateLimit(), feedPostLimit()] },
    async (req, reply) => {
      const body = PostBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const post = await createPlayerPost(req.ctx, req.user!.sub, body.data.text, {
        withPlace: body.data.withPlace,
      });
      return reply.status(201).send(post);
    },
  );

  // POST /v1/feed/checkins {venueId}: opt-in "is at <venue>".
  app.post(
    '/v1/feed/checkins',
    { preHandler: [requireAuth, withIdempotency(), withRateLimit()] },
    async (req, reply) => {
      const body = CheckinBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      return reply.status(201).send(await checkIn(req.ctx, req.user!.sub, body.data.venueId));
    },
  );

  // POST /v1/follows/:userId
  app.post(
    '/v1/follows/:userId',
    { preHandler: [requireAuth, requireUuidParam('userId'), withIdempotency()] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      await follow(req.ctx, req.user!.sub, userId);
      return reply.status(204).send();
    },
  );

  // DELETE /v1/follows/:userId
  app.delete(
    '/v1/follows/:userId',
    { preHandler: [requireAuth, requireUuidParam('userId'), withIdempotency()] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      await unfollow(req.ctx, req.user!.sub, userId);
      return reply.status(204).send();
    },
  );

  void isFollowing;
}
