/**
 * Social routes (M3 #45).
 *
 *   GET  /v1/dms?peerUserId=&cursor=
 *   GET  /v1/dms/:userId?before=
 *   POST /v1/dms/:userId
 *   GET  /v1/feed?scope=global|following
 *   POST /v1/feed/posts
 *   POST /v1/follows/:userId
 *   DELETE /v1/follows/:userId
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { requireUuidParam } from '../middleware/uuid-param.js';
import { ValidationFailedError } from '../../shared/domain/errors.js';
import {
  createPost,
  follow,
  isFollowing,
  listDms,
  listFeed,
  sendDm,
  unfollow,
} from '../../application/social-graph.js';

const DmBody = z.object({ text: z.string().min(1).max(500) });
const DmListQuery = z.object({
  peerUserId: z.string().uuid().optional(),
  before: z.string().optional(),
});
const DmPeerQuery = z.object({ before: z.string().optional() });
const FeedQuery = z.object({ scope: z.enum(['global', 'following']).default('global') });
const PostBody = z.object({ text: z.string().min(1).max(280) });

/**
 * Register M3 social routes (DMs, feed, follows).
 * @param app - The Fastify instance.
 */
export function registerSocialGraphRoutes(app: FastifyInstance): void {
  // GET /v1/dms?peerUserId=&cursor=
  app.get('/v1/dms', { preHandler: requireAuth }, async (req, reply) => {
    const q = DmListQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    if (q.data.peerUserId === undefined)
      throw new ValidationFailedError({ reason: 'peerUserId required' });
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

  // GET /v1/feed?scope=global|following
  app.get('/v1/feed', { preHandler: requireAuth }, async (req, reply) => {
    const q = FeedQuery.safeParse(req.query);
    if (!q.success) throw new ValidationFailedError({ issues: q.error.issues });
    const posts = await listFeed(req.ctx, req.user!.sub, q.data.scope);
    return reply.send({ posts });
  });

  // POST /v1/feed/posts
  app.post(
    '/v1/feed/posts',
    { preHandler: [requireAuth, withIdempotency()] },
    async (req, reply) => {
      const body = PostBody.safeParse(req.body);
      if (!body.success) throw new ValidationFailedError({ issues: body.error.issues });
      const post = await createPost(req.ctx, req.user!.sub, body.data.text);
      return reply.status(201).send(post);
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
