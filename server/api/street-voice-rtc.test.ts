/**
 * Street voice: POST /v1/rtc/token {kind: 'proximity'} and the LiveKit
 * webhook. A token for `proximity:<district>:<instanceId>` only for someone
 * the street room has counted in that instance (shared Redis presence), only
 * while `streetVoice` is on, only with minutes left today, and only for 2
 * minutes. Every `participant_joined` is checked again (a kept or refreshed
 * token after leaving is removed). Minutes come from the webhook, keyed by
 * participant SID.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedisPresence } from 'colyseus';
import { AccessToken } from 'livekit-server-sdk';
import { Redis } from 'ioredis';
import { bootApi, type TestApi, type TestPlayer } from './http-test-kit.js';
import { buildContext } from '../application/context.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  clearStreetMembers,
  markStreetJoin,
  markStreetLeave,
  streetMembersKey,
} from '../realtime/street-presence.js';
import {
  checkStreetVoiceJoin,
  recordStreetVoiceEvent,
  streetVoiceRemovals,
  streetVoiceSecondsToday,
  streetVoiceSessions,
  utcDay,
  type StreetVoiceEvent,
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

const nowSec = (): number => Math.floor(Date.now() / 1000);

function ev(
  event: 'participant_joined' | 'participant_left',
  user: string,
  room: string,
  sid: string,
  atSec: number,
): StreetVoiceEvent {
  return { event, room: { name: room }, participant: { identity: user, sid }, createdAt: atSec };
}

/** Simulate LiveKit's webhook for one closed street voice session of `user`. */
async function session(user: string, room: string, startSec: number, endSec: number) {
  const ctx = buildContext();
  const sid = `PA_${uuidv7()}`;
  await recordStreetVoiceEvent(ctx, uuidv7(), ev('participant_joined', user, room, sid, startSec));
  await recordStreetVoiceEvent(ctx, uuidv7(), ev('participant_left', user, room, sid, endSec));
}

/** Forget every street voice counter and open session (one test Redis, files run one at a time). */
async function clearMinutes(...users: string[]): Promise<void> {
  const day = utcDay(Date.now());
  await redis.del(
    'ctl:voice:street:sessions',
    `ctl:voice:street:sec:${day}:total`,
    ...users.map((u) => `ctl:voice:street:sec:${day}:u:${u}`),
  );
}

const token = (api: TestApi, who: TestPlayer, id: string) =>
  api.call(who, 'POST', '/v1/rtc/token', { kind: 'proximity', id });

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
  });

  beforeEach(async () => {
    await clearMinutes(a.sub, b.sub);
  });

  afterAll(async () => {
    await clearMinutes(a.sub, b.sub);
    await api.stop();
  });

  it('refuses a player who is not in that street instance with NOT_IN_AREA', async () => {
    const r = await token(api, a, `timeline:${inst()}`);
    expect(r.status).toBe(403);
    expect((r.body.error as { code: string }).code).toBe('NOT_IN_AREA');
  });

  it('mints a 2-minute token for a member of the instance only, for that district only', async () => {
    const id = inst();
    try {
      await markStreetJoin(presence, 'timeline', id, a.sub);
      const r = await token(api, a, `timeline:${id}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.roomName).toBe(`proximity:timeline:${id}`);
      expect(grant(r.body.token as string)).toMatchObject({
        room: `proximity:timeline:${id}`,
        canPublish: true,
        canSubscribe: true,
      });
      // Short-lived: a token kept after leaving is soon useless for a new connection.
      const ttl = (Date.parse(r.body.expiresAt as string) - Date.now()) / 1000;
      expect(ttl).toBeGreaterThan(100);
      expect(ttl).toBeLessThanOrEqual(121);
      const prefixed = await token(api, a, `proximity:timeline:${id}`);
      expect(prefixed.status).toBe(200);
      expect(prefixed.body.roomName).toBe(`proximity:timeline:${id}`);
      // Another player, the same instance under another district (the neighbour's
      // room: no cross-district voice), and another instance all get nothing.
      for (const [who, id2] of [
        [b, `timeline:${id}`],
        [a, `trenches:${id}`],
        [a, `timeline:${inst()}`],
      ] as const) {
        const r2 = await token(api, who, id2);
        expect(r2.status).toBe(403);
        expect((r2.body.error as { code: string }).code).toBe('NOT_IN_AREA');
      }
      // Two sessions: present until both have left.
      await markStreetJoin(presence, 'timeline', id, a.sub);
      await markStreetLeave(presence, 'timeline', id, a.sub);
      expect((await token(api, a, `timeline:${id}`)).status).toBe(200);
      await markStreetLeave(presence, 'timeline', id, a.sub);
      expect((await token(api, a, `timeline:${id}`)).status).toBe(403);
      // The room going away forgets everyone.
      await markStreetJoin(presence, 'timeline', id, a.sub);
      clearStreetMembers(presence, 'timeline', id);
      await new Promise((r2) => setTimeout(r2, 50));
      expect(await redis.exists(streetMembersKey('timeline', id))).toBe(0);
      expect((await token(api, a, `timeline:${id}`)).status).toBe(403);
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
      expect((await token(api, a, id)).status, id).toBe(400);
    }
  });

  it("stops minting once the player or the deployment used today's minutes", async () => {
    const id = inst();
    const room = `proximity:timeline:${id}`;
    const now = nowSec();
    try {
      await markStreetJoin(presence, 'timeline', id, a.sub);
      await markStreetJoin(presence, 'timeline', id, b.sub);
      // 90 s used: still under a's 2 minutes.
      await session(a.sub, room, now - 200, now - 110);
      expect(await streetVoiceSecondsToday(redis, a.sub, Date.now())).toBe(90);
      expect((await token(api, a, `timeline:${id}`)).status).toBe(200);
      // An open session counts while it runs: 40 s more puts a over 2 minutes.
      await recordStreetVoiceEvent(
        buildContext(),
        uuidv7(),
        ev('participant_joined', a.sub, room, `PA_${uuidv7()}`, now - 40),
      );
      const over = await token(api, a, `timeline:${id}`);
      expect(over.status).toBe(429);
      const err = over.body.error as { code: string; details: Record<string, unknown> };
      expect(err.code).toBe('VOICE_MINUTES_EXHAUSTED');
      expect(err.details).toMatchObject({ scope: 'player', capMinutes: 2 });
      expect(Date.parse(err.details.resetsAt as string)).toBeGreaterThan(Date.now());
      // b is fine until the deployment's 5 minutes are gone: 130 s so far.
      expect((await token(api, b, `timeline:${id}`)).status).toBe(200);
      // An open session of b's (no leave yet) counts towards the total too: 130 + 180 > 300.
      await recordStreetVoiceEvent(
        buildContext(),
        uuidv7(),
        ev('participant_joined', b.sub, room, `PA_${uuidv7()}`, now - 180),
      );
      const total = await token(api, b, `timeline:${id}`);
      expect(total.status).toBe(429);
      expect((total.body.error as { details: Record<string, unknown> }).details).toMatchObject({
        scope: 'total',
        capMinutes: 5,
      });
    } finally {
      await redis.del(streetMembersKey('timeline', id));
    }
  });

  describe('sessions are keyed by participant SID', () => {
    it('counts each webhook event once and ignores rooms that are not street voice', async () => {
      const ctx = buildContext();
      const room = `proximity:boardwalk:${inst()}`;
      const now = nowSec();
      const joined = ev('participant_joined', a.sub, room, 'PA_once', now - 60);
      const left = ev('participant_left', a.sub, room, 'PA_once', now - 30);
      const ids = [`j-${uuidv7()}`, `l-${uuidv7()}`];
      expect(await recordStreetVoiceEvent(ctx, ids[0]!, joined)).toBe(true);
      expect(await recordStreetVoiceEvent(ctx, ids[1]!, left)).toBe(true);
      // LiveKit retrying the same events changes nothing.
      expect(await recordStreetVoiceEvent(ctx, ids[0]!, joined)).toBe(false);
      expect(await recordStreetVoiceEvent(ctx, ids[1]!, left)).toBe(false);
      // Venue voice, Spaces and other events are not street minutes.
      expect(
        await recordStreetVoiceEvent(ctx, uuidv7(), { ...joined, room: { name: 'venue:inst-1' } }),
      ).toBe(false);
      expect(
        await recordStreetVoiceEvent(ctx, uuidv7(), { ...joined, event: 'track_published' }),
      ).toBe(false);
      expect(await streetVoiceSecondsToday(redis, a.sub, Date.now())).toBe(30);
    });

    it('overlapping sessions of one user in one room close only on their own leave', async () => {
      const ctx = buildContext();
      const room = `proximity:timeline:${inst()}`;
      const now = nowSec();
      // A reconnect: the new participant joins before the old one's leave arrives.
      await recordStreetVoiceEvent(
        ctx,
        uuidv7(),
        ev('participant_joined', a.sub, room, 'PA_old', now - 100),
      );
      await recordStreetVoiceEvent(
        ctx,
        uuidv7(),
        ev('participant_joined', a.sub, room, 'PA_new', now - 50),
      );
      await recordStreetVoiceEvent(
        ctx,
        uuidv7(),
        ev('participant_left', a.sub, room, 'PA_old', now - 40),
      );
      // PA_old: 60 s closed. PA_new is still open (keyed by room it would have been lost).
      const open = await streetVoiceSessions(redis, Date.now());
      expect(open.map((s) => s.sid)).toEqual(['PA_new']);
      const used = await streetVoiceSecondsToday(redis, a.sub, Date.now());
      expect(used).toBeGreaterThanOrEqual(60 + 50);
      expect(used).toBeLessThanOrEqual(60 + 52);
      // A leave for a SID nobody opened keeps every entry...
      expect(
        await recordStreetVoiceEvent(
          ctx,
          uuidv7(),
          ev('participant_left', a.sub, room, 'PA_x', now),
        ),
      ).toBe(false);
      expect((await streetVoiceSessions(redis, Date.now())).map((s) => s.sid)).toEqual(['PA_new']);
      // ...and its late join (out of order) opens nothing that would never close.
      expect(
        await recordStreetVoiceEvent(
          ctx,
          uuidv7(),
          ev('participant_joined', a.sub, room, 'PA_x', now - 5),
        ),
      ).toBe(false);
      // A leave naming another identity for that SID does not close it.
      expect(
        await recordStreetVoiceEvent(
          ctx,
          uuidv7(),
          ev('participant_left', b.sub, room, 'PA_new', now),
        ),
      ).toBe(false);
      expect((await streetVoiceSessions(redis, Date.now())).map((s) => s.sid)).toEqual(['PA_new']);
    });
  });

  describe('revocation', () => {
    async function webhook(body: Record<string, unknown>) {
      const ctx = buildContext();
      const raw = JSON.stringify({ id: `EV_${uuidv7()}`, createdAt: nowSec(), ...body });
      const at = new AccessToken(ctx.config.livekit.apiKey, ctx.config.livekit.apiSecret, {
        ttl: '5m',
      });
      at.sha256 = createHash('sha256').update(raw).digest('base64');
      return api.app.inject({
        method: 'POST',
        url: '/v1/webhooks/livekit',
        headers: { 'content-type': 'application/webhook+json', authorization: await at.toJwt() },
        payload: raw,
      });
    }

    it('a join with a kept token after leaving or a kick is removed again; a member stays', async () => {
      const id = inst();
      const room = `proximity:timeline:${id}`;
      const ctx = buildContext();
      const remove = vi.spyOn(ctx.livekit, 'removeParticipant').mockResolvedValue(undefined);
      try {
        await markStreetJoin(presence, 'timeline', id, a.sub);
        const member = await webhook({
          event: 'participant_joined',
          room: { name: room },
          participant: { identity: a.sub, sid: `PA_${uuidv7()}` },
        });
        expect(member.statusCode, member.body).toBe(200);
        expect(remove).not.toHaveBeenCalled();
        // Left (or banned out: a ban closes the session); a kept token reconnects.
        await markStreetLeave(presence, 'timeline', id, a.sub);
        const back = await webhook({
          event: 'participant_joined',
          room: { name: room },
          participant: { identity: a.sub, sid: `PA_${uuidv7()}` },
        });
        expect(back.statusCode, back.body).toBe(200);
        expect(remove).toHaveBeenCalledWith(expect.anything(), {
          kind: 'proximity',
          id: `timeline:${id}`,
          identity: a.sub,
        });
        expect(await checkStreetVoiceJoin(ctx, room, a.sub, Date.now())).toBe('not_in_area');
        // Venue rooms are not this check's business.
        expect(await checkStreetVoiceJoin(ctx, `venue:${id}`, a.sub, Date.now())).toBeNull();
      } finally {
        remove.mockRestore();
        await redis.del(streetMembersKey('timeline', id));
      }
    });

    it('a member out of minutes who reconnects is removed on join', async () => {
      const id = inst();
      const room = `proximity:timeline:${id}`;
      const ctx = buildContext();
      const remove = vi.spyOn(ctx.livekit, 'removeParticipant').mockResolvedValue(undefined);
      try {
        await markStreetJoin(presence, 'timeline', id, a.sub);
        await session(a.sub, room, nowSec() - 400, nowSec() - 250); // 150 s > 2 min
        expect(await checkStreetVoiceJoin(ctx, room, a.sub, Date.now())).toBe('minutes_player');
        const r = await webhook({
          event: 'participant_joined',
          room: { name: room },
          participant: { identity: a.sub, sid: `PA_${uuidv7()}` },
        });
        expect(r.statusCode, r.body).toBe(200);
        expect(remove).toHaveBeenCalledTimes(1);
      } finally {
        remove.mockRestore();
        await redis.del(streetMembersKey('timeline', id));
      }
    });

    it('the room sweep covers everyone connected to its voice room, members or not, and both caps', async () => {
      const id = inst();
      const room = `proximity:timeline:${id}`;
      const ctx = buildContext();
      const now = nowSec();
      try {
        await markStreetJoin(presence, 'timeline', id, a.sub);
        await markStreetJoin(presence, 'timeline', id, b.sub);
        const stranger = `u-${uuidv7()}`;
        // Connected and members, under the caps: nobody to remove.
        for (const u of [a.sub, b.sub]) {
          await recordStreetVoiceEvent(
            ctx,
            uuidv7(),
            ev('participant_joined', u, room, `PA_${uuidv7()}`, now - 10),
          );
        }
        expect(await streetVoiceRemovals(ctx, 'timeline', id, Date.now())).toEqual([]);
        // Connected to the voice room without being in the street instance (a removal
        // that failed on leave, or a kept token): removed by the sweep.
        await recordStreetVoiceEvent(
          ctx,
          uuidv7(),
          ev('participant_joined', stranger, room, `PA_${uuidv7()}`, now - 10),
        );
        expect(await streetVoiceRemovals(ctx, 'timeline', id, Date.now())).toEqual([stranger]);
        // A past the per-player cap (open session included).
        await session(a.sub, room, now - 300, now - 190);
        expect((await streetVoiceRemovals(ctx, 'timeline', id, Date.now())).sort()).toEqual(
          [a.sub, stranger].sort(),
        );
        // The deployment's 5 minutes gone, counting open sessions: everyone connected.
        await session(b.sub, room, now - 400, now - 220);
        expect((await streetVoiceRemovals(ctx, 'timeline', id, Date.now())).sort()).toEqual(
          [a.sub, b.sub, stranger].sort(),
        );
        // Another instance's room is not swept from here.
        expect(await streetVoiceRemovals(ctx, 'timeline', inst(), Date.now())).toEqual([]);
      } finally {
        await redis.del(streetMembersKey('timeline', id));
      }
    });
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
      const r = await token(api, p, `islet:${id}`);
      expect(r.status).toBe(200);
      expect(
        await checkStreetVoiceJoin(buildContext(), `proximity:islet:${id}`, p.sub, Date.now()),
      ).toBeNull();
      await clearMinutes(p.sub);
    } finally {
      await api.stop();
      await redis.del(streetMembersKey('islet', id));
    }
  });
});

afterAll(async () => {
  await redis.quit();
});
