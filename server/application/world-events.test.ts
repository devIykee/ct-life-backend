/**
 * Recent world events in Redis: record, trim to 2 h and 50, read newest first,
 * clean params, and the once-per-window guard the city shards use.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import {
  WORLD_EVENTS_KEY,
  WORLD_EVENTS_MAX,
  WORLD_EVENTS_WINDOW_MS,
  cleanParams,
  listActiveWorldEvents,
  recordWorldEvent,
  recordWorldEventOnce,
} from './world-events.js';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379/0');

beforeEach(async () => {
  await redis.del(WORLD_EVENTS_KEY, `${WORLD_EVENTS_KEY}:once:mood`);
});

afterAll(async () => {
  await redis.del(WORLD_EVENTS_KEY, `${WORLD_EVENTS_KEY}:once:mood`);
  await redis.quit();
});

describe('world events', () => {
  it('returns recorded events newest first with their params', async () => {
    const now = Date.now();
    await recordWorldEvent(redis, {
      eventId: 'evt_rug',
      at: now - 2000,
      params: { ticker: 'FROG' },
    });
    await recordWorldEvent(redis, { eventId: 'evt_coin_launch', at: now - 1000, params: {} });
    // Two identical events in the same millisecond are both kept.
    await recordWorldEvent(redis, { eventId: 'evt_exploit', at: now, params: {} });
    await recordWorldEvent(redis, { eventId: 'evt_exploit', at: now, params: {} });
    const list = await listActiveWorldEvents(redis, now);
    expect(list.map((e) => e.eventId)).toEqual([
      'evt_exploit',
      'evt_exploit',
      'evt_coin_launch',
      'evt_rug',
    ]);
    expect(list[3]).toEqual({ eventId: 'evt_rug', at: now - 2000, params: { ticker: 'FROG' } });
  });

  it('drops events older than 2 hours and keeps at most 50', async () => {
    const now = Date.now();
    await recordWorldEvent(redis, {
      eventId: 'evt_rug',
      at: now - WORLD_EVENTS_WINDOW_MS - 1,
      params: {},
    });
    for (let i = 0; i < WORLD_EVENTS_MAX + 5; i++) {
      await recordWorldEvent(redis, {
        eventId: 'evt_liquidation',
        at: now - 60_000 + i,
        params: {},
      });
    }
    expect(await redis.zcard(WORLD_EVENTS_KEY)).toBe(WORLD_EVENTS_MAX);
    const list = await listActiveWorldEvents(redis, now);
    expect(list).toHaveLength(WORLD_EVENTS_MAX);
    expect(list.every((e) => e.eventId === 'evt_liquidation')).toBe(true);
    // The oldest five were trimmed.
    expect(list[list.length - 1]!.at).toBe(now - 60_000 + 5);
    // Reading later hides what fell out of the window.
    expect(await listActiveWorldEvents(redis, now + WORLD_EVENTS_WINDOW_MS)).toHaveLength(0);
  });

  it('ignores malformed ids and keeps only bounded string params', async () => {
    await recordWorldEvent(redis, { eventId: 'not_an_event', at: Date.now(), params: {} });
    expect(await redis.zcard(WORLD_EVENTS_KEY)).toBe(0);
    const p = cleanParams({ ok: 'x'.repeat(500), 'bad key': 'a', n: 3 as unknown as string });
    expect(Object.keys(p)).toEqual(['ok']);
    expect(p.ok).toHaveLength(200);
  });

  it('records a shard-wide event once per window', async () => {
    const at = Date.now();
    const e = { eventId: 'evt_mood_change', at, params: { bps: '150' } };
    await recordWorldEventOnce(redis, e, 'mood', 15_000);
    await recordWorldEventOnce(redis, { ...e, at: at + 1 }, 'mood', 15_000);
    expect(await listActiveWorldEvents(redis, at + 1)).toHaveLength(1);
  });
});
