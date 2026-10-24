/**
 * Opt-in IRL check-in: geofence, window, mock and accuracy rejection, account
 * age, the one-time bonus, the attendee board (opt-in, blocks both ways,
 * pagination), the city announcement, and the privacy guarantees (no
 * coordinates in the table, redacted by the logger). Controlled clock.
 */
import { Pool } from 'pg';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  CheckinRejectedError,
  EventNotLiveError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { _resetEventsSyncForTests, listUpcoming } from './events.js';
import { checkIn, distanceM, irlBonusCents, listAttendees, setVisibility } from './events-irl.js';
import { listInventory } from './cosmetics.js';
import { publishToUser } from './realtime-bus.js';
import { REDACT_PATHS } from '../shared/logger/logger.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const BP = 'breakpoint-2026';
const DURING = new Date('2026-11-16T12:00:00Z');
const VENUE = { lat: 51.49639, lng: -0.20972 };
const INSIDE = { ...VENUE, accuracyM: 20, isMock: false };
// ~1.1 km north of the venue.
const OUTSIDE = { lat: 51.5064, lng: -0.20972, accuracyM: 20, isMock: false };

let n = 0;
async function newUser(opts: { createdAt?: string; alias?: boolean } = {}): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet, created_at) VALUES ($1, $2, $3)`, [
    id,
    `irl-${id}`,
    opts.createdAt ?? '2026-10-01T00:00:00Z',
  ]);
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, 0, 0)`, [
    id,
  ]);
  if (opts.alias !== false) {
    await pool.query(
      `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
       VALUES ($1, $2, $3, '{"skin":1}', 'degens', '{}', 'x', 'h')`,
      [uuidv7(), id, `irl${Date.now().toString(36)}${n++}`],
    );
  }
  return id;
}
const cashOf = async (id: string): Promise<number> =>
  Number(
    (await pool.query(`SELECT cash_cents FROM balances WHERE user_id = $1`, [id])).rows[0]
      .cash_cents,
  );
const reason = (e: unknown): unknown => (e as CheckinRejectedError).details?.reason;

beforeAll(async () => {
  _resetEventsSyncForTests();
  await listUpcoming(ctx, 1, new Date('2026-10-23T00:00:00Z'));
});
beforeEach(() => vi.mocked(publishToUser).mockClear());
afterAll(async () => {
  await pool.end();
});

describe('geometry', () => {
  it('measures metres', () => {
    expect(distanceM(VENUE.lat, VENUE.lng, VENUE.lat, VENUE.lng)).toBeCloseTo(0, 3);
    const d = distanceM(VENUE.lat, VENUE.lng, OUTSIDE.lat, OUTSIDE.lng);
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1300);
  });
});

describe('check-in rules', () => {
  it('accepts inside the geofence and pays the one-time IRL reward once', async () => {
    const u = await newUser();
    const r = await checkIn(ctx, u, BP, INSIDE, DURING);
    expect(r).toMatchObject({ checkedIn: true, visible: false, firstCheckin: true });
    expect(r.reward).toEqual({
      cashCents: 10000,
      itemKeys: ['irl_badge_breakpoint_2026', 'lanyard_breakpoint_2026_gold'],
    });
    expect(await cashOf(u)).toBe(10000);
    const keys = (await listInventory(ctx, u)).map((i) => `${i.itemKey}:${i.source}`);
    expect(keys).toContain('irl_badge_breakpoint_2026:grant');
    expect(keys).toContain('lanyard_breakpoint_2026_gold:grant');

    const again = await checkIn(ctx, u, BP, INSIDE, new Date(DURING.getTime() + 60_000));
    expect(again.firstCheckin).toBe(false);
    expect(again.reward).toBeNull();
    expect(again.checkedInAt).toBe(r.checkedInAt);
    expect(await cashOf(u)).toBe(10000);
    const ledger = await pool.query(
      `SELECT 1 FROM ledger_entries WHERE user_id = $1 AND reason = 'event_irl_bonus'`,
      [u],
    );
    expect(ledger.rowCount).toBe(1);
  });

  it('pays once under concurrent check-ins', async () => {
    const u = await newUser();
    await Promise.all([1, 2, 3].map(() => checkIn(ctx, u, BP, INSIDE, DURING)));
    expect(await cashOf(u)).toBe(10000);
  });

  it('rejects outside the geofence, at the radius edge', async () => {
    const u = await newUser();
    const e = await checkIn(ctx, u, BP, OUTSIDE, DURING).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CheckinRejectedError);
    expect(reason(e)).toBe('outside_geofence');
    expect(JSON.stringify((e as CheckinRejectedError).details)).not.toMatch(/\d{2}\.\d/);
    // ~300 m north is inside (350 m radius), ~400 m is not.
    const at = (m: number) => ({ ...INSIDE, lat: VENUE.lat + m / 111_195 });
    expect((await checkIn(ctx, u, BP, at(300), DURING)).checkedIn).toBe(true);
    const v = await newUser();
    expect(reason(await checkIn(ctx, v, BP, at(400), DURING).catch((x: unknown) => x))).toBe(
      'outside_geofence',
    );
    expect(await cashOf(v)).toBe(0);
  });

  it('rejects outside the event window', async () => {
    const u = await newUser();
    for (const t of ['2026-11-14T23:59:59Z', '2026-11-18T00:00:00Z']) {
      await expect(checkIn(ctx, u, BP, INSIDE, new Date(t))).rejects.toBeInstanceOf(
        EventNotLiveError,
      );
    }
    expect(await cashOf(u)).toBe(0);
  });

  it('rejects a mock location and poor accuracy', async () => {
    const u = await newUser();
    const mock = await checkIn(ctx, u, BP, { ...INSIDE, isMock: true }, DURING).catch(
      (x: unknown) => x,
    );
    expect(reason(mock)).toBe('mock_location');
    const bad = await checkIn(ctx, u, BP, { ...INSIDE, accuracyM: 151 }, DURING).catch(
      (x: unknown) => x,
    );
    expect(reason(bad)).toBe('poor_accuracy');
    expect((await checkIn(ctx, u, BP, { ...INSIDE, accuracyM: 150 }, DURING)).checkedIn).toBe(true);
  });

  it('rejects an account created at or after the event start', async () => {
    const late = await newUser({ createdAt: '2026-11-15T00:00:00Z' });
    expect(reason(await checkIn(ctx, late, BP, INSIDE, DURING).catch((x: unknown) => x))).toBe(
      'account_too_new',
    );
    expect(await cashOf(late)).toBe(0);
    const ok = await newUser({ createdAt: '2026-11-14T23:59:59Z' });
    expect((await checkIn(ctx, ok, BP, INSIDE, DURING)).checkedIn).toBe(true);
  });

  it('honours EVENT_IRL_BONUS_CENTS', () => {
    process.env.EVENT_IRL_BONUS_CENTS = '2500';
    expect(irlBonusCents()).toBe(2500);
    process.env.EVENT_IRL_BONUS_CENTS = 'junk';
    expect(irlBonusCents()).toBe(10000);
    delete process.env.EVENT_IRL_BONUS_CENTS;
    expect(irlBonusCents()).toBe(10000);
  });
});

describe('attendee board', () => {
  it('shows only opted-in attendees, hides blocked users both ways, paginates', async () => {
    const viewer = await newUser();
    const shown = await newUser();
    const second = await newUser();
    const hidden = await newUser();
    const blockedByViewer = await newUser();
    const blocksViewer = await newUser();
    for (const u of [shown, second, hidden, blockedByViewer, blocksViewer]) {
      await checkIn(ctx, u, BP, INSIDE, DURING);
    }
    await pool.query(
      `INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2), ($3, $4)`,
      [viewer, blockedByViewer, blocksViewer, viewer],
    );
    for (const u of [shown, second, blockedByViewer, blocksViewer]) {
      await setVisibility(ctx, u, BP, true, DURING);
    }
    const aliasOf = async (id: string): Promise<string> =>
      (await pool.query(`SELECT alias FROM characters WHERE user_id = $1`, [id])).rows[0].alias;

    const board = await listAttendees(ctx, viewer, BP, 50, null);
    const aliases = board.items.map((i) => i.alias);
    expect(aliases).toContain(await aliasOf(shown));
    expect(aliases).not.toContain(await aliasOf(hidden));
    expect(aliases).not.toContain(await aliasOf(blockedByViewer));
    expect(aliases).not.toContain(await aliasOf(blocksViewer));
    const shownAlias = await aliasOf(shown);
    const row = board.items.find((i) => i.alias === shownAlias)!;
    expect(Object.keys(row).sort()).toEqual([
      'alias',
      'avatarId',
      'checkedInAt',
      'look',
      'tribeId',
    ]);
    expect(JSON.stringify(board)).not.toMatch(/lat|lng|user_?id/i);

    // The blocked user sees the viewer's side excluded too.
    const other = await listAttendees(ctx, blockedByViewer, BP, 50, null);
    expect(other.items.map((i) => i.alias)).not.toContain(await aliasOf(viewer));

    const p1 = await listAttendees(ctx, viewer, BP, 1, null);
    expect(p1.items).toHaveLength(1);
    expect(p1.next).not.toBeNull();
    const p2 = await listAttendees(ctx, viewer, BP, 1, p1.next);
    expect(p2.items[0]!.alias).not.toBe(p1.items[0]!.alias);
    await expect(listAttendees(ctx, viewer, BP, 1, 'garbage')).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('is invisible by default, needs a check-in to toggle, and announces the alias only', async () => {
    const u = await newUser();
    await expect(setVisibility(ctx, u, BP, true, DURING)).rejects.toBeInstanceOf(NotFoundError);
    const r = await checkIn(ctx, u, BP, INSIDE, DURING);
    expect(r.visible).toBe(false);
    expect(vi.mocked(publishToUser)).not.toHaveBeenCalled();

    await ctx.redis.main.del(`irl:ann:evt_cal_breakpoint_2026:${u}`);
    await setVisibility(ctx, u, BP, true, DURING);
    const call = vi.mocked(publishToUser).mock.calls.find((c) => c[2] === 'irl_checkin');
    expect(call).toBeDefined();
    expect(call![1]).toBe('*');
    expect(Object.keys(call![3]).sort()).toEqual(['alias', 'at', 'slug']);

    // Toggling again is rate limited: no second announcement.
    await setVisibility(ctx, u, BP, false, DURING);
    await setVisibility(ctx, u, BP, true, DURING);
    expect(vi.mocked(publishToUser).mock.calls.filter((c) => c[2] === 'irl_checkin')).toHaveLength(
      1,
    );
  });
});

describe('privacy', () => {
  it('stores no position: the table has exactly four columns', async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'event_checkins' ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'checked_in_at',
      'event_id',
      'user_id',
      'visible',
    ]);
  });

  it('redacts coordinates and request bodies from log lines', () => {
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } },
      { write: (s: string) => void lines.push(s) },
    );
    log.info({ lat: 51.49639, lng: -0.20972, accuracyM: 12 }, 'direct');
    log.info({ body: { lat: 51.49639, lng: -0.20972 } }, 'body');
    log.info({ req: { method: 'POST', body: { lat: 51.49639, lng: -0.20972 } } }, 'req');
    log.info({ position: { lat: 51.49639, lng: -0.20972, accuracyM: 3 } }, 'nested');
    const all = lines.join('\n');
    expect(all).not.toContain('51.49639');
    expect(all).not.toContain('-0.20972');
    expect(all).toContain('[REDACTED]');
  });
});
