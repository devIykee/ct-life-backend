/**
 * LiveKit webhook receiver (unlock C2).
 *
 *   POST /v1/webhooks/livekit   LiveKit server -> us (signed JWT in Authorization)
 *
 * Verifies the event with livekit-server-sdk's WebhookReceiver (JWT signature and the
 * body hash, so the raw body is kept exactly), records it, and applies the voice-room
 * bookkeeping (application/livekit-webhook.ts). For a paid call, a participant leaving
 * or the room finishing ends the call and settles it, timed by the server.
 *
 * LiveKit posts `Content-Type: application/webhook+json`; this file registers a raw
 * string parser for that type only.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applyLiveKitEvent, verifyLiveKitWebhook } from '../../application/livekit-webhook.js';
import { endPaidCallFromRoom } from '../../application/paid-calls.js';
import { isCapabilityOn } from '../../application/capabilities.js';

const PAID_ROOM = /^paid_call:([0-9a-f-]{36})$/;

/**
 * Register the LiveKit webhook route.
 * @param app - The Fastify instance.
 */
export function registerLiveKitWebhookRoutes(app: FastifyInstance): void {
  app.addContentTypeParser('application/webhook+json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    done(null, {});
  });

  app.post('/v1/webhooks/livekit', async (req: FastifyRequest, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(req.body);
    const event = await verifyLiveKitWebhook(req.ctx, raw, req.headers.authorization);
    const key = event.id ?? createHash('sha256').update(raw).digest('hex');
    const result = await applyLiveKitEvent(req.ctx, key, event);
    const paid = PAID_ROOM.exec(event.room?.name ?? '');
    if (
      paid &&
      isCapabilityOn(req.ctx, 'paidCalls') &&
      (event.event === 'participant_left' || event.event === 'room_finished')
    ) {
      await endPaidCallFromRoom(req.ctx, paid[1]!, event.event);
    }
    return reply.send(result);
  });
}
