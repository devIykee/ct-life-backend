/**
 * Breakpoint follow-ups: trivia retry (cooldown, no farming, reward once),
 * the restore state on GET /events/{slug}, the admin geofence, and the opaque
 * attendee handle that the DM endpoint accepts.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishToUser: vi.fn(async () => undefined),
  publishToCityExcept: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  EventStepInvalidError,
  ForbiddenError,
  NotFoundError,
  TriviaCooldownError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import {
  _resetEventsSyncForTests,
  getEvent,
  listUpcoming,
  submitProgress,
  triviaCooldownS,
  updateEvent,
} from './events.js';
import { checkIn, listAttendees, messageAttendee } from './events-irl.js';
import { publishToUser } from './realtime-bus.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();
const BP = 'breakpoint-2026';
const T0 = new Date('2026-11-16T12:00:00Z');
const at = (s: number): Date => new Date(T0.getTime() + s * 1000);
const answers = (): Record<string, string> =>
  (
    JSON.parse(readFileSync('contract/config/event_trivia.json', 'utf8')) as {
      answers: Record<string, string>;
    }
  ).answers;
const right = (q: string): string => answers()[q]!;
// Any choice id that is not the right one, in order.
const wrongChoices = (q: string): string[] => ['a', 'b', 'c', 'd'].filter((c) => c !== right(q));
const INSIDE = { lat: 51.49639, lng: -0.20972, accuracyM: 20, isMock: false };

let n = 0;
async function newUser(opts: { cash?: number } = {}): Promise<string> {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO users (id, wallet, created_at) VALUES ($1, $2, '2026-10-01T00:00:00Z')`,
    [id, `fu-${id}`],
  );
  await pool.query(`INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)`, [
    id,
    opts.cash ?? 0,
  ]);
  await pool.query(
    `INSERT INTO characters (id, user_id, alias, look, tribe_id, trait_ids, dream_id, home_id)
     VALUES ($1, $2, $3, '{"skin":1}', 'degens', '{}', 'x', 'h')`,
    [uuidv7(), id, `fu${Date.now().toString(36)}${n++}`],
  );
  return id;
}
const cashOf = async (id: string): Promise<number> =>
  Number(
    (await pool.query(`SELECT cash_cents FROM balances WHERE user_id = $1`, [id])).rows[0]
      .cash_cents,
  );
// Shown on the board by SQL, not setVisibility: its announcement shares a per-event
// Redis rate limit with events-irl.test.ts, which runs in parallel.
async function show(u: string): Promise<void> {
  await pool.query(
    `UPDATE event_checkins SET visible = true
      WHERE user_id = $1 AND event_id = (SELECT id FROM events WHERE slug = $2)`,
    [u, BP],
  );
}
const BOOTHS = ['bp26.booth_1', 'bp26.booth_2', 'bp26.booth_3'];
async function doBooths(u: string, now = T0): Promise<void> {
  for (const id of BOOTHS) await submitProgress(ctx, u, BP, 'booths', { id }, now);
}
const trivia = (u: string, id: string, answer: string, now: Date) =>
  submitProgress(ctx, u, BP, 'trivia', { id, answer }, now);

beforeAll(async () => {
  _resetEventsSyncForTests();
  await listUpcoming(ctx, 1, new Date('2026-10-23T00:00:00Z'));
});
afterAll(async () => {
  await pool.end();
});

describe('trivia retry', () => {
  it('two wrong answers no longer block the step: the player can still reach 3 right', async () => {
    const u = await newUser();
    await doBooths(u);
    await expect(
      trivia(u, 'bp26.q_city', wrongChoices('bp26.q_city')[0]!, T0),
    ).rejects.toBeInstanceOf(EventStepInvalidError);
    await expect(
      trivia(u, 'bp26.q_venue', wrongChoices('bp26.q_venue')[0]!, T0),
    ).rejects.toBeInstanceOf(EventStepInvalidError);
    // Right answers on the other two, and on q_days: that is 2 right so far.
    await trivia(u, 'bp26.q_month', right('bp26.q_month'), T0);
    await trivia(u, 'bp26.q_days', right('bp26.q_days'), T0);
    let d = await getEvent(ctx, u, BP, T0);
    expect(d.quest.steps[1]!.done).toBe(2);
    // After the cooldown the missed question can be answered.
    const r = await trivia(u, 'bp26.q_city', right('bp26.q_city'), at(61));
    expect(r.steps[1]!.complete).toBe(true);
    d = await getEvent(ctx, u, BP, at(61));
    expect(d.quest.steps[1]!.questions!.find((q) => q.id === 'bp26.q_city')!.answered).toBe(true);
  });

  it('cools down per question: 60 s, then 10 min, then 60 min; a wrong choice is not retried', async () => {
    expect([1, 2, 3, 4, 9].map(triviaCooldownS)).toEqual([60, 600, 3600, 3600, 3600]);
    const u = await newUser();
    await doBooths(u);
    const q = 'bp26.q_city';
    const [w1, w2, w3] = wrongChoices(q) as [string, string, string];
    await expect(trivia(u, q, w1, T0)).rejects.toMatchObject({
      details: { reason: 'wrong_answer', retryAfterSeconds: 60 },
    });
    // The same wrong choice again is refused outright (after the wait too).
    await expect(trivia(u, q, w1, at(61))).rejects.toMatchObject({
      details: { reason: 'already_tried' },
    });
    // Too early for the next try.
    const early = await trivia(u, q, w2, at(59)).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(TriviaCooldownError);
    expect((early as TriviaCooldownError).details).toMatchObject({ retryAfterSeconds: 1 });
    await expect(trivia(u, q, w2, at(60))).rejects.toMatchObject({
      details: { reason: 'wrong_answer', retryAfterSeconds: 600 },
    });
    await expect(trivia(u, q, w3, at(60 + 599))).rejects.toBeInstanceOf(TriviaCooldownError);
    await expect(trivia(u, q, w3, at(60 + 600))).rejects.toMatchObject({
      details: { reason: 'wrong_answer', retryAfterSeconds: 3600, triedChoices: [w1, w2, w3] },
    });
    // Another question is not affected by this one's cooldown.
    await expect(trivia(u, 'bp26.q_venue', right('bp26.q_venue'), at(661))).resolves.toBeDefined();
    // Brute-forcing one question through every choice needs more than 70 minutes.
    await expect(trivia(u, q, right(q), at(660 + 3599))).rejects.toBeInstanceOf(
      TriviaCooldownError,
    );
    await expect(trivia(u, q, right(q), at(660 + 3600))).resolves.toBeDefined();
  });

  it('retries pay the reward once, and a finished step ignores further proofs', async () => {
    const u = await newUser({ cash: 0 });
    await doBooths(u);
    await expect(
      trivia(u, 'bp26.q_city', wrongChoices('bp26.q_city')[0]!, T0),
    ).rejects.toBeDefined();
    await trivia(u, 'bp26.q_venue', right('bp26.q_venue'), T0);
    await trivia(u, 'bp26.q_month', right('bp26.q_month'), T0);
    await trivia(u, 'bp26.q_days', right('bp26.q_days'), T0);
    for (const id of ['bp26.nod_1', 'bp26.nod_2', 'bp26.nod_3', 'bp26.nod_4']) {
      await submitProgress(ctx, u, BP, 'nods', { id }, T0);
    }
    const done = await submitProgress(ctx, u, BP, 'nods', { id: 'bp26.nod_5' }, T0);
    expect(done.justCompleted).toBe(true);
    const cash = await cashOf(u);
    expect(cash).toBe(20000);
    // The earlier wrong question can not be answered again for another reward.
    const again = await trivia(u, 'bp26.q_city', right('bp26.q_city'), at(7200));
    expect(again.accepted).toBe(false);
    expect(again.justCompleted).toBe(false);
    expect(await cashOf(u)).toBe(cash);
    const rows = await pool.query(
      `SELECT 1 FROM ledger_entries WHERE user_id = $1 AND reason = 'event_reward'`,
      [u],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('a right answer is final and an old wrong row from before the migration counts as one try', async () => {
    const u = await newUser();
    await doBooths(u);
    await trivia(u, 'bp26.q_city', right('bp26.q_city'), T0);
    await expect(trivia(u, 'bp26.q_city', right('bp26.q_city'), at(5))).rejects.toMatchObject({
      details: { reason: 'already_answered' },
    });
    // The migration leaves choice '?' for a wrong answer it could not attribute.
    const v = await newUser();
    await doBooths(v);
    await pool.query(
      `INSERT INTO event_trivia_attempts (user_id, event_id, question_id, choice_id, created_at)
       SELECT $1, id, 'bp26.q_venue', '?', $2 FROM events WHERE slug = $3`,
      [v, T0, BP],
    );
    await expect(trivia(v, 'bp26.q_venue', right('bp26.q_venue'), at(10))).rejects.toBeInstanceOf(
      TriviaCooldownError,
    );
    await expect(trivia(v, 'bp26.q_venue', right('bp26.q_venue'), at(60))).resolves.toBeDefined();
    const d = await getEvent(ctx, v, BP, at(60));
    expect(d.quest.steps[1]!.questions!.find((q) => q.id === 'bp26.q_venue')!.triedChoices).toEqual(
      [],
    );
  });
});

describe('GET /events/{slug} restore state', () => {
  it('returns done booths and nods and the IRL check-in state', async () => {
    const u = await newUser();
    let d = await getEvent(ctx, u, BP, T0);
    expect(d.irl).toEqual({ available: true, checkedIn: false, checkedInAt: null, visible: false });
    expect(d.quest.steps[0]!.doneIds).toEqual([]);
    await submitProgress(ctx, u, BP, 'booths', { id: 'bp26.booth_2' }, T0);
    await submitProgress(ctx, u, BP, 'booths', { id: 'bp26.booth_5' }, T0);
    await checkIn(ctx, u, BP, INSIDE, T0);
    await show(u);
    d = await getEvent(ctx, u, BP, at(30));
    expect(new Set(d.quest.steps[0]!.doneIds)).toEqual(new Set(['bp26.booth_2', 'bp26.booth_5']));
    expect(d.quest.steps[0]!.done).toBe(2);
    expect(d.quest.steps[2]!.doneIds).toEqual([]);
    expect(d.irl).toEqual({
      available: true,
      checkedIn: true,
      checkedInAt: T0.toISOString(),
      visible: true,
    });
    // Another player's progress is never mixed in.
    const other = await getEvent(ctx, await newUser(), BP, at(30));
    expect(other.quest.steps[0]!.doneIds).toEqual([]);
    expect(other.irl.checkedIn).toBe(false);
  });
});

describe('admin geofence', () => {
  const SLUG = 'fu-geo-event';
  const ID = 'evt_cal_fu_geo';
  async function seed(): Promise<void> {
    await pool.query(`DELETE FROM events WHERE id = $1`, [ID]);
    await pool.query(
      `INSERT INTO events (id, slug, title, kind, starts_at, ends_at, city, real_venue,
          ingame_venue_id, skin_id, stream_url, source_url, quest_set)
       VALUES ($1, $2, 'Geo', 'meetup', '2031-05-01T10:00Z', '2031-05-01T18:00Z', 'X', 'Y',
          'conference_hall', 's', NULL, 'https://example.com/g', 'breakpoint_2026')`,
      [ID, SLUG],
    );
  }
  const geoOf = async () =>
    (
      await pool.query(
        `SELECT geo_lat, geo_lng, geo_radius_m, geo_source FROM events WHERE id = $1`,
        [ID],
      )
    ).rows[0];

  it('sets, keeps and clears the geofence, and validates the bounds', async () => {
    await seed();
    expect((await updateEvent(ctx, SLUG, { title: 'Geo 2' })).irlCheckin).toBe(false);
    const g = { lat: 51.5, lng: -0.2, radiusM: 300, source: 'https://example.com/venue' };
    expect((await updateEvent(ctx, SLUG, { geofence: g })).irlCheckin).toBe(true);
    expect(await geoOf()).toEqual({
      geo_lat: 51.5,
      geo_lng: -0.2,
      geo_radius_m: 300,
      geo_source: 'https://example.com/venue',
    });
    // A patch without a geofence leaves it alone.
    await updateEvent(ctx, SLUG, { city: 'Z' });
    expect((await geoOf()).geo_radius_m).toBe(300);
    const bad = [
      { ...g, lat: 91 },
      { ...g, lat: -90.5 },
      { ...g, lng: 180.1 },
      { ...g, lng: Number.NaN },
      { ...g, radiusM: 19 },
      { ...g, radiusM: 5001 },
      { ...g, radiusM: 100.5 },
      { ...g, source: '  ' },
    ];
    for (const geofence of bad) {
      await expect(updateEvent(ctx, SLUG, { geofence })).rejects.toBeInstanceOf(
        ValidationFailedError,
      );
    }
    expect((await geoOf()).geo_radius_m).toBe(300);
    expect((await updateEvent(ctx, SLUG, { geofence: null })).irlCheckin).toBe(false);
    expect(await geoOf()).toEqual({
      geo_lat: null,
      geo_lng: null,
      geo_radius_m: null,
      geo_source: null,
    });
    await pool.query(`DELETE FROM events WHERE id = $1`, [ID]);
  });
});

describe('opaque attendee handle and DM', () => {
  async function attendee(visible: boolean): Promise<string> {
    const u = await newUser();
    await checkIn(ctx, u, BP, INSIDE, T0);
    if (visible) await show(u);
    return u;
  }
  const aliasOf = async (id: string): Promise<string> =>
    (await pool.query(`SELECT alias FROM characters WHERE user_id = $1`, [id])).rows[0].alias;

  it('lists a handle that carries no user id, is stable and differs per attendee', async () => {
    const a = await attendee(true);
    const viewer = await attendee(true);
    const board = await listAttendees(ctx, viewer, BP, 50, null);
    const aliasA = await aliasOf(a);
    const mine = board.items.find((i) => i.alias === aliasA)!;
    expect(mine.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(mine.handle).not.toContain(a);
    expect(mine.handle).not.toContain(a.replace(/-/g, ''));
    expect(mine.self).toBe(false);
    const again = await listAttendees(ctx, viewer, BP, 50, null);
    expect(again.items.find((i) => i.alias === aliasA)!.handle).toBe(mine.handle);
    expect(new Set(board.items.map((i) => i.handle)).size).toBe(board.items.length);
    expect(board.items.filter((i) => i.self)).toHaveLength(1);
    expect(JSON.stringify(board)).not.toContain(a);
  });

  it('sends a DM by handle without returning the recipient id; the recipient is notified', async () => {
    const a = await attendee(true);
    const viewer = await attendee(false);
    const aliasA = await aliasOf(a);
    const handle = (await listAttendees(ctx, viewer, BP, 50, null)).items.find(
      (i) => i.alias === aliasA,
    )!.handle;
    vi.mocked(publishToUser).mockClear();
    const res = await messageAttendee(ctx, viewer, BP, handle, 'hey from the keynote');
    expect(res.sent).toBe(true);
    expect(JSON.stringify(res)).not.toContain(a);
    const dm = await pool.query(
      `SELECT from_user_id, to_user_id, text FROM dm_messages WHERE message_id = $1`,
      [res.messageId],
    );
    expect(dm.rows[0]).toEqual({
      from_user_id: viewer,
      to_user_id: a,
      text: 'hey from the keynote',
    });
    expect(vi.mocked(publishToUser).mock.calls.some((c) => c[1] === a && c[2] === 'dm')).toBe(true);
  });

  it('answers 404 for an unknown, hidden, own or blocked handle, and 403 if the caller has not checked in', async () => {
    const viewer = await attendee(true);
    const hidden = await attendee(false);
    const blocked = await attendee(true);
    const blocker = await attendee(true);
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      viewer,
      blocked,
    ]);
    await pool.query(`INSERT INTO blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2)`, [
      blocker,
      viewer,
    ]);
    const board = await listAttendees(ctx, hidden, BP, 50, null);
    const handleOf = (alias: string): string => board.items.find((i) => i.alias === alias)!.handle;
    // Handles for the visible ones, computed from the hidden user's board (they are not blocked by anyone).
    const hB = handleOf(await aliasOf(blocked));
    const hR = handleOf(await aliasOf(blocker));
    const hV = handleOf(await aliasOf(viewer));
    for (const h of [hB, hR, hV, 'A'.repeat(22)]) {
      await expect(messageAttendee(ctx, viewer, BP, h, 'hi')).rejects.toBeInstanceOf(NotFoundError);
    }
    // A hidden attendee has no handle on any board, and the same handle derivation does not reach them.
    const noCheckin = await newUser();
    await expect(messageAttendee(ctx, noCheckin, BP, hB, 'hi')).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    const hidDm = await pool.query(`SELECT 1 FROM dm_messages WHERE from_user_id = $1`, [viewer]);
    expect(hidDm.rowCount).toBe(0);
  });
});
