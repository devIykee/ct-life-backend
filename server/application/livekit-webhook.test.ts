/**
 * LiveKit + ORE webhook tests.
 *
 * Tests WebhookReceiver integration and exercises the DB paths.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { AccessToken } from 'livekit-server-sdk';
import { createHash, createHmac } from 'node:crypto';

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';

loadDotenv({ path: process.cwd() + '/.env' });

_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

beforeAll(async () => {
  // Clear the prior test data from webhook_events so the
  // signature uniqueness check starts clean.
  await pool.query(`DELETE FROM webhook_events WHERE source IN ('livekit', 'ore')`);
});

afterAll(async () => {
  await pool.end();
});

/**
 * Create a valid LiveKit webhook body + auth header pair.
 * Uses the same signing approach as LiveKit's WebhookReceiver.
 */
async function createLiveKitWebhook(
  apiKey: string,
  apiSecret: string,
  event: Record<string, unknown>,
): Promise<{ body: string; authHeader: string }> {
  const body = JSON.stringify(event);
  const bodyHash = createHash('sha256').update(body).digest('base64');
  const at = new AccessToken(apiKey, apiSecret, { ttl: '5m' });
  at.sha256 = bodyHash;
  const token = await at.toJwt();
  return { body, authHeader: token };
}

/**
 * Helper for ORE webhook tests - creates a simple payload.signature token
 * matching the verifyOreSignature format (not a full JWT).
 * The signature is HMAC-SHA256 of the decoded payload string, not the base64.
 */
async function createOreWebhook(secret: string): Promise<string> {
  const payload = JSON.stringify({ event: 'round_end', roundId: 'test-round' });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  // Sign the payload string, not the base64
  const sig = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  return `Bearer ${payloadB64}.${sig}`;
}

describe('livekit-webhook', () => {
  it('rejects missing Authorization', async () => {
    const ctx = buildContext();
    const { verifyLiveKitWebhook } = await import('./livekit-webhook.js');
    const body = JSON.stringify({ event: 'room_started' });
    await expect(verifyLiveKitWebhook(ctx, body, undefined)).rejects.toThrow();
    await expect(verifyLiveKitWebhook(ctx, body, '')).rejects.toThrow();
  });

  it('rejects tampered body', async () => {
    const ctx = buildContext();
    const { verifyLiveKitWebhook } = await import('./livekit-webhook.js');
    const { body, authHeader } = await createLiveKitWebhook(
      ctx.config.livekit.apiKey,
      ctx.config.livekit.apiSecret,
      { event: 'room_started', room: { name: 'test' } },
    );
    const tamperedBody = body.replace('test', 'hacked');
    await expect(verifyLiveKitWebhook(ctx, tamperedBody, authHeader)).rejects.toThrow();
  });

  it('rejects wrong secret', async () => {
    const ctx = buildContext();
    const { verifyLiveKitWebhook } = await import('./livekit-webhook.js');
    const { body, authHeader } = await createLiveKitWebhook('wrong-key', 'wrong-secret', {
      event: 'room_started',
    });
    await expect(verifyLiveKitWebhook(ctx, body, authHeader)).rejects.toThrow();
  });

  it('accepts valid webhook', async () => {
    const ctx = buildContext();
    const { verifyLiveKitWebhook } = await import('./livekit-webhook.js');
    const { body, authHeader } = await createLiveKitWebhook(
      ctx.config.livekit.apiKey,
      ctx.config.livekit.apiSecret,
      { event: 'room_started', room: { name: 'test-room' }, createdAt: Date.now() },
    );
    const event = await verifyLiveKitWebhook(ctx, body, authHeader);
    expect(event.event).toBe('room_started');
    expect(event.room?.name).toBe('test-room');
  });

  it('room_finished marks voice_rooms ended + speakers left', async () => {
    const ctx = buildContext();
    const { applyLiveKitEvent } = await import('./livekit-webhook.js');
    // Seed a voice_rooms row. host_user_id must exist as a user
    // row (the table FK on host_user_id references users).
    const ownerId = '00000000-0000-7000-8000-000000000001';
    await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      ownerId,
      `whOwner-${ownerId}`,
    ]);
    const roomId = `space:wh-test-${Date.now()}`;
    await pool.query(
      `INSERT INTO voice_rooms (room_id, host_user_id, kind, title, status)
       VALUES ($1, $2::uuid, 'space', 'wh test', 'live')`,
      [roomId, ownerId],
    );
    const sig = `sig-${Date.now()}-${Math.random()}`;
    await applyLiveKitEvent(ctx, sig, {
      event: 'room_finished',
      room: { name: roomId },
    });
    const r = await pool.query<{ status: string }>(
      `SELECT status FROM voice_rooms WHERE room_id = $1`,
      [roomId],
    );
    expect(r.rows[0]?.status).toBe('ended');
    // Replay is idempotent — no error, no extra row.
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM webhook_events WHERE source = 'livekit' AND signature = $1`,
      [sig],
    );
    await applyLiveKitEvent(ctx, sig, {
      event: 'room_finished',
      room: { name: roomId },
    });
    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM webhook_events WHERE source = 'livekit' AND signature = $1`,
      [sig],
    );
    expect(before.rows[0]?.count).toBe(after.rows[0]?.count);
  });

  it('participant_left marks voice_speakers.left_at', async () => {
    const ctx = buildContext();
    const { applyLiveKitEvent } = await import('./livekit-webhook.js');
    const roomId = `space:wh-participant-${Date.now()}`;
    const userId = '00000000-0000-7000-8000-000000000002';
    await pool.query(
      `INSERT INTO voice_rooms (room_id, host_user_id, kind, title, status)
       VALUES ($1, $2::uuid, 'space', 'wh p', 'live')`,
      [roomId, userId],
    );
    await pool.query(
      `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2::uuid, 'listener')`,
      [roomId, userId],
    );
    await applyLiveKitEvent(ctx, `sig-p-${Date.now()}`, {
      event: 'participant_left',
      room: { name: roomId },
      participant: { identity: userId },
    });
    const r = await pool.query<{ left_at: Date | null }>(
      `SELECT left_at FROM voice_speakers WHERE room_id = $1 AND user_id = $2::uuid`,
      [roomId, userId],
    );
    expect(r.rows[0]?.left_at).not.toBeNull();
  });
});

describe('ore-webhook', () => {
  it('rejects missing Authorization', async () => {
    const ctx = buildContext();
    const { verifyOreSignature } = await import('./ore-webhook.js');
    expect(() => verifyOreSignature(ctx, undefined)).toThrow();
  });

  it('accepts a token signed with the configured secret', async () => {
    const ctx = buildContext();
    const tok = await createOreWebhook(ctx.config.livekit.webhookSecret);
    const { verifyOreSignature } = await import('./ore-webhook.js');
    expect(() => verifyOreSignature(ctx, tok)).not.toThrow();
  });

  it('applyOreEvent records the round_end and is idempotent', async () => {
    const ctx = buildContext();
    const { applyOreEvent } = await import('./ore-webhook.js');
    const sig = `ore-sig-${Date.now()}`;
    await applyOreEvent(ctx, sig, { event: 'round_end', roundId: 'r-1' });
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM webhook_events WHERE source = 'ore' AND signature = $1`,
      [sig],
    );
    expect(Number(r.rows[0]?.count)).toBe(1);
    await applyOreEvent(ctx, sig, { event: 'round_end', roundId: 'r-1' });
    const r2 = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM webhook_events WHERE source = 'ore' AND signature = $1`,
      [sig],
    );
    expect(Number(r2.rows[0]?.count)).toBe(1);
  });
});
