/**
 * Group chat routes (docs/GROUPS.md).
 *
 *   GET    /v1/groups                                   my groups (joins my tribe chat)
 *   POST   /v1/groups                                   {kind: friends|alpha, name, inviteUserIds?}
 *   GET    /v1/groups/invites                           direct invites waiting for me
 *   GET    /v1/groups/:id                               info sheet
 *   PATCH  /v1/groups/:id                               {name?, rules?, slowMode?}
 *   GET    /v1/groups/:id/members
 *   POST   /v1/groups/:id/members/:userId/remove        owner/mod (bans from rejoining)
 *   POST   /v1/groups/:id/members/:userId/role          {role: mod|member} owner
 *   POST   /v1/groups/:id/leave
 *   POST   /v1/groups/:id/mute                          {hours}
 *   POST   /v1/groups/:id/read
 *   POST   /v1/groups/:id/report                        {reasonId, note?}
 *   POST   /v1/groups/:id/invites                       {maxUses?, ttlHours?} -> link
 *   POST   /v1/groups/:id/invites/user                  {userId} direct invite
 *   GET    /v1/invites/:code                            preview
 *   POST   /v1/invites/:code/accept | /decline
 *   GET    /v1/groups/:id/messages?topic=&before=
 *   POST   /v1/groups/:id/messages                      {topic, text | coinId+targetX+stopPct}
 *   DELETE /v1/groups/:id/messages/:messageId
 *   GET    /v1/venues/:venueId/booths
 *   POST   /v1/groups/:id/booth                         {venueId, boothId}
 *   DELETE /v1/groups/:id/booth
 */
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { withIdempotency } from '../middleware/idempotency.js';
import { withRateLimit } from '../middleware/rate-limit.js';
import { RateLimitedError, ValidationFailedError } from '../../shared/domain/errors.js';
import { perUserTokenBucket } from '../../shared/infra/rate-limit.js';
import {
  acceptInvite,
  claimBooth,
  createGroup,
  createInviteLink,
  declineInvite,
  deleteMessage,
  getGroup,
  inviteUser,
  leaveGroup,
  listBooths,
  listMembers,
  listMessages,
  listMyGroups,
  listMyInvites,
  markRead,
  MESSAGE_MAX,
  muteGroup,
  postMessage,
  previewInvite,
  releaseBooth,
  removeMember,
  reportGroup,
  setMemberRole,
  updateGroup,
} from '../../application/groups.js';

const Id = z.object({ id: z.string().uuid() });
const IdUser = z.object({ id: z.string().uuid(), userId: z.string().uuid() });
const IdMsg = z.object({ id: z.string().uuid(), messageId: z.string().uuid() });
const Code = z.object({ code: z.string().regex(/^[A-Za-z0-9]{10}$/) });
const Venue = z.object({ venueId: z.string().min(1).max(64) });
const Topic = z.enum(['chat', 'calls', 'wins']);

const CreateBody = z
  .object({
    kind: z.enum(['friends', 'alpha']),
    name: z.string().min(1).max(40),
    inviteUserIds: z.array(z.string().uuid()).max(49).optional(),
  })
  .strict();
const PatchBody = z
  .object({
    name: z.string().min(1).max(40).optional(),
    rules: z.string().max(500).optional(),
    slowMode: z.record(Topic, z.number().int().min(0).max(300)).optional(),
  })
  .strict();
const RoleBody = z.object({ role: z.enum(['mod', 'member']) }).strict();
const MuteBody = z.object({ hours: z.number().int().min(0).max(8760) }).strict();
const ReportBody = z.object({ reasonId: z.string().min(1), note: z.string().max(500).optional() });
const InviteLinkBody = z
  .object({
    maxUses: z.number().int().min(1).max(1000).optional(),
    ttlHours: z.number().int().min(1).max(720).optional(),
  })
  .strict();
const InviteUserBody = z.object({ userId: z.string().uuid() }).strict();
const MessagesQuery = z.object({
  topic: Topic.default('chat'),
  before: z.string().datetime().optional(),
});
const PostBody = z.discriminatedUnion('topic', [
  z.object({ topic: z.literal('chat'), text: z.string().min(1).max(MESSAGE_MAX) }).strict(),
  z
    .object({
      topic: z.literal('calls'),
      coinId: z.string().uuid(),
      targetX: z.number().min(1.05).max(100),
      stopPct: z.number().min(1).max(95),
      text: z.string().max(MESSAGE_MAX).optional(),
    })
    .strict(),
  z
    .object({
      topic: z.literal('wins'),
      coinId: z.string().uuid(),
      text: z.string().max(MESSAGE_MAX).optional(),
    })
    .strict(),
]);
const BoothBody = z.object({ venueId: z.string().min(1), boothId: z.string().min(1) }).strict();

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationFailedError({ issues: r.error.issues });
  return r.data;
}

/** Group messages: a burst of 10, then 1 a second, per player (on top of slow mode). */
function messageLimit(): preHandlerHookHandler {
  return async (req) => {
    const d = await perUserTokenBucket(
      req.ctx.redis.main,
      `rl:groupmsg:${req.user?.sub ?? 'anon'}`,
      10,
      1,
      1,
    );
    if (!d.allowed) throw new RateLimitedError(d.retryAfterMs, { limit: 10 });
  };
}

/**
 * Register the group chat routes.
 * @param app - The Fastify instance.
 */
export function registerGroupRoutes(app: FastifyInstance): void {
  const read = { preHandler: requireAuth };
  const write = { preHandler: [requireAuth, withIdempotency(), withRateLimit()] };
  const me = (req: { user?: { sub: string } }): string => req.user!.sub;

  app.get('/v1/groups', read, async (req, reply) =>
    reply.send({ groups: await listMyGroups(req.ctx, me(req)) }),
  );
  app.post('/v1/groups', write, async (req, reply) =>
    reply.status(201).send(await createGroup(req.ctx, me(req), parse(CreateBody, req.body))),
  );
  app.get('/v1/groups/invites', read, async (req, reply) =>
    reply.send({ invites: await listMyInvites(req.ctx, me(req)) }),
  );
  app.get('/v1/groups/:id', read, async (req, reply) =>
    reply.send(await getGroup(req.ctx, me(req), parse(Id, req.params).id)),
  );
  app.patch('/v1/groups/:id', write, async (req, reply) =>
    reply.send(
      await updateGroup(req.ctx, me(req), parse(Id, req.params).id, parse(PatchBody, req.body)),
    ),
  );
  app.get('/v1/groups/:id/members', read, async (req, reply) =>
    reply.send({ members: await listMembers(req.ctx, me(req), parse(Id, req.params).id) }),
  );
  app.post('/v1/groups/:id/members/:userId/remove', write, async (req, reply) => {
    const p = parse(IdUser, req.params);
    await removeMember(req.ctx, me(req), p.id, p.userId);
    return reply.status(204).send();
  });
  app.post('/v1/groups/:id/members/:userId/role', write, async (req, reply) => {
    const p = parse(IdUser, req.params);
    await setMemberRole(req.ctx, me(req), p.id, p.userId, parse(RoleBody, req.body).role);
    return reply.status(204).send();
  });
  app.post('/v1/groups/:id/leave', write, async (req, reply) => {
    await leaveGroup(req.ctx, me(req), parse(Id, req.params).id);
    return reply.status(204).send();
  });
  app.post('/v1/groups/:id/mute', write, async (req, reply) =>
    reply.send(
      await muteGroup(req.ctx, me(req), parse(Id, req.params).id, parse(MuteBody, req.body).hours),
    ),
  );
  app.post('/v1/groups/:id/read', write, async (req, reply) => {
    await markRead(req.ctx, me(req), parse(Id, req.params).id);
    return reply.status(204).send();
  });
  app.post('/v1/groups/:id/report', write, async (req, reply) => {
    const b = parse(ReportBody, req.body);
    return reply
      .status(201)
      .send(
        await reportGroup(req.ctx, me(req), parse(Id, req.params).id, b.reasonId, b.note ?? null),
      );
  });
  app.post('/v1/groups/:id/invites', write, async (req, reply) =>
    reply
      .status(201)
      .send(
        await createInviteLink(
          req.ctx,
          me(req),
          parse(Id, req.params).id,
          parse(InviteLinkBody, req.body ?? {}),
        ),
      ),
  );
  app.post('/v1/groups/:id/invites/user', write, async (req, reply) =>
    reply
      .status(201)
      .send(
        await inviteUser(
          req.ctx,
          me(req),
          parse(Id, req.params).id,
          parse(InviteUserBody, req.body).userId,
        ),
      ),
  );
  app.get('/v1/invites/:code', read, async (req, reply) =>
    reply.send(await previewInvite(req.ctx, me(req), parse(Code, req.params).code)),
  );
  app.post('/v1/invites/:code/accept', write, async (req, reply) =>
    reply.send(await acceptInvite(req.ctx, me(req), parse(Code, req.params).code)),
  );
  app.post('/v1/invites/:code/decline', write, async (req, reply) => {
    await declineInvite(req.ctx, me(req), parse(Code, req.params).code);
    return reply.status(204).send();
  });
  app.get('/v1/groups/:id/messages', read, async (req, reply) => {
    const q = parse(MessagesQuery, req.query);
    return reply.send(
      await listMessages(req.ctx, me(req), parse(Id, req.params).id, q.topic, q.before ?? null),
    );
  });
  app.post(
    '/v1/groups/:id/messages',
    { preHandler: [requireAuth, withIdempotency(), withRateLimit(), messageLimit()] },
    async (req, reply) =>
      reply
        .status(201)
        .send(
          await postMessage(req.ctx, me(req), parse(Id, req.params).id, parse(PostBody, req.body)),
        ),
  );
  app.delete('/v1/groups/:id/messages/:messageId', write, async (req, reply) => {
    const p = parse(IdMsg, req.params);
    await deleteMessage(req.ctx, me(req), p.id, p.messageId);
    return reply.status(204).send();
  });
  app.get('/v1/venues/:venueId/booths', read, async (req, reply) =>
    reply.send({ booths: await listBooths(req.ctx, parse(Venue, req.params).venueId) }),
  );
  app.post('/v1/groups/:id/booth', write, async (req, reply) => {
    const b = parse(BoothBody, req.body);
    return reply
      .status(201)
      .send(await claimBooth(req.ctx, me(req), parse(Id, req.params).id, b.venueId, b.boothId));
  });
  app.delete('/v1/groups/:id/booth', write, async (req, reply) => {
    await releaseBooth(req.ctx, me(req), parse(Id, req.params).id);
    return reply.status(204).send();
  });
}
