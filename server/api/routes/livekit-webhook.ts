/**
 * LiveKit webhook receiver (unlock C2).
 *
 *   POST /v1/webhooks/livekit   LiveKit server -> us (signed JWT in Authorization)
 *
 * Verifies the event with livekit-server-sdk's WebhookReceiver (JWT signature and the
 * body hash, so the raw body is kept exactly), records it, and applies the voice-room
 * bookkeeping (application/livekit-webhook.ts). For a paid call, a participant leaving
 * or the room finishing ends the call and settles it, timed by the server. Joins and
 * leaves on street voice rooms (`proximity:*`) count against the daily street voice
 * minutes, and every join there is checked again: a participant who is not in that
 * street instance (left, kicked, a kept or refreshed token) or is out of minutes is
 * removed at once (application/street-voice.ts).
 *
 * LiveKit posts `Content-Type: application/webhook+json`; this file registers a raw
 * string parser for that type only.
 */
import { mediaPlayerId } from '../../shared/livekit/identity.js';
import {
  isPlayerMediaDeparture,
  isGameMediaRoom,
  reconcileMediaParticipant,
} from '../../application/media-access.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applyLiveKitEvent, verifyLiveKitWebhook } from '../../application/livekit-webhook.js';
import { endPaidCallFromRoom } from '../../application/paid-calls.js';
import { isCapabilityOn } from '../../application/capabilities.js';
import {
  checkStreetVoiceJoin,
  recordStreetVoiceEvent,
  STREET_VOICE_KIND,
} from '../../application/street-voice.js';

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
    const room = event.room?.name ?? '';
    const identity = event.participant?.identity;
    let mediaAccepted = true;
    if (event.event === 'participant_joined' && identity && isGameMediaRoom(room))
      mediaAccepted = await reconcileMediaParticipant(req.ctx, room, identity);
    const result = await applyLiveKitEvent(req.ctx, key, event);
    const paid = PAID_ROOM.exec(event.room?.name ?? '');
    if (
      paid &&
      isCapabilityOn(req.ctx, 'paidCalls') &&
      (event.event === 'room_finished' ||
        (event.event === 'participant_left' &&
          identity &&
          (await isPlayerMediaDeparture(req.ctx, room, identity))))
    ) {
      await endPaidCallFromRoom(req.ctx, paid[1]!, event.event);
    }
    await recordStreetVoiceEvent(req.ctx, key, event);
    if (
      mediaAccepted &&
      event.event === 'participant_joined' &&
      identity &&
      room.startsWith(`${STREET_VOICE_KIND}:`)
    ) {
      const refusal = await checkStreetVoiceJoin(
        req.ctx,
        room,
        mediaPlayerId(identity) ?? '',
        Date.now(),
      );
      if (refusal) {
        req.log.info({ room, refusal }, 'street voice: participant removed on join');
        await req.ctx.livekit.removeParticipant(req.ctx, {
          kind: STREET_VOICE_KIND,
          id: room.slice(STREET_VOICE_KIND.length + 1),
          identity,
          exact: true,
        });
      }
    }
    return reply.send(result);
  });
}
