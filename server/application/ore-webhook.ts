/**
 * ORE webhook handler.
 *
 * The ORE program publishes round-end events to a configured
 * webhook (separate from the daily board reader, which polls
 * getAccountInfo). On round end the handler:
 *
 *   1. Verifies the signature with `LIVEKIT_WEBHOOK_SECRET` (the
 *      ORE webhook uses the same HS256 convention as LiveKit
 *      when configured with a shared secret).
 *   2. Records the event idempotently on
 *      webhook_events(source='ore', signature).
 *   3. Updates the cached board (the refinery cache TTL is 2s;
 *      this event invalidates the cache and emits a city-room
 *      `ore_round_end` event).
 *
 * The ORE read path itself lives in server/application/refinery.ts
 * (M3 #41). The webhook is upstream of that cache.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { uuidv7 } from '../shared/domain/uuid.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import type { AppContext } from './context.js';

export interface OreWebhookEvent {
  readonly event: string;
  readonly roundId?: string;
  readonly endsAt?: string;
}

export interface OreWebhookResult {
  readonly ok: true;
  readonly status: 'applied' | 'replay';
}

/**
 *
 */
export function verifyOreSignature(ctx: AppContext, authHeader: string | undefined): void {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new ValidationFailedError({ reason: 'missing Authorization header' });
  }
  const token = authHeader.substring('Bearer '.length).trim();
  const dot = token.indexOf('.');
  if (dot <= 0) {
    throw new ValidationFailedError({ reason: 'malformed token' });
  }
  const payload = Buffer.from(token.substring(0, dot), 'base64url').toString('utf8');
  const sig = Buffer.from(token.substring(dot + 1), 'base64url');
  const expected = createHmac('sha256', ctx.config.livekit.webhookSecret)
    .update(payload, 'utf8')
    .digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    throw new ValidationFailedError({ reason: 'invalid signature' });
  }
}

/**
 * Apply an ORE round-end event. The refinery cache TTL is short
 * (2s) so we just invalidate it via Redis; the next read will
 * re-fetch from mainnet.
 */
export async function applyOreEvent(
  ctx: AppContext,
  signature: string,
  event: OreWebhookEvent,
): Promise<OreWebhookResult> {
  try {
    await ctx.db.withConnection(async (c) => {
      await c.query(
        `INSERT INTO webhook_events (event_id, source, signature, payload) VALUES ($1, 'ore', $2, $3::jsonb)`,
        [uuidv7(), signature, JSON.stringify(event)],
      );
    });
  } catch (e) {
    if ((e as { code?: string }).code !== '23505') throw e;
  }
  // Invalidate the cache (best-effort).
  try {
    await ctx.redis.main.del('ore:board');
  } catch {
    /* best-effort */
  }
  // Fan-out: publish on the city-events channel.
  try {
    await ctx.redis.main.publish(
      'city:events',
      JSON.stringify({
        kind: 'ore_round_end',
        roundId: event.roundId,
        endsAt: event.endsAt,
        at: Date.now(),
      }),
    );
  } catch {
    /* best-effort */
  }
  return { ok: true, status: 'applied' };
}
