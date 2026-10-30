/**
 * The beef phase worker is scheduled (every 15 s) only while the app
 * capability `beef` is on, and its scheduler is removed when it is off.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { buildContext, _resetContextForTests } from '../application/context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { BEEF_PHASES_EVERY_MS, BEEF_PHASES_QUEUE, startBeefPhases } from './beef.js';

const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379/0');
const conn = {
  host: url.hostname,
  port: Number(url.port || 6379),
  db: Number(url.pathname.slice(1) || 0),
  maxRetriesPerRequest: null,
};
const saved = process.env.CAPABILITIES_ON;
const log = { info: (): void => undefined, error: (): void => undefined };

function ctxWith(caps: string): ReturnType<typeof buildContext> {
  process.env.CAPABILITIES_ON = caps;
  _resetConfigForTests();
  _resetContextForTests();
  return buildContext();
}

afterAll(() => {
  if (saved === undefined) delete process.env.CAPABILITIES_ON;
  else process.env.CAPABILITIES_ON = saved;
  _resetConfigForTests();
  _resetContextForTests();
});

describe('beef phase worker scheduling', () => {
  it('schedules while beef is on and removes the scheduler when off', async () => {
    const q = new Queue(BEEF_PHASES_QUEUE, { connection: conn });
    try {
      const on = await startBeefPhases(ctxWith('beef'), conn, new Redis(conn), log);
      const scheds = await q.getJobSchedulers();
      const s = scheds.find((x) => x.key === 'beef-phases' || x.id === 'beef-phases');
      expect(s).toBeDefined();
      expect(Number(s!.every)).toBe(BEEF_PHASES_EVERY_MS);
      await on.close();
      const off = await startBeefPhases(ctxWith(''), conn, new Redis(conn), log);
      expect(
        (await q.getJobSchedulers()).some((x) => x.key === 'beef-phases' || x.id === 'beef-phases'),
      ).toBe(false);
      await off.close();
    } finally {
      await q.obliterate({ force: true });
      await q.close();
    }
  });
});
