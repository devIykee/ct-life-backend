/**
 * Event calendar service tests: current / upcoming by clock, details, the
 * quest chain (valid and invalid proofs, order, window edges), the reward
 * (once), the admin patch, and the start / end announcements. Every call
 * passes a controlled `now`; the realtime push is stubbed.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { config as loadDotenv } from 'dotenv';
import { readFileSync } from 'node:fs';

vi.mock('./realtime-bus.js', async (orig) => ({
  ...(await orig<typeof import('./realtime-bus.js')>()),
  publishToUser: vi.fn(async () => undefined),
}));

import { buildContext, _resetContextForTests } from './context.js';
import { _resetConfigForTests } from '../shared/config/config.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import {
  EventNotLiveError,
  EventStepInvalidError,
  NotFoundError,
  TriviaCooldownError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import {
  _resetEventsSyncForTests,
  getEvent,
  listCurrent,
  listUpcoming,
  loadCalendar,
  submitProgress,
  updateEvent,
} from './events.js';
import { listInventory, listShop, purchase } from './cosmetics.js';
import { publishToUser } from './realtime-bus.js';
import { announceEvents } from '../workers/event-announce.js';

loadDotenv({ path: process.cwd() + '/.env' });
_resetConfigForTests();
_resetContextForTests();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ctx = buildContext();

const BP = 'breakpoint-2026';
const BP_START = new Date('2026-11-15T00:00:00Z');
const BP_END = new Date('2026-11-18T00:00:00Z');
const DURING = new Date('2026-11-16T12:00:00Z');
// A fixed far-future event nobody else touches, for the announcer and admin.
const TEST_ID = 'evt_cal_test_2031';
const TEST_SLUG = 'test-event-2031';
const T_START = new Date('2031-05-01T10:00:00Z');
const T_END = new Date('2031-05-01T18:00:00Z');

async function newUser(cashCents = 0): Promise<string> {
  const id = uuidv7();
  await pool.query(`INSERT INTO users (id, wallet) VALUES ($1, $2)`, [id, `event-${id}`]);
  await pool.query(
    `INSERT INTO balances (user_id, cash_cents, debt_cents) VALUES ($1, $2, 0)
     ON CONFLICT (user_id) DO UPDATE SET cash_cents = $2, debt_cents = 0`,
    [id, cashCents],
  );
  return id;
}

async function cashOf(userId: string): Promise<number> {
  const r = await pool.query<{ cash_cents: string }>(
    `SELECT cash_cents FROM balances WHERE user_id = $1`,
    [userId],
  );
  return Number(r.rows[0]?.cash_cents ?? 0);
}

const answers = (): Record<string, string> =>
  (
    JSON.parse(readFileSync('contract/config/event_trivia.json', 'utf8')) as {
      answers: Record<string, string>;
    }
  ).answers;

/** Drive the whole Breakpoint chain for a user at `now`; returns the last result. */
async function completeChain(userId: string, now: Date = DURING) {
  for (const id of ['bp26.booth_1', 'bp26.booth_2', 'bp26.booth_3']) {
    await submitProgress(ctx, userId, BP, 'booths', { id }, now);
  }
  for (const id of ['bp26.q_city', 'bp26.q_venue', 'bp26.q_month']) {
    await submitProgress(ctx, userId, BP, 'trivia', { id, answer: answers()[id] }, now);
  }
  let last = await submitProgress(ctx, userId, BP, 'nods', { id: 'bp26.nod_1' }, now);
  for (const id of ['bp26.nod_2', 'bp26.nod_3', 'bp26.nod_4', 'bp26.nod_5']) {
    last = await submitProgress(ctx, userId, BP, 'nods', { id }, now);
  }
  return last;
}

async function seedTestEvent(): Promise<void> {
  await pool.query(`DELETE FROM events WHERE id = $1`, [TEST_ID]);
  await pool.query(
    `INSERT INTO events (id, slug, title, kind, starts_at, ends_at, city, real_venue,
        ingame_venue_id, skin_id, stream_url, source_url, quest_set)
     VALUES ($1, $2, 'Test Event', 'meetup', $3, $4, 'Testville', 'Test Hall',
        'conference_hall', 'test_skin', NULL, 'https://example.com/test', 'breakpoint_2026')`,
    [TEST_ID, TEST_SLUG, T_START, T_END],
  );
}

beforeAll(async () => {
  _resetEventsSyncForTests();
  await listUpcoming(ctx, 1, new Date('2026-10-23T00:00:00Z')); // syncs the file
});

beforeEach(async () => {
  vi.mocked(publishToUser).mockClear();
  await seedTestEvent();
});

afterAll(async () => {
  await pool.query(`DELETE FROM events WHERE id = $1`, [TEST_ID]);
  await pool.end();
});

describe('calendar file', () => {
  it('seeds Breakpoint 2026 with the cited real dates and a known in-game venue', async () => {
    const e = loadCalendar().events.find((x) => x.slug === BP)!;
    expect(e.startsAt).toBe('2026-11-15T00:00:00Z');
    expect(e.endsAt).toBe('2026-11-18T00:00:00Z');
    expect(e.city).toBe('London');
    expect(e.realVenue).toBe('Olympia London');
    expect(e.sourceUrl).toBe('https://luma.com/breakpoint2026');
    const venues = JSON.parse(readFileSync('contract/ids/venues.json', 'utf8')) as {
      venues: Array<{ id: string }>;
    };
    expect(venues.venues.some((v) => v.id === e.ingameVenueId)).toBe(true);
    // Every trivia question has a key that names one of its choices.
    const trivia = loadCalendar().questSets[e.questSet]!.steps.find((s) => s.kind === 'trivia')!;
    for (const q of trivia.questions!) {
      expect(q.choices.map((c) => c.id)).toContain(answers()[q.id]);
    }
  });
});

describe('current and upcoming', () => {
  it('follows the clock at the window edges', async () => {
    const slugs = async (now: Date): Promise<string[]> =>
      (await listCurrent(ctx, now)).items.map((i) => i.slug);
    expect(await slugs(new Date(BP_START.getTime() - 1))).not.toContain(BP);
    expect(await slugs(BP_START)).toContain(BP);
    expect(await slugs(new Date(BP_END.getTime() - 1))).toContain(BP);
    expect(await slugs(BP_END)).not.toContain(BP);

    const live = (await listCurrent(ctx, DURING)).items.find((i) => i.slug === BP)!;
    expect(live.endsAt).toBe(BP_END.toISOString());
    expect(live.status).toBe('live');
    expect((await listCurrent(ctx, DURING)).serverNow).toBe(DURING.getTime());
  });

  it('lists upcoming soonest first, honours limit, and drops started events', async () => {
    const before = new Date('2026-10-23T00:00:00Z');
    const up = await listUpcoming(ctx, 50, before);
    const slugs = up.items.map((i) => i.slug);
    expect(slugs.indexOf(BP)).toBeGreaterThanOrEqual(0);
    expect(slugs.indexOf(BP)).toBeLessThan(slugs.indexOf(TEST_SLUG));
    expect(up.items.find((i) => i.slug === BP)!.startsAt).toBe(BP_START.toISOString());
    expect((await listUpcoming(ctx, 1, before)).items).toHaveLength(1);
    expect((await listUpcoming(ctx, 50, DURING)).items.map((i) => i.slug)).not.toContain(BP);
  });
});

describe('details', () => {
  it('returns skin, stream link and the caller quest progress without answers', async () => {
    const u = await newUser();
    const d = await getEvent(ctx, u, BP, DURING);
    expect(d.skinId).toBe('london_2026');
    expect(d.streamUrl).toBeNull();
    expect(d.ingameVenueId).toBe('conference_hall');
    expect(d.quest.steps.map((s) => s.step)).toEqual(['booths', 'trivia', 'nods']);
    expect(d.quest.completed).toBe(false);
    expect(d.quest.reward).toMatchObject({ cashCents: 20000, itemKey: 'lanyard_breakpoint_2026' });
    expect(JSON.stringify(d)).not.toContain('"answer"');
    await expect(getEvent(ctx, u, 'nope', DURING)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('quest chain', () => {
  it('refuses progress before and after the window, to the millisecond', async () => {
    const u = await newUser();
    const p = { id: 'bp26.booth_1' };
    await expect(
      submitProgress(ctx, u, BP, 'booths', p, new Date(BP_START.getTime() - 1)),
    ).rejects.toBeInstanceOf(EventNotLiveError);
    await expect(submitProgress(ctx, u, BP, 'booths', p, BP_END)).rejects.toBeInstanceOf(
      EventNotLiveError,
    );
    const ok = await submitProgress(ctx, u, BP, 'booths', p, BP_START);
    expect(ok.accepted).toBe(true);
    expect(ok.steps[0]).toMatchObject({ done: 1, complete: false });
  });

  it('counts a booth once, rejects unknown ids, steps and locked steps', async () => {
    const u = await newUser();
    await submitProgress(ctx, u, BP, 'booths', { id: 'bp26.booth_1' }, DURING);
    const again = await submitProgress(ctx, u, BP, 'booths', { id: 'bp26.booth_1' }, DURING);
    expect(again.accepted).toBe(false);
    expect(again.steps[0]!.done).toBe(1);

    const bad = async (step: string, proof: { id: string; answer?: string }) =>
      submitProgress(ctx, u, BP, step, proof, DURING).catch((e: unknown) => e);
    expect(await bad('booths', { id: 'bp26.nod_1' })).toBeInstanceOf(EventStepInvalidError);
    expect(await bad('booths', { id: 'made.up' })).toBeInstanceOf(EventStepInvalidError);
    expect(await bad('lobby', { id: 'bp26.booth_2' })).toBeInstanceOf(EventStepInvalidError);
    const locked = (await bad('nods', { id: 'bp26.nod_1' })) as EventStepInvalidError;
    expect(locked).toBeInstanceOf(EventStepInvalidError);
    expect(locked.details).toMatchObject({ reason: 'step_locked' });
    expect(await bad('trivia', { id: 'bp26.q_city', answer: 'a' })).toBeInstanceOf(
      EventStepInvalidError,
    );
  });

  it('checks trivia against the server key; a wrong choice is recorded and cools the question down', async () => {
    const u = await newUser();
    for (const id of ['bp26.booth_1', 'bp26.booth_2', 'bp26.booth_3']) {
      await submitProgress(ctx, u, BP, 'booths', { id }, DURING);
    }
    const wrong = await submitProgress(
      ctx,
      u,
      BP,
      'trivia',
      { id: 'bp26.q_city', answer: 'd' },
      DURING,
    ).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(EventStepInvalidError);
    expect((wrong as EventStepInvalidError).details).toMatchObject({
      reason: 'wrong_answer',
      retryAfterSeconds: 60,
      triedChoices: ['d'],
    });
    // The same question is cooling down, even with the right answer.
    const soon = await submitProgress(
      ctx,
      u,
      BP,
      'trivia',
      { id: 'bp26.q_city', answer: answers()['bp26.q_city'] },
      new Date(DURING.getTime() + 30_000),
    ).catch((e: unknown) => e);
    expect(soon).toBeInstanceOf(TriviaCooldownError);
    expect((soon as TriviaCooldownError).details).toMatchObject({ retryAfterSeconds: 30 });
    // A choice that does not exist is invalid, not merely wrong.
    await expect(
      submitProgress(ctx, u, BP, 'trivia', { id: 'bp26.q_venue', answer: 'z' }, DURING),
    ).rejects.toBeInstanceOf(EventStepInvalidError);
    const d = await getEvent(ctx, u, BP, DURING);
    const t = d.quest.steps[1]!;
    expect(t.done).toBe(0);
    const q = t.questions!.find((x) => x.id === 'bp26.q_city')!;
    expect(q.answered).toBe(false);
    expect(q.triedChoices).toEqual(['d']);
    expect(q.retryAt).toBe(new Date(DURING.getTime() + 60_000).toISOString());
  });

  it('pays Cash and the lanyard once, and ignores replays and later proofs', async () => {
    const u = await newUser(1000);
    const last = await completeChain(u);
    expect(last.completed).toBe(true);
    expect(last.justCompleted).toBe(true);
    expect(await cashOf(u)).toBe(21000);

    const replay = await submitProgress(ctx, u, BP, 'nods', { id: 'bp26.nod_6' }, DURING);
    expect(replay.justCompleted).toBe(false);
    expect(replay.accepted).toBe(false);
    expect(await cashOf(u)).toBe(21000);

    const ledger = await pool.query(
      `SELECT delta_cents FROM ledger_entries WHERE user_id = $1 AND reason = 'event_reward'`,
      [u],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(Number(ledger.rows[0].delta_cents)).toBe(20000);

    const inv = (await listInventory(ctx, u)).filter(
      (i) => i.itemKey === 'lanyard_breakpoint_2026',
    );
    expect(inv).toHaveLength(1);
    expect(inv[0]!.source).toBe('grant');
    expect((await getEvent(ctx, u, BP, DURING)).quest.completed).toBe(true);
  });

  it('pays once under concurrent final proofs', async () => {
    const u = await newUser(0);
    for (const id of ['bp26.booth_1', 'bp26.booth_2', 'bp26.booth_3']) {
      await submitProgress(ctx, u, BP, 'booths', { id }, DURING);
    }
    for (const id of ['bp26.q_city', 'bp26.q_venue', 'bp26.q_month']) {
      await submitProgress(ctx, u, BP, 'trivia', { id, answer: answers()[id] }, DURING);
    }
    for (const id of ['bp26.nod_1', 'bp26.nod_2', 'bp26.nod_3', 'bp26.nod_4']) {
      await submitProgress(ctx, u, BP, 'nods', { id }, DURING);
    }
    await Promise.all(
      ['bp26.nod_5', 'bp26.nod_6', 'bp26.nod_7'].map((id) =>
        submitProgress(ctx, u, BP, 'nods', { id }, DURING),
      ),
    );
    expect(await cashOf(u)).toBe(20000);
  });

  it('keeps the lanyard out of the shop and refuses to sell it', async () => {
    const shop = await listShop(ctx, null);
    expect(shop.some((i) => i.itemKey === 'lanyard_breakpoint_2026')).toBe(false);
    const row = await pool.query(
      `SELECT item_id FROM cosmetic_items WHERE item_key = 'lanyard_breakpoint_2026'`,
    );
    const u = await newUser(100000);
    await expect(purchase(ctx, u, row.rows[0].item_id as string)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});

describe('admin update', () => {
  it('corrects dates and stream link, validates them, and survives a re-sync', async () => {
    const out = await updateEvent(
      ctx,
      TEST_SLUG,
      { streamUrl: 'https://stream.example.com/live', endsAt: '2031-05-01T20:00:00Z' },
      T_START,
    );
    expect(out.streamUrl).toBe('https://stream.example.com/live');
    expect(out.endsAt).toBe('2031-05-01T20:00:00.000Z');
    await expect(
      updateEvent(ctx, TEST_SLUG, { startsAt: '2031-05-02T00:00:00Z' }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(updateEvent(ctx, 'nope', { title: 'x' })).rejects.toBeInstanceOf(NotFoundError);
    const cleared = await updateEvent(ctx, TEST_SLUG, { streamUrl: null });
    expect(cleared.streamUrl).toBeNull();
  });
});

describe('announcements', () => {
  const calls = (type: string): Array<Record<string, unknown>> =>
    vi
      .mocked(publishToUser)
      .mock.calls.filter((c) => c[2] === type && (c[3] as { slug?: string }).slug === TEST_SLUG)
      .map((c) => c[3] as Record<string, unknown>);

  it('sends event_live at start and event_ended at end, each once', async () => {
    const before = new Date(T_START.getTime() - 60_000);
    await announceEvents(ctx, before);
    expect(calls('event_live')).toHaveLength(0);

    await announceEvents(ctx, T_START);
    await announceEvents(ctx, new Date(T_START.getTime() + 60_000));
    expect(calls('event_live')).toHaveLength(1);
    expect(calls('event_live')[0]).toMatchObject({
      slug: TEST_SLUG,
      skinId: 'test_skin',
      endsAt: T_END.getTime(),
    });
    expect(vi.mocked(publishToUser).mock.calls.find((c) => c[2] === 'event_live')![1]).toBe('*');
    expect(calls('event_ended')).toHaveLength(0);

    await announceEvents(ctx, T_END);
    await announceEvents(ctx, new Date(T_END.getTime() + 60_000));
    expect(calls('event_ended')).toHaveLength(1);
    expect(calls('event_ended')[0]).toMatchObject({ slug: TEST_SLUG, endedAt: T_END.getTime() });
  });

  it('does not announce a start the worker only noticed after the end', async () => {
    await announceEvents(ctx, new Date(T_END.getTime() + 3_600_000));
    expect(calls('event_live')).toHaveLength(0);
    expect(calls('event_ended')).toHaveLength(0);
  });
});
