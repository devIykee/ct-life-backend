/**
 * First-session onboarding: the beats a new player passes through, and the hooks that
 * set them from real server events.
 *
 *   GET  /v1/me                    flags.firstSession = {state, startedAt, completedAt, beats}
 *   POST /v1/me/first-session      {beat} | {skip: true} | {replay: true}
 *
 * Beats, in order: origin, character, home, moved, shift, trade, quest, chest. The server
 * sets origin (lottery roll), character (character create), shift (a clock-in), trade (a
 * market buy or a perp open) and chest (the daily chest claim); the client reports the
 * others. The first session is done when every APPLICABLE beat is in; `trade` is applicable
 * only while markets are live for the deployment (LIVE_PHASE >= 2).
 *
 * Who has one: an account created after the onboarding migration starts `active`. An older
 * account has no row and reads as `done` (nothing to show, no starter quests). `skip` sets
 * `skipped`; `replay` sets `active` again, clears the beats from `moved` on and restarts
 * the clock (`startedAt` = now). The starter quests live in quests.ts.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { lockOnboarding, type FirstSessionState, type OnboardingRow } from './onboarding-store.js';
import { ensureStarterQuests, recordQuestEvent, type QuestVerb } from './quests.js';
import type { AppContext } from './context.js';

export const BEATS = [
  'origin',
  'character',
  'home',
  'moved',
  'shift',
  'trade',
  'quest',
  'chest',
] as const;
export type Beat = (typeof BEATS)[number];

/** Beats that a replay keeps (everything before `moved`). */
const KEPT_ON_REPLAY: readonly Beat[] = ['origin', 'character', 'home'];

export interface FirstSession {
  readonly state: FirstSessionState;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly beats: Beat[];
}

/** An old account's first session: finished, with nothing to show. */
const OLD_ACCOUNT: FirstSession = { state: 'done', startedAt: null, completedAt: null, beats: [] };

/** The beats that count toward finishing, for this deployment. */
export function applicableBeats(ctx: AppContext): readonly Beat[] {
  return ctx.config.livePhase >= 2 ? BEATS : BEATS.filter((b) => b !== 'trade');
}

function toView(row: OnboardingRow): FirstSession {
  const have = new Set(row.beats);
  return {
    state: row.first_session,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    beats: BEATS.filter((b) => have.has(b)),
  };
}

const COLS = 'first_session, started_at, completed_at, beats, starter_seeded_at';

/**
 * The player's first session, creating it for a new account.
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param now - The clock.
 */
export async function getFirstSession(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<FirstSession> {
  return runInTransaction(
    async (client) => {
      const row = await lockOnboarding(client, userId, now);
      return row ? toView(row) : OLD_ACCOUNT;
    },
    {},
    ctx.db,
  );
}

/**
 * Add a beat. A beat already in changes nothing. When every applicable beat is in and the
 * session is `active` it becomes `done`. A skipped or finished session only records the beat.
 * @param ctx - The app context.
 * @param userId - The player.
 * @param beat - The beat.
 * @param now - The clock.
 */
export async function addBeat(
  ctx: AppContext,
  userId: string,
  beat: Beat,
  now: Date = new Date(),
): Promise<FirstSession> {
  return runInTransaction(
    async (client) => {
      const row = await lockOnboarding(client, userId, now);
      if (!row) return OLD_ACCOUNT;
      if (row.beats.includes(beat)) return toView(row);
      const beats = [...row.beats, beat];
      const complete = applicableBeats(ctx).every((b) => beats.includes(b));
      const becomesDone = row.first_session === 'active' && complete;
      const r = await client.query<OnboardingRow>(
        `UPDATE onboarding_state
            SET beats = $2, updated_at = $3,
                first_session = CASE WHEN $4 THEN 'done' ELSE first_session END,
                completed_at = CASE WHEN $4 THEN $3 ELSE completed_at END
          WHERE user_id = $1 RETURNING ${COLS}`,
        [userId, beats, now, becomesDone],
      );
      return toView(r.rows[0]!);
    },
    {},
    ctx.db,
  );
}

/** Skip the first session. Idempotent. */
export async function skipFirstSession(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<FirstSession> {
  return runInTransaction(
    async (client) => {
      const row = await lockOnboarding(client, userId, now);
      if (!row) return OLD_ACCOUNT;
      const r = await client.query<OnboardingRow>(
        `UPDATE onboarding_state SET first_session = 'skipped', updated_at = $2
          WHERE user_id = $1 AND first_session = 'active' RETURNING ${COLS}`,
        [userId, now],
      );
      return r.rows[0] ? toView(r.rows[0]) : toView(row);
    },
    {},
    ctx.db,
  );
}

/**
 * Replay the first session: active again, the beats from `moved` on cleared, `startedAt`
 * = now. The starter quests are not reseeded. An old account (no onboarding) can replay
 * too: it gets a row now (a replay is a deliberate request), started at `now`, and still no
 * starter quests.
 */
export async function replayFirstSession(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<FirstSession> {
  return runInTransaction(
    async (client) => {
      await lockOnboarding(client, userId, now);
      // An old account has no row yet: create one for the replay.
      await client.query(
        `INSERT INTO onboarding_state (user_id, started_at, updated_at, first_session, starter_seeded_at)
         SELECT id, $2, $2, 'done', $2 FROM users WHERE id = $1
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, now],
      );
      const row = (
        await client.query<OnboardingRow>(
          `SELECT ${COLS} FROM onboarding_state WHERE user_id = $1 FOR UPDATE`,
          [userId],
        )
      ).rows[0]!;
      const kept = row.beats.filter((b) => (KEPT_ON_REPLAY as readonly string[]).includes(b));
      const r = await client.query<OnboardingRow>(
        `UPDATE onboarding_state
            SET first_session = 'active', started_at = $2, completed_at = NULL,
                beats = $3, updated_at = $2
          WHERE user_id = $1 RETURNING ${COLS}`,
        [userId, now, kept],
      );
      return toView(r.rows[0]!);
    },
    {},
    ctx.db,
  );
}

/** The beat a starter verb sets. */
const BEAT_FOR_VERB: Partial<Record<QuestVerb, Beat>> = {
  shift_start: 'shift',
  trade_open: 'trade',
  chest_open: 'chest',
};

/**
 * A real server event for onboarding: counts for the starter quest of the verb and sets the
 * matching first-session beat. Call after the real action committed. Never throws.
 * @param ctx - The app context.
 * @param userId - Who did it.
 * @param verb - `shift_start`, `trade_open` or `chest_open`.
 * @param ref - A stable id of the source event (shift id, trade id, claim day).
 * @param now - The clock.
 */
export async function recordOnboardingEvent(
  ctx: AppContext,
  userId: string,
  verb: 'shift_start' | 'trade_open' | 'chest_open',
  ref: string,
  now: Date = new Date(),
): Promise<void> {
  await recordQuestEvent(ctx, userId, verb, ref, now);
  const beat = BEAT_FOR_VERB[verb];
  if (!beat) return;
  try {
    await addBeat(ctx, userId, beat, now);
  } catch (e) {
    console.error(`[onboarding] beat ${beat} failed:`, (e as Error).message);
  }
}

/**
 * A new character exists: seed the starter quests (once) and set the `character` beat.
 * Never throws.
 */
export async function onCharacterCreated(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await runInTransaction(
      async (client) => {
        await ensureStarterQuests(client, ctx, userId, now);
      },
      {},
      ctx.db,
    );
    await addBeat(ctx, userId, 'character', now);
  } catch (e) {
    console.error('[onboarding] character hook failed:', (e as Error).message);
  }
}

/** The player rolled the origin lottery: set the `origin` beat. Never throws. */
export async function onOriginRolled(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    await addBeat(ctx, userId, 'origin', now);
  } catch (e) {
    console.error('[onboarding] origin hook failed:', (e as Error).message);
  }
}
