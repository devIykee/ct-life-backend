/**
 * Event calendar: real-world events (Breakpoint, hackathons, meetups) and
 * their quest chain.
 *
 *   GET /v1/events/current          — events live now
 *   GET /v1/events/upcoming?limit=  — next events, soonest first
 *   GET /v1/events/{slug}           — details and the caller's quest progress
 *   PUT /v1/admin/events/{slug}     — ops corrects dates / stream link (admin)
 *   POST /v1/events/{slug}/progress — advance the chain with a proof
 *
 * Source of truth: `contract/ids/calendar_events.json` is upserted into
 * `events` once per process; a row that ops edited (`admin_edited_at`) is not
 * overwritten again. An event is live while `starts_at <= now < ends_at`.
 * Every function that depends on time takes `now`, so tests drive the clock.
 *
 * The chain is ordered: a step only accepts proofs once the step before it
 * is complete. Proof kinds and what the server can verify:
 *
 *   interaction (booth, nod)  `proof.id` must be one of the ids the quest
 *       set lists for that step. Each id counts once per player. The server
 *       CANNOT prove the player stood at the booth: the id is a static
 *       public id, so this stops guessing, repeats, and out-of-window or
 *       out-of-order claims, not a client that replays real ids.
 *   trivia                    `proof.id` is a question id and `proof.answer`
 *       a choice id; it is checked against the server-only answer key
 *       (`contract/config/event_trivia.json`). A question is answered once,
 *       right or wrong, so the four choices cannot be brute-forced.
 *
 * Trivia can be retried. A wrong answer is recorded in `event_trivia_attempts`
 * (the wrong choice can not be tried again on that question) and puts THAT
 * question on a cooldown of 60 s, then 10 min, then 60 min for the 1st, 2nd and
 * 3rd wrong try. So a player who misses two questions can still reach the
 * required number, and guessing one question through all four choices takes
 * more than 70 minutes of waiting. The reward is still paid once per player
 * (`event_completions`), so retrying can not farm it.
 *
 * Completing every step pays `reward_cents` (ledger reason `event_reward`)
 * and grants the off-chain cosmetic `reward_item_key` (inventory source
 * 'grant'), once, in one transaction.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Db } from '../shared/db/pool.js';
import { runInTransaction } from '../shared/db/uow.js';
import {
  EventNotLiveError,
  EventStepInvalidError,
  TriviaCooldownError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { AppContext } from './context.js';
import { ensureCatalog, grantCosmetic } from './cosmetics.js';

export type EventKind = 'conference' | 'hackathon' | 'meetup';
export type EventStatus = 'upcoming' | 'live' | 'ended';

export interface EventSummary {
  readonly slug: string;
  readonly title: string;
  readonly kind: EventKind;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly city: string;
  readonly realVenue: string;
  readonly ingameVenueId: string;
  readonly skinId: string;
  readonly streamUrl: string | null;
  readonly sourceUrl: string;
  /** True when the opt-in IRL check-in is available (the event has a geofence). */
  readonly irlCheckin: boolean;
  readonly status: EventStatus;
}

export interface StepProgress {
  readonly step: string;
  readonly title: string;
  readonly kind: 'interaction' | 'trivia';
  readonly required: number;
  readonly done: number;
  readonly complete: boolean;
  /** Trivia only: the questions to show (never the answers). */
  readonly questions?: ReadonlyArray<{
    id: string;
    prompt: string;
    choices: ReadonlyArray<{ id: string; label: string }>;
    /** True once the question was answered right. */
    answered: boolean;
    /** The wrong choice ids already tried (they can not be tried again). */
    triedChoices: ReadonlyArray<string>;
    /** When the next try is allowed (ISO), or null when it is allowed now. */
    retryAt: string | null;
  }>;
  /** Interaction steps only: the booth / nod ids the caller has already done. */
  readonly doneIds?: ReadonlyArray<string>;
}

export interface QuestProgress {
  readonly steps: StepProgress[];
  readonly completed: boolean;
  readonly reward: { cashCents: number; itemKey: string | null; claimedAt: string | null };
}

export interface IrlState {
  /** The event has a geofence, so the opt-in check-in exists. */
  readonly available: boolean;
  readonly checkedIn: boolean;
  readonly checkedInAt: string | null;
  /** Whether the caller is listed on the attendee board. */
  readonly visible: boolean;
}

export interface EventDetails extends EventSummary {
  readonly quest: QuestProgress;
  /** The caller's IRL check-in state, so the client can restore after a relaunch. */
  readonly irl: IrlState;
}

/** Wait before the next try on a question after its n-th wrong choice (n >= 1). */
export const TRIVIA_COOLDOWNS_S: readonly number[] = [60, 600, 3600];

/**
 * @param wrongTries - How many wrong choices the question has had (>= 1).
 * @returns Seconds the player waits before the next try on that question.
 */
export function triviaCooldownS(wrongTries: number): number {
  return TRIVIA_COOLDOWNS_S[Math.min(Math.max(wrongTries, 1), TRIVIA_COOLDOWNS_S.length) - 1]!;
}

export interface ProgressResult extends QuestProgress {
  readonly slug: string;
  /** False when this proof was already counted (a replay). */
  readonly accepted: boolean;
  /** True when this very call completed the chain and paid the reward. */
  readonly justCompleted: boolean;
}

// File schemas ---------------------------------------------------------------

const StepFile = z.object({
  step: z.string(),
  title: z.string(),
  kind: z.enum(['interaction', 'trivia']),
  required: z.number().int().positive(),
  items: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
  questions: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        choices: z.array(z.object({ id: z.string(), label: z.string() })),
      }),
    )
    .optional(),
});
type StepDef = z.infer<typeof StepFile>;

const CalendarFile = z.object({
  events: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      kind: z.enum(['conference', 'hackathon', 'meetup']),
      startsAt: z.string(),
      endsAt: z.string(),
      city: z.string(),
      realVenue: z.string(),
      ingameVenueId: z.string(),
      skinId: z.string(),
      streamUrl: z.string().nullable(),
      sourceUrl: z.string(),
      questSet: z.string(),
      rewardCents: z.number().int().nonnegative(),
      rewardItemKey: z.string().nullable(),
      irlRewardItemKeys: z.array(z.string()).optional(),
      geofence: z
        .object({
          lat: z.number(),
          lng: z.number(),
          radiusM: z.number().int().positive(),
          source: z.string(),
        })
        .optional(),
    }),
  ),
  questSets: z.record(z.string(), z.object({ steps: z.array(StepFile) })),
});
const TriviaFile = z.object({ answers: z.record(z.string(), z.string()) });

type Calendar = z.infer<typeof CalendarFile>;

function readJson(...parts: string[]): unknown {
  return JSON.parse(readFileSync(join(process.cwd(), 'contract', ...parts), 'utf8'));
}

let calendarCache: Calendar | null = null;
let answersCache: Record<string, string> | null = null;

/**
 * The parsed event calendar file.
 * @returns The events and quest sets.
 */
export function loadCalendar(): Calendar {
  calendarCache ??= CalendarFile.parse(readJson('ids', 'calendar_events.json'));
  return calendarCache;
}

function loadAnswers(): Record<string, string> {
  answersCache ??= TriviaFile.parse(readJson('config', 'event_trivia.json')).answers;
  return answersCache;
}

/**
 * The step list of a quest set (empty for an unknown set).
 * @param questSet - The quest set id.
 */
export function stepsOf(questSet: string): StepDef[] {
  return loadCalendar().questSets[questSet]?.steps ?? [];
}

// Sync -----------------------------------------------------------------------

let synced: Promise<number> | null = null;
let catalogReady: Promise<void> | null = null;

/**
 * Upsert the calendar file into `events`, once per process. Rows that ops
 * edited are left alone; events dropped from the file stay in the table.
 * @param db - The database handle.
 */
export async function ensureEventsSynced(db: Db): Promise<void> {
  synced ??= syncEvents(db).catch((e: unknown) => {
    synced = null;
    throw e;
  });
  await synced;
}

/** Re-read the file on the next call (tests). */
export function _resetEventsSyncForTests(): void {
  synced = null;
  catalogReady = null;
  calendarCache = null;
  answersCache = null;
}

/**
 * Upsert the calendar file into `events`.
 * @param db - The database handle.
 * @returns How many events the file lists.
 */
export async function syncEvents(db: Db): Promise<number> {
  const file = loadCalendar();
  await db.withConnection(async (c) => {
    for (const e of file.events) {
      await c.query(
        `INSERT INTO events (id, slug, title, kind, starts_at, ends_at, city, real_venue,
                             ingame_venue_id, skin_id, stream_url, source_url, quest_set,
                             reward_cents, reward_item_key,
                             geo_lat, geo_lng, geo_radius_m, geo_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (id) DO UPDATE
           SET slug = EXCLUDED.slug, title = EXCLUDED.title, kind = EXCLUDED.kind,
               starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, city = EXCLUDED.city,
               real_venue = EXCLUDED.real_venue, ingame_venue_id = EXCLUDED.ingame_venue_id,
               skin_id = EXCLUDED.skin_id, stream_url = EXCLUDED.stream_url,
               source_url = EXCLUDED.source_url, quest_set = EXCLUDED.quest_set,
               reward_cents = EXCLUDED.reward_cents, reward_item_key = EXCLUDED.reward_item_key,
               geo_lat = EXCLUDED.geo_lat, geo_lng = EXCLUDED.geo_lng,
               geo_radius_m = EXCLUDED.geo_radius_m, geo_source = EXCLUDED.geo_source
           WHERE events.admin_edited_at IS NULL`,
        [
          e.id,
          e.slug,
          e.title,
          e.kind,
          e.startsAt,
          e.endsAt,
          e.city,
          e.realVenue,
          e.ingameVenueId,
          e.skinId,
          e.streamUrl,
          e.sourceUrl,
          e.questSet,
          e.rewardCents,
          e.rewardItemKey,
          e.geofence?.lat ?? null,
          e.geofence?.lng ?? null,
          e.geofence?.radiusM ?? null,
          e.geofence?.source ?? null,
        ],
      );
    }
  });
  return file.events.length;
}

// Reads ----------------------------------------------------------------------

export interface EventRow {
  id: string;
  slug: string;
  title: string;
  kind: EventKind;
  starts_at: Date;
  ends_at: Date;
  city: string;
  real_venue: string;
  ingame_venue_id: string;
  skin_id: string;
  stream_url: string | null;
  source_url: string;
  quest_set: string;
  reward_cents: string;
  reward_item_key: string | null;
  geo_lat: number | null;
  geo_lng: number | null;
  geo_radius_m: number | null;
}

const COLS = `id, slug, title, kind, starts_at, ends_at, city, real_venue, ingame_venue_id,
              skin_id, stream_url, source_url, quest_set, reward_cents, reward_item_key, geo_lat, geo_lng, geo_radius_m`;

/**
 * Whether an event row is upcoming, live or ended at `now`.
 * @param r - The event row.
 * @param now - The clock.
 */
export function statusOf(r: EventRow, now: Date): EventStatus {
  if (now.getTime() < r.starts_at.getTime()) return 'upcoming';
  if (now.getTime() >= r.ends_at.getTime()) return 'ended';
  return 'live';
}

function toSummary(r: EventRow, now: Date): EventSummary {
  return {
    slug: r.slug,
    title: r.title,
    kind: r.kind,
    startsAt: r.starts_at.toISOString(),
    endsAt: r.ends_at.toISOString(),
    city: r.city,
    realVenue: r.real_venue,
    ingameVenueId: r.ingame_venue_id,
    skinId: r.skin_id,
    streamUrl: r.stream_url,
    sourceUrl: r.source_url,
    irlCheckin: r.geo_lat !== null && r.geo_lng !== null && r.geo_radius_m !== null,
    status: statusOf(r, now),
  };
}

/**
 * Events that are live at `now`.
 * @param ctx - The app context.
 * @param now - The clock.
 * @returns The events (with `endsAt`) and the server time in epoch ms.
 */
export async function listCurrent(
  ctx: AppContext,
  now: Date = new Date(),
): Promise<{ items: EventSummary[]; serverNow: number }> {
  await ensureEventsSynced(ctx.db);
  const rows = await ctx.db.withConnection(async (c) =>
    c.query<EventRow>(
      `SELECT ${COLS} FROM events WHERE starts_at <= $1 AND ends_at > $1 ORDER BY ends_at ASC`,
      [now],
    ),
  );
  return { items: rows.rows.map((r) => toSummary(r, now)), serverNow: now.getTime() };
}

/**
 * The next events, soonest first.
 * @param ctx - The app context.
 * @param limit - 1 to 50.
 * @param now - The clock.
 * @returns The events (with `startsAt`) and the server time in epoch ms.
 */
export async function listUpcoming(
  ctx: AppContext,
  limit: number,
  now: Date = new Date(),
): Promise<{ items: EventSummary[]; serverNow: number }> {
  await ensureEventsSynced(ctx.db);
  const rows = await ctx.db.withConnection(async (c) =>
    c.query<EventRow>(
      `SELECT ${COLS} FROM events WHERE starts_at > $1 ORDER BY starts_at ASC LIMIT $2`,
      [now, limit],
    ),
  );
  return { items: rows.rows.map((r) => toSummary(r, now)), serverNow: now.getTime() };
}

/**
 * Load one event row by slug.
 * @param client - A query client.
 * @param slug - The event slug.
 * @throws NotFoundError for an unknown slug.
 */
export async function loadEvent(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> },
  slug: string,
): Promise<EventRow> {
  const r = await client.query(`SELECT ${COLS} FROM events WHERE slug = $1`, [slug]);
  const row = r.rows[0] as EventRow | undefined;
  if (!row) throw new NotFoundError({ resource: 'event', slug });
  return row;
}

type Q = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };

async function questProgress(
  client: Q,
  row: EventRow,
  userId: string,
  now: Date,
): Promise<QuestProgress> {
  const attempts = (
    await client.query(
      `SELECT question_id, choice_id, created_at FROM event_trivia_attempts
        WHERE user_id = $1 AND event_id = $2`,
      [userId, row.id],
    )
  ).rows as Array<{ question_id: string; choice_id: string; created_at: Date }>;
  const prog = (
    await client.query(
      `SELECT step, item_id, ok FROM event_progress WHERE user_id = $1 AND event_id = $2`,
      [userId, row.id],
    )
  ).rows as Array<{ step: string; item_id: string; ok: boolean }>;
  const done = (
    await client.query(
      `SELECT cash_cents, item_key, completed_at FROM event_completions
        WHERE user_id = $1 AND event_id = $2`,
      [userId, row.id],
    )
  ).rows[0] as { cash_cents: string; item_key: string | null; completed_at: Date } | undefined;
  const steps: StepProgress[] = stepsOf(row.quest_set).map((s) => {
    const mine = prog.filter((p) => p.step === s.step);
    const count = mine.filter((p) => p.ok).length;
    return {
      step: s.step,
      title: s.title,
      kind: s.kind,
      required: s.required,
      done: Math.min(count, s.required),
      complete: count >= s.required,
      ...(s.kind === 'trivia'
        ? {
            questions: (s.questions ?? []).map((q) => {
              const wrong = attempts.filter((a) => a.question_id === q.id);
              const last = wrong.reduce((m, a) => Math.max(m, a.created_at.getTime()), 0);
              const until = wrong.length > 0 ? last + triviaCooldownS(wrong.length) * 1000 : 0;
              const answered = mine.some((p) => p.item_id === q.id && p.ok);
              return {
                id: q.id,
                prompt: q.prompt,
                choices: q.choices,
                answered,
                triedChoices: wrong.map((a) => a.choice_id).filter((c) => c !== '?'),
                retryAt: !answered && until > now.getTime() ? new Date(until).toISOString() : null,
              };
            }),
          }
        : {
            doneIds: mine.filter((p) => p.ok).map((p) => p.item_id),
          }),
    };
  });
  return {
    steps,
    completed: done !== undefined,
    reward: {
      cashCents: Number(row.reward_cents),
      itemKey: row.reward_item_key,
      claimedAt: done ? done.completed_at.toISOString() : null,
    },
  };
}

/**
 * One event with the caller's quest progress.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param slug - The event slug.
 * @param now - The clock.
 */
export async function getEvent(
  ctx: AppContext,
  userId: string,
  slug: string,
  now: Date = new Date(),
): Promise<EventDetails> {
  await ensureEventsSynced(ctx.db);
  return ctx.db.withConnection(async (c) => {
    const row = await loadEvent(c, slug);
    const ci = (
      await c.query<{ checked_in_at: Date; visible: boolean }>(
        `SELECT checked_in_at, visible FROM event_checkins WHERE event_id = $1 AND user_id = $2`,
        [row.id, userId],
      )
    ).rows[0];
    const summary = toSummary(row, now);
    return {
      ...summary,
      quest: await questProgress(c, row, userId, now),
      irl: {
        available: summary.irlCheckin,
        checkedIn: ci !== undefined,
        checkedInAt: ci ? ci.checked_in_at.toISOString() : null,
        visible: ci?.visible ?? false,
      },
    };
  });
}

// Admin ----------------------------------------------------------------------

export interface EventPatch {
  title?: string;
  startsAt?: string;
  endsAt?: string;
  city?: string;
  realVenue?: string;
  streamUrl?: string | null;
  sourceUrl?: string;
  /** The venue geofence for the IRL check-in; null removes it (check-in off). */
  geofence?: { lat: number; lng: number; radiusM: number; source: string } | null;
}

/** Bounds the admin API accepts for a venue geofence. */
export const GEOFENCE_MIN_RADIUS_M = 20;
export const GEOFENCE_MAX_RADIUS_M = 5000;

/**
 * Check a geofence from the admin API.
 * @param g - The geofence.
 * @throws ValidationFailedError when a value is out of range.
 */
export function assertGeofence(g: {
  lat: number;
  lng: number;
  radiusM: number;
  source: string;
}): void {
  const bad = (reason: string): never => {
    throw new ValidationFailedError({ reason });
  };
  if (!Number.isFinite(g.lat) || g.lat < -90 || g.lat > 90) bad('geofence.lat must be -90..90');
  if (!Number.isFinite(g.lng) || g.lng < -180 || g.lng > 180) bad('geofence.lng must be -180..180');
  if (
    !Number.isInteger(g.radiusM) ||
    g.radiusM < GEOFENCE_MIN_RADIUS_M ||
    g.radiusM > GEOFENCE_MAX_RADIUS_M
  ) {
    bad(`geofence.radiusM must be an integer ${GEOFENCE_MIN_RADIUS_M}..${GEOFENCE_MAX_RADIUS_M}`);
  }
  if (g.source.trim() === '' || g.source.length > 500) bad('geofence.source is required');
}

/**
 * Correct an event (dates, stream link, wording). Marks the row as edited so
 * the calendar file stops overwriting it.
 * @param ctx - The app context.
 * @param slug - The event slug.
 * @param patch - The fields to change.
 * @param now - The clock.
 */
export async function updateEvent(
  ctx: AppContext,
  slug: string,
  patch: EventPatch,
  now: Date = new Date(),
): Promise<EventSummary> {
  await ensureEventsSynced(ctx.db);
  const row = await runInTransaction(async (client) => {
    const cur = (
      await client.query<EventRow>(`SELECT ${COLS} FROM events WHERE slug = $1 FOR UPDATE`, [slug])
    ).rows[0];
    if (!cur) throw new NotFoundError({ resource: 'event', slug });
    const startsAt = patch.startsAt ? new Date(patch.startsAt) : cur.starts_at;
    const endsAt = patch.endsAt ? new Date(patch.endsAt) : cur.ends_at;
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new ValidationFailedError({ reason: 'endsAt must be after startsAt' });
    }
    if (patch.geofence) assertGeofence(patch.geofence);
    const setGeo = patch.geofence !== undefined;
    const g = patch.geofence ?? null;
    const r = await client.query<EventRow>(
      `UPDATE events SET title = $2, starts_at = $3, ends_at = $4, city = $5, real_venue = $6,
              stream_url = $7, source_url = $8, admin_edited_at = now(),
              geo_lat = CASE WHEN $9::boolean THEN $10::double precision ELSE geo_lat END,
              geo_lng = CASE WHEN $9::boolean THEN $11::double precision ELSE geo_lng END,
              geo_radius_m = CASE WHEN $9::boolean THEN $12::integer ELSE geo_radius_m END,
              geo_source = CASE WHEN $9::boolean THEN $13::text ELSE geo_source END
        WHERE slug = $1 RETURNING ${COLS}`,
      [
        slug,
        patch.title ?? cur.title,
        startsAt,
        endsAt,
        patch.city ?? cur.city,
        patch.realVenue ?? cur.real_venue,
        patch.streamUrl === undefined ? cur.stream_url : patch.streamUrl,
        patch.sourceUrl ?? cur.source_url,
        setGeo,
        g?.lat ?? null,
        g?.lng ?? null,
        g?.radiusM ?? null,
        g?.source ?? null,
      ],
    );
    return r.rows[0]!;
  });
  return toSummary(row, now);
}

// Progress -------------------------------------------------------------------

export interface Proof {
  readonly id: string;
  readonly answer?: string | undefined;
}

/**
 * Advance the event quest chain with a proof. Idempotent: a proof already
 * counted is a no-op (`accepted: false`); the reward is paid once.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param slug - The event slug.
 * @param step - The step being advanced.
 * @param proof - The interaction id, or the trivia question and answer.
 * @param now - The clock.
 * @throws EventNotLiveError outside the window; EventStepInvalidError for an
 *   unknown or locked step, an id the step does not list, or a wrong or
 *   repeated trivia answer.
 */
export async function submitProgress(
  ctx: AppContext,
  userId: string,
  slug: string,
  step: string,
  proof: Proof,
  now: Date = new Date(),
): Promise<ProgressResult> {
  await ensureEventsSynced(ctx.db);
  catalogReady ??= ensureCatalog(ctx).catch((e: unknown) => {
    catalogReady = null;
    throw e;
  });
  await catalogReady;
  let wrong: { id: string; retryAfterSeconds: number; triedChoices: string[] } | null = null;
  const result = await runInTransaction(async (client) => {
    const row = await loadEvent(client, slug);
    if (statusOf(row, now) !== 'live') {
      throw new EventNotLiveError({
        slug,
        status: statusOf(row, now),
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
      });
    }
    // One writer per (player, event): serialises counting and the reward.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `event:${row.id}:${userId}`,
    ]);

    const defs = stepsOf(row.quest_set);
    const idx = defs.findIndex((s) => s.step === step);
    const def = defs[idx];
    if (!def) throw new EventStepInvalidError({ reason: 'unknown_step', step });

    const before = await questProgress(client, row, userId, now);
    if (before.completed) {
      return { ...before, slug, accepted: false, justCompleted: false };
    }
    if (idx > 0 && !before.steps.slice(0, idx).every((s) => s.complete)) {
      throw new EventStepInvalidError({ reason: 'step_locked', step });
    }
    if (before.steps[idx]!.complete) {
      // The step is done; a further proof changes nothing.
      return { ...before, slug, accepted: false, justCompleted: false };
    }

    let ok = true;
    let wrongTries = 0;
    if (def.kind === 'interaction') {
      if (!(def.items ?? []).some((i) => i.id === proof.id)) {
        throw new EventStepInvalidError({ reason: 'unknown_id', step });
      }
    } else {
      const q = (def.questions ?? []).find((x) => x.id === proof.id);
      if (!q || proof.answer === undefined || !q.choices.some((c) => c.id === proof.answer)) {
        throw new EventStepInvalidError({ reason: 'unknown_question_or_choice', step });
      }
      const prior = (
        await client.query(
          `SELECT choice_id, created_at FROM event_trivia_attempts
            WHERE user_id = $1 AND event_id = $2 AND question_id = $3`,
          [userId, row.id, q.id],
        )
      ).rows as Array<{ choice_id: string; created_at: Date }>;
      if (before.steps[idx]!.questions?.find((x) => x.id === q.id)?.answered) {
        throw new EventStepInvalidError({ reason: 'already_answered', step, id: proof.id });
      }
      if (prior.some((a) => a.choice_id === proof.answer)) {
        throw new EventStepInvalidError({ reason: 'already_tried', step, id: proof.id });
      }
      wrongTries = prior.length;
      if (wrongTries > 0) {
        const last = prior.reduce((m, a) => Math.max(m, a.created_at.getTime()), 0);
        const until = last + triviaCooldownS(wrongTries) * 1000;
        if (now.getTime() < until) {
          throw new TriviaCooldownError({
            step,
            id: proof.id,
            retryAt: new Date(until).toISOString(),
            retryAfterSeconds: Math.ceil((until - now.getTime()) / 1000),
          });
        }
      }
      ok = loadAnswers()[q.id] === proof.answer;
      if (!ok) {
        await client.query(
          `INSERT INTO event_trivia_attempts (user_id, event_id, question_id, choice_id, created_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [userId, row.id, q.id, proof.answer, now],
        );
        // Commit the recorded wrong choice, then refuse (thrown below).
        wrong = {
          id: proof.id,
          retryAfterSeconds: triviaCooldownS(wrongTries + 1),
          triedChoices: [...prior.map((a) => a.choice_id).filter((c) => c !== '?'), proof.answer],
        };
        return { ...before, slug, accepted: false, justCompleted: false };
      }
    }

    const ins = await client.query(
      `INSERT INTO event_progress (user_id, event_id, step, item_id, ok, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, event_id, step, item_id) DO NOTHING
       RETURNING 1`,
      [userId, row.id, step, proof.id, ok, now],
    );
    const fresh = ins.rows.length > 0;
    if (!fresh && def.kind === 'trivia') {
      throw new EventStepInvalidError({ reason: 'already_answered', step, id: proof.id });
    }

    let after = await questProgress(client, row, userId, now);
    let justCompleted = false;
    if (after.steps.every((s) => s.complete)) {
      const claim = await client.query(
        `INSERT INTO event_completions (user_id, event_id, cash_cents, item_key, completed_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, event_id) DO NOTHING
         RETURNING 1`,
        [userId, row.id, row.reward_cents, row.reward_item_key, now],
      );
      if (claim.rows.length > 0) {
        justCompleted = true;
        const cash = Number(row.reward_cents);
        if (cash > 0) {
          await client.query(
            `INSERT INTO balances (user_id, cash_cents) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING`,
            [userId],
          );
          await client.query(
            `UPDATE balances SET cash_cents = cash_cents + $1, updated_at = now() WHERE user_id = $2`,
            [cash, userId],
          );
          await client.query(
            `INSERT INTO ledger_entries (user_id, delta_cents, account, reason, ref_type, ref_id, idempotency_ref)
             VALUES ($1, $2, 'cash', 'event_reward', 'event', $3, $4)`,
            [userId, cash, row.id, `event-reward:${userId}:${row.id}`],
          );
        }
        if (row.reward_item_key) {
          await grantCosmetic(client, userId, row.reward_item_key);
        }
        after = await questProgress(client, row, userId, now);
      }
    }
    return { ...after, slug, accepted: fresh, justCompleted };
  });
  const w = wrong as { id: string; retryAfterSeconds: number; triedChoices: string[] } | null;
  if (w) {
    throw new EventStepInvalidError({
      reason: 'wrong_answer',
      step,
      id: w.id,
      retryAfterSeconds: w.retryAfterSeconds,
      triedChoices: w.triedChoices,
    });
  }
  return result;
}
