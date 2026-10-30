/**
 * POST /v1/rtc/token for Spaces: grants come from the stored Space and
 * role, never from the request body. For venues: a token only for someone
 * the venue room has counted as in that instance (shared Redis presence).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { buildServer, type ServerHandle } from './main.js';
import { buildContext } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { RedisPresence } from 'colyseus';
import { createRedis } from '../shared/redis/client.js';
import { clearVenueMembers, markVenueJoin, markVenueLeave } from '../realtime/venue-presence.js';

let handle: ServerHandle;
let pool: Pool;
let hostId: string;
let listenerId: string;
let spaceId: string;

function grant(token: string): { room: string; canPublish: boolean; canSubscribe: boolean } {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return payload.video;
}

async function tokenFor(userId: string, body: Record<string, unknown>) {
  const auth = await buildContext().jwt.signAccess(userId, `rtc-${userId}`, false);
  return handle.app.inject({
    method: 'POST',
    url: '/v1/rtc/token',
    headers: { authorization: `Bearer ${auth}` },
    payload: body,
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL });
  hostId = uuidv7();
  listenerId = uuidv7();
  spaceId = `space:${uuidv7()}`;
  await pool.query('INSERT INTO users (id, wallet) VALUES ($1, $2), ($3, $4)', [
    hostId,
    `rtc-host-${hostId}`,
    listenerId,
    `rtc-listener-${listenerId}`,
  ]);
  await pool.query(
    `INSERT INTO voice_rooms (room_id, host_user_id, kind, title) VALUES ($1, $2, 'space', 'rtc')`,
    [spaceId, hostId],
  );
  await pool.query(
    `INSERT INTO voice_speakers (speaker_id, room_id, user_id, role) VALUES ($1, $2, $3, 'host')`,
    [uuidv7(), spaceId, hostId],
  );
  handle = await buildServer();
  await handle.app.ready();
});

afterAll(async () => {
  if (handle) await handle.stop();
  await pool.end();
});

describe('POST /v1/rtc/token (space)', () => {
  it('gives the host a publishing grant on the single-prefix room', async () => {
    const res = await tokenFor(hostId, { kind: 'space', id: spaceId });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roomName).toBe(spaceId);
    expect(body.canPublish).toBe(true);
    expect(grant(body.token)).toMatchObject({ room: spaceId, canPublish: true });
  });

  it('ignores a listener asking for publish', async () => {
    const res = await tokenFor(listenerId, {
      kind: 'space',
      id: spaceId.slice('space:'.length),
      canPublish: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.canPublish).toBe(false);
    expect(grant(body.token)).toMatchObject({ room: spaceId, canPublish: false });
  });

  it('rejects a mismatched prefix and mints nothing for an ended Space', async () => {
    expect((await tokenFor(hostId, { kind: 'space', id: `video:${uuidv7()}` })).statusCode).toBe(
      400,
    );
    await pool.query(
      `UPDATE voice_rooms SET status = 'ended', ended_at = now() WHERE room_id = $1`,
      [spaceId],
    );
    expect((await tokenFor(hostId, { kind: 'space', id: spaceId })).statusCode).toBe(403);
  });
});

describe('POST /v1/rtc/token (venue)', () => {
  // The same presence the realtime process uses, on the test Redis.
  const presence = new RedisPresence(createRedis().main);

  it('refuses a user who is not in the instance with NOT_IN_VENUE', async () => {
    const instanceId = `inst-${uuidv7()}`;
    const res = await tokenFor(listenerId, { kind: 'venue', id: instanceId });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_IN_VENUE');
    // The legacy proximity kind is no way around it.
    const prox = await tokenFor(listenerId, { kind: 'proximity', id: instanceId });
    expect(prox.statusCode).toBe(403);
    expect(prox.json().error.code).toBe('NOT_IN_VENUE');
  });

  it('mints for a member only while a session of theirs is in that instance', async () => {
    const instanceId = `inst-${uuidv7()}`;
    await markVenueJoin(presence, instanceId, hostId);
    const res = await tokenFor(hostId, { kind: 'venue', id: instanceId });
    expect(res.statusCode).toBe(200);
    expect(res.json().roomName).toBe(`venue:${instanceId}`);
    expect(grant(res.json().token)).toMatchObject({ room: `venue:${instanceId}` });
    // A prefixed id names the same room.
    expect((await tokenFor(hostId, { kind: 'venue', id: `venue:${instanceId}` })).statusCode).toBe(
      200,
    );
    // Someone else, and the same user for a different instance, get nothing.
    expect((await tokenFor(listenerId, { kind: 'venue', id: instanceId })).statusCode).toBe(403);
    expect((await tokenFor(hostId, { kind: 'venue', id: `inst-${uuidv7()}` })).statusCode).toBe(
      403,
    );
    // Two sessions: present until both have left.
    await markVenueJoin(presence, instanceId, hostId);
    await markVenueLeave(presence, instanceId, hostId);
    expect((await tokenFor(hostId, { kind: 'venue', id: instanceId })).statusCode).toBe(200);
    await markVenueLeave(presence, instanceId, hostId);
    expect((await tokenFor(hostId, { kind: 'venue', id: instanceId })).statusCode).toBe(403);
    // A leave that ran after the hash was lost does not cost a rejoin.
    await markVenueLeave(presence, instanceId, hostId);
    await markVenueJoin(presence, instanceId, hostId);
    expect((await tokenFor(hostId, { kind: 'venue', id: instanceId })).statusCode).toBe(200);
    // The room going away forgets everyone.
    clearVenueMembers(presence, instanceId);
    await new Promise((r) => setTimeout(r, 50));
    expect((await tokenFor(hostId, { kind: 'venue', id: instanceId })).statusCode).toBe(403);
  });

  it('rejects a venue id carrying the prefix of another kind', async () => {
    expect((await tokenFor(hostId, { kind: 'venue', id: `space:${uuidv7()}` })).statusCode).toBe(
      400,
    );
  });
});
