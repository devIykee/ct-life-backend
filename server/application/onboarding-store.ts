/**
 * Onboarding storage helpers shared by quests.ts (starter quests) and onboarding.ts
 * (the first-session beats). SQL only; no business rules and no imports from either.
 *
 * Who is "new": an account created at or after `onboarding_meta.epoch` (the moment
 * migration 097 ran). An older account has no onboarding row, never gets one, reads as
 * done and gets no starter quests.
 */
import type { PoolClient } from 'pg';

export type Q = Pick<PoolClient, 'query'>;

export type FirstSessionState = 'active' | 'skipped' | 'done';

export interface OnboardingRow {
  readonly first_session: FirstSessionState;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly beats: string[];
  readonly starter_seeded_at: Date | null;
}

const COLS = 'first_session, started_at, completed_at, beats, starter_seeded_at';

/**
 * The player's onboarding row, locked, creating it for a new account. Null for an old
 * account (or an unknown user): they have no onboarding.
 * @param client - The open transaction.
 * @param userId - The player.
 * @param now - Stamped as started_at on creation.
 */
export async function lockOnboarding(
  client: Q,
  userId: string,
  now: Date,
): Promise<OnboardingRow | null> {
  await client.query(
    `INSERT INTO onboarding_state (user_id, started_at, updated_at)
     SELECT u.id, $2, $2 FROM users u
      WHERE u.id = $1 AND u.created_at >= (SELECT epoch FROM onboarding_meta LIMIT 1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, now],
  );
  const r = await client.query<OnboardingRow>(
    `SELECT ${COLS} FROM onboarding_state WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  return r.rows[0] ?? null;
}

/**
 * Is this a NEW account: created at or after the onboarding epoch? This, and only this,
 * decides starter-quest eligibility. The existence of an onboarding row does not: a replay
 * by an old account creates one, and that must never make it eligible.
 */
export async function isNewAccount(client: Q, userId: string): Promise<boolean> {
  const r = await client.query<{ is_new: boolean }>(
    `SELECT u.created_at >= (SELECT epoch FROM onboarding_meta LIMIT 1) AS is_new
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  return r.rows[0]?.is_new === true;
}
