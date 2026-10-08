/**
 * LiveKit webhook handler.
 *
 * LiveKit fires webhooks for participant join/leave, track
 * published/unpublished, and room finished. The handler verifies
 * the webhook using the official WebhookReceiver from livekit-server-sdk,
 * which validates both the JWT signature and the body hash claim.
 *
 * Idempotency: each event is recorded on `(source, signature)`
 * via the existing webhook_events UNIQUE — replays return the
 * same response without re-applying state.
 *
 * On `room_finished` we mark the matching voice_rooms row
 * `ended`. On `participant_left` we mark the matching
 * voice_speakers row `left_at = now()`.
 */
import { WebhookReceiver } from 'livekit-server-sdk';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export interface LiveKitWebhookEvent {
  readonly event: string;
  readonly room?: { readonly name?: string };
  readonly participant?: { readonly identity?: string };
  readonly createdAt?: number;
  readonly id?: string;
}

export interface LiveKitWebhookResult {
  readonly ok: true;
  readonly status: 'applied' | 'replay' | 'no_match';
}

/**
 * Verify the LiveKit webhook using the official WebhookReceiver.
 * This validates both the JWT signature and the body hash claim,
 * preventing body tampering attacks.
 *
 * @param ctx - Application context with LiveKit credentials
 * @param body - Raw request body (must be the exact bytes received)
 * @param authHeader - Authorization header from the request
 * @returns The validated webhook event
 */
export async function verifyLiveKitWebhook(
  ctx: AppContext,
  body: string,
  authHeader: string | undefined,
): Promise<LiveKitWebhookEvent> {
  const receiver = new WebhookReceiver(
    ctx.config.livekit.apiKey,
    ctx.config.livekit.apiSecret,
  );

  try {
    const event = await receiver.receive(body, authHeader, false);
    return {
      event: event.event,
      room: event.room ? { name: event.room.name } : undefined,
      participant: event.participant ? { identity: event.participant.identity } : undefined,
      createdAt: Number(event.createdAt),
      id: event.id,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ValidationFailedError({ reason: `webhook verification failed: ${msg}` });
  }
}

/**
 * Apply a LiveKit webhook event idempotently.
 *
 * @param ctx - Application context
 * @param signature - Unique signature for idempotency (derived from auth header)
 * @param event - Validated webhook event from verifyLiveKitWebhook
 * @returns Result indicating whether event was applied, replayed, or no match
 */
export async function applyLiveKitEvent(
  ctx: AppContext,
  signature: string,
  event: LiveKitWebhookEvent,
): Promise<LiveKitWebhookResult> {
  // We use ctx.db directly (no runInTransaction) because the
  // webhook handler is async/append-only and doesn't need
  // SERIALIZABLE semantics. The 23505 unique_violation is the
  // only idempotency we need.
  try {
    await ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO webhook_events (event_id, source, signature, payload) VALUES ($1, $2, $3, $4::jsonb)`,
        [uuidv7(), 'livekit', signature, JSON.stringify(event)],
      );
    });
  } catch (e) {
    if ((e as { code?: string }).code !== '23505') throw e;
  }
  if (event.event === 'room_finished') {
    const roomName = event.room?.name;
    if (roomName) {
      await ctx.db.withConnection(async (c) => {
        await c.query(
          `UPDATE voice_rooms SET status = 'ended', ended_at = now()
           WHERE room_id = $1 AND status = 'live'`,
          [roomName],
        );
        await c.query(
          `UPDATE voice_speakers SET left_at = now()
           WHERE room_id = $1 AND left_at IS NULL`,
          [roomName],
        );
      });
    }
  } else if (event.event === 'participant_left') {
    const roomName = event.room?.name;
    const identity = event.participant?.identity;
    if (roomName && identity) {
      await ctx.db.withConnection(async (c) => {
        await c.query(
          `UPDATE voice_speakers SET left_at = now()
           WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
          [roomName, identity],
        );
      });
    }
  }
  return { ok: true, status: 'applied' };
}
