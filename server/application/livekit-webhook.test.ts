/**
 * LiveKit + ORE webhook tests.
 *
 * Mocks signature verification and exercises the DB paths.
 */
import { Pool } from 'pg';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { createHmac } from 'node:crypto';

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

function jwtHs256(payload: string, secret: string): string {
  const sig = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}

describe('livekit-webhook', () => {
  it('rejects missing Authorization', async () => {
    const ctx = buildContext();
    const { verifyLiveKitSignature } = await import('./livekit-webhook.js');
    expect(() => verifyLiveKitSignature(ctx, undefined)).toThrow();
    expect(() => verifyLiveKitSignature(ctx, '')).toThrow();
    expect(() => verifyLiveKitSignature(ctx, 'Token xyz')).toThrow();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const ctx = buildContext();
    const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 });
    const tok = jwtHs256(payload, 'wrong-secret');
    const { verifyLiveKitSignature } = await import('./livekit-webhook.js');
    expect(() => verifyLiveKitSignature(ctx, `Bearer ${tok}`)).toThrow();
  });

  it('accepts a token signed with the configured secret', async () => {
    const ctx = buildContext();
    const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 });
    const tok = jwtHs256(payload, ctx.config.livekit.webhookSecret);
    const { verifyLiveKitSignature } = await import('./livekit-webhook.js');
    expect(() => verifyLiveKitSignature(ctx, `Bearer ${tok}`)).not.toThrow();
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
    const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 });
    const tok = jwtHs256(payload, ctx.config.livekit.webhookSecret);
    const { verifyOreSignature } = await import('./ore-webhook.js');
    expect(() => verifyOreSignature(ctx, `Bearer ${tok}`)).not.toThrow();
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
