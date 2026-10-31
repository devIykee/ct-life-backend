/**
 * POST /v1/rtc/token {kind: 'proximity'}: street voice. A token for
 * `proximity:<district>:<instanceId>` only for someone the street room has
 * counted in that instance (shared Redis presence), only while `streetVoice`
 * is on, and only with street voice minutes left today. Minutes come from the
 * LiveKit webhook (recordStreetVoiceEvent), driven directly here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisPresence } from 'colyseus';
import { bootApi, type TestApi, type TestPlayer } from './http-test-kit.js';
import { buildContext } from '../application/context.js';
import { Redis } from 'ioredis';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  clearStreetMembers,
  markStreetJoin,
  markStreetLeave,
  streetMembersKey,
} from '../realtime/street-presence.js';
import {
  recordStreetVoiceEvent,
  streetVoiceSecondsToday,
  usersOverStreetVoiceCap,
  utcDay,
} from '../application/street-voice.js';

// Its own client: the API's shared one is closed by each api.stop().
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
// The same presence the realtime process uses, on the test Redis.
const presence = new RedisPresence(redis);

function grant(token: string): { room: string; canPublish: boolean; canSubscribe: boolean } {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  return payload.video;
}

function inst(): string {
  return `i${uuidv7().replace(/-/g, '').slice(-12)}`;
}

/** Simulate LiveKit's webhook for one street voice session of `user`. */
async function session(user: string, room: string, startSec: number, endSec: number) {
  const ctx = buildContext();
  await recordStreetVoiceEvent(ctx, uuidv7(), {
    event: 'participant_joined',
    room: { name: room },
    participant: { identity: user },
    createdAt: startSec,
  });
  await recordStreetVoiceEvent(ctx, uuidv7(), {
    event: 'participant_left',
    room: { name: room },
    participant: { identity: user },
    createdAt: endSec,
  });
}

async function clearDay(user: string): Promise<void> {
  const day = utcDay(Date.now());
  await redis.del(
    `ctl:voice:street:sec:${day}:u:${user}`,
    `ctl:voice:street:open:${user}`,
    `ctl:voice:street:sec:${day}:total`,
  );
}

describe('POST /v1/rtc/token (proximity, street voice on)', () => {
  let api: TestApi;
  let a: TestPlayer;
  let b: TestPlayer;

  beforeAll(async () => {
    // 2 minutes per player, 5 for the deployment.
    api = await bootApi('streetVoice', {
      STREET_VOICE_DAILY_MINUTES_PER_PLAYER: '2',
      STREET_VOICE_DAILY_MINUTES_TOTAL: '5',
    });
    a = await api.player();
    b = await api.player();
    await clearDay(a.sub);
    await clearDay(b.sub);
  });

  afterAll(async () => {
    await clearDay(a.sub);
    await clearDay(b.sub);
    await api.stop();
  });

  it('refuses a player who is not in that street instance with NOT_IN_AREA', async () => {
    const r = await api.call(a, 'POST', '/v1/rtc/token', {
      kind: 'proximity',
      id: `timeline:${inst()}`,
    });
    expect(r.status).toBe(403);
    expect((r.body.error as { code: string }).code).toBe('NOT_IN_AREA');
  });

  it('mints for a member of the instance only, for that district only', async () => {
    const id = inst();
    try {
      await markStreetJoin(presence, 'timeline', id, a.sub);
      const r = await api.call(a, 'POST', '/v1/rtc/token', {
        kind: 'proximity',
        id: `timeline:${id}`,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.roomName).toBe(`proximity:timeline:${id}`);
      expect(grant(r.body.token as string)).toMatchObject({
        room: `proximity:timeline:${id}`,
        canPublish: true,
        canSubscribe: true,
      });
      // Short-lived: about 10 minutes, not the 1 h default.
      const ttl = (Date.parse(r.body.expiresAt as string) - Date.now()) / 1000;
      expect(ttl).toBeGreaterThan(9 * 60);
      expect(ttl).toBeLessThanOrEqual(10 * 60 + 1);
      // A prefixed id names the same room.
      const prefixed = await api.call(a, 'POST', '/v1/rtc/token', {
        kind: 'proximity',
        id: `proximity:timeline:${id}`,
      });
      expect(prefixed.status).toBe(200);
      expect(prefixed.body.roomName).toBe(`proximity:timeline:${id}`);
      // Another player, the same instance under another district (the neighbour's
      // room: no cross-district voice), and another instance all get nothing.
      for (const [who, body] of [
        [b, { kind: 'proximity', id: `timeline:${id}` }],
        [a, { kind: 'proximity', id: `trenches:${id}` }],
        [a, { kind: 'proximity', id: `timeline:${inst()}` }],
      ] as const) {
        const r2 = await api.call(who, 'POST', '/v1/rtc/token', body);
        expect(r2.status).toBe(403);
        expect((r2.body.error as { code: string }).code).toBe('NOT_IN_AREA');
      }
      // Two sessions: present until both have left.
      await markStreetJoin(presence, 'timeline', id, a.sub);
      await markStreetLeave(presence, 'timeline', id, a.sub);
      expect(
        (await api.call(a, 'POST', '/v1/rtc/token', { kind: 'proximity', id: `timeline:${id}` }))
          .status,
      ).toBe(200);
      await markStreetLeave(presence, 'timeline', id, a.sub);
      expect(
        (await api.call(a, 'POST', '/v1/rtc/token', { kind: 'proximity', id: `timeline:${id}` }))
          .status,
      ).toBe(403);
      // The room going away forgets everyone.
      await markStreetJoin(presence, 'timeline', id, a.sub);
      clearStreetMembers(presence, 'timeline', id);
      await new Promise((r2) => setTimeout(r2, 50));
      expect(await redis.exists(streetMembersKey('timeline', id))).toBe(0);
      expect(
        (await api.call(a, 'POST', '/v1/rtc/token', { kind: 'proximity', id: `timeline:${id}` }))
          .status,
      ).toBe(403);
    } finally {
      await redis.del(streetMembersKey('timeline', id));
    }
  });

  it('rejects malformed street ids with 400', async () => {
    for (const id of [
      inst(),
      `atlantis:${inst()}`,
      'timeline:',
      `space:${uuidv7()}`,
      'timeline:a:b',
    ]) {
      const r = await api.call(a, 'POST', '/v1/rtc/token', { kind: 'proximity', id });
      expect(r.status, id).toBe(400);
    }
  });

  it("stops minting once the player or the deployment used today's minutes", async () => {
    const id = inst();
    const room = `proximity:timeline:${id}`;
    const now = Math.floor(Date.now() / 1000);
    try {
      await markStreetJoin(presence, 'timeline', id, a.sub);
      await markStreetJoin(presence, 'timeline', id, b.sub);
      // 90 s used: still under a's 2 minutes.
      await session(a.sub, room, now - 200, now - 110);
      expect(await streetVoiceSecondsToday(redis, a.sub, Date.now())).toBe(90);
      expect(
        (await api.call(a, 'POST', '/v1/rtc/token', { kind: 'proximity', id: `timeline:${id}` }))
          .status,
      ).toBe(200);
      // An open session counts while it runs: 40 s more puts a over 2 minutes.
      await recordStreetVoiceEvent(buildContext(), uuidv7(), {
        event: 'participant_joined',
        room: { name: room },
        participant: { identity: a.sub },
        createdAt: now - 40,
      });
      const over = await api.call(a, 'POST', '/v1/rtc/token', {
        kind: 'proximity',
        id: `timeline:${id}`,
      });
      expect(over.status).toBe(429);
      const err = over.body.error as { code: string; details: Record<string, unknown> };
      expect(err.code).toBe('VOICE_MINUTES_EXHAUSTED');
      expect(err.details).toMatchObject({ scope: 'player', capMinutes: 2 });
      expect(Date.parse(err.details.resetsAt as string)).toBeGreaterThan(Date.now());
      // The street room's sweep finds a (connected, over) and not b.
      expect(await usersOverStreetVoiceCap(buildContext(), [a.sub, b.sub], Date.now())).toEqual([
        a.sub,
      ]);
      // b is fine until the deployment's 5 minutes are gone.
      expect(
        (await api.call(b, 'POST', '/v1/rtc/token', { kind: 'proximity', id: `timeline:${id}` }))
          .status,
      ).toBe(200);
      await session(b.sub, room, now - 400, now - 190); // 210 s; total closed 300 s
      const total = await api.call(b, 'POST', '/v1/rtc/token', {
        kind: 'proximity',
        id: `timeline:${id}`,
      });
      expect(total.status).toBe(429);
      expect((total.body.error as { details: Record<string, unknown> }).details).toMatchObject({
        scope: 'total',
        capMinutes: 5,
      });
    } finally {
      await redis.del(streetMembersKey('timeline', id));
      await clearDay(a.sub);
      await clearDay(b.sub);
    }
  });

  it('counts each webhook event once and ignores rooms that are not street voice', async () => {
    const ctx = buildContext();
    const user = `u-${uuidv7()}`;
    const room = `proximity:boardwalk:${inst()}`;
    const now = Math.floor(Date.now() / 1000);
    try {
      const joined = {
        event: 'participant_joined',
        room: { name: room },
        participant: { identity: user },
        createdAt: now - 60,
      };
      const left = { ...joined, event: 'participant_left', createdAt: now - 30 };
      expect(await recordStreetVoiceEvent(ctx, 'evt-j-' + user, joined)).toBe(true);
      expect(await recordStreetVoiceEvent(ctx, 'evt-l-' + user, left)).toBe(true);
      // LiveKit retrying the same events changes nothing.
      expect(await recordStreetVoiceEvent(ctx, 'evt-j-' + user, joined)).toBe(false);
      expect(await recordStreetVoiceEvent(ctx, 'evt-l-' + user, left)).toBe(false);
      // Venue voice, Spaces and other events are not street minutes.
      expect(
        await recordStreetVoiceEvent(ctx, uuidv7(), { ...joined, room: { name: 'venue:inst-1' } }),
      ).toBe(false);
      expect(
        await recordStreetVoiceEvent(ctx, uuidv7(), { ...joined, event: 'track_published' }),
      ).toBe(false);
      expect(await streetVoiceSecondsToday(redis, user, Date.now())).toBe(30);
    } finally {
      await clearDay(user);
      await redis.del(`ctl:voice:street:evt:evt-j-${user}`, `ctl:voice:street:evt:evt-l-${user}`);
    }
  });
});

describe('POST /v1/rtc/token (proximity, no caps)', () => {
  it('mints without minute checks when both caps are 0', async () => {
    const api = await bootApi('streetVoice', {
      STREET_VOICE_DAILY_MINUTES_PER_PLAYER: '0',
      STREET_VOICE_DAILY_MINUTES_TOTAL: '0',
    });
    const id = inst();
    try {
      const p = await api.player();
      await markStreetJoin(presence, 'islet', id, p.sub);
      await redis.set(`ctl:voice:street:sec:${utcDay(Date.now())}:u:${p.sub}`, '999999');
      const r = await api.call(p, 'POST', '/v1/rtc/token', {
        kind: 'proximity',
        id: `islet:${id}`,
      });
      expect(r.status).toBe(200);
      expect(await usersOverStreetVoiceCap(buildContext(), [p.sub], Date.now())).toEqual([]);
      await clearDay(p.sub);
    } finally {
      await api.stop();
      await redis.del(streetMembersKey('islet', id));
    }
  });
});

afterAll(async () => {
  await redis.quit();
});
