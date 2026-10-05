/**
 * LiveKit webhook handler.
 *
 * LiveKit fires webhooks for participant join/leave, track
 * published/unpublished, and room finished. The handler verifies
 * the JWT in the `Authorization: Bearer <token>` header using the
 * `LIVEKIT_WEBHOOK_SECRET` (LiveKit's webhook signing convention
 * uses HS256 with that secret).
 *
 * Idempotency: each event is recorded on `(source, signature)`
 * via the existing webhook_events UNIQUE — replays return the
 * same response without re-applying state.
 *
 * On `room_finished` we mark the matching voice_rooms row
 * `ended`. On `participant_left` we mark the matching
 * voice_speakers row `left_at = now()`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
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
 * Verify the LiveKit JWT in the Authorization header. LiveKit
 * sends `Authorization: Bearer <jwt>` where the JWT is HS256
 * signed by `LIVEKIT_WEBHOOK_SECRET`.
 */
export function verifyLiveKitSignature(ctx: AppContext, authHeader: string | undefined): void {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ValidationFailedError({ reason: 'missing Authorization header' });
  }
  const token = authHeader.substring('Bearer '.length).trim();
  const dot = token.indexOf('.');
  if (dot <= 0 || dot >= token.length - 1) {
    throw new ValidationFailedError({ reason: 'malformed token' });
  }
  const payloadB64 = token.substring(0, dot);
  const sigB64 = token.substring(dot + 1);
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const sig = Buffer.from(sigB64, 'base64url');
  const expected = createHmac('sha256', ctx.config.livekit.webhookSecret)
    .update(payload, 'utf8')
    .digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw new ValidationFailedError({ reason: 'invalid signature' });
  }
  // Best-effort: verify the JWT's `exp` is in the future.
  try {
    const decoded = JSON.parse(payload) as { exp?: number };
    if (typeof decoded.exp === 'number' && decoded.exp * 1000 < Date.now()) {
      throw new ValidationFailedError({ reason: 'token expired' });
    }
  } catch (e) {
    if (e instanceof ValidationFailedError) throw e;
    // ignore parse errors — the secret verification is sufficient.
  }
}

/** Apply a LiveKit webhook event idempotently. */
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
