/**
 * POST /v1/me/age-confirm: confirm 18+ after character creation.
 *
 * Character creation (`POST /v1/characters`, `ageConfirmed: true`) has always set
 * `characters.age_confirmed_at`. That one column is the 18+ flag the casino, the Factory,
 * the Prediction Pit and Real Markets read, and `GET /me` / `GET /casino/state` report as
 * `ageConfirmed`. Accounts without it had no way to set it later, which left them at
 * `AGE_REQUIRED` for good. This sets the same column, once:
 *
 *   - Idempotent. The first call sets `age_confirmed_at = now()` and writes one audit row
 *     (`age_confirmations`: when, X-Client-Version, source). Later calls change nothing
 *     and answer the original time with `alreadyConfirmed: true`.
 *   - Needs a character (the flag lives on it): 404 NOT_FOUND {kind: character}.
 *   - Rate-limited per player (AGE_BUCKET) on top of the global write limiter.
 *
 * There is no "I am under 18" call: a client that learns the player is a minor simply does
 * not call this (and should remember that answer locally, docs/REAL-MARKETS.md).
 */
import type { AppContext } from './context.js';
import { runInTransaction } from '../shared/db/uow.js';
import { perUserTokenBucket } from '../shared/infra/rate-limit.js';
import { NotFoundError, RateLimitedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';

/** Burst 5, then one call per 10 minutes. */
export const AGE_BUCKET = { capacity: 5, perSec: 1 / 600 };

export interface AgeConfirmResult {
  readonly ageConfirmed: true;
  readonly ageConfirmedAt: string;
  /** True when the flag was already set before this call (nothing was written). */
  readonly alreadyConfirmed: boolean;
}

/**
 * @param ctx - The app context.
 * @param userId - The caller.
 * @param clientVersion - The validated X-Client-Version, or null.
 * @returns The confirmation.
 */
export async function confirmAge(
  ctx: Pick<AppContext, 'redis'>,
  userId: string,
  clientVersion: string | null,
): Promise<AgeConfirmResult> {
  const d = await perUserTokenBucket(
    ctx.redis.main,
    `rl:age-confirm:${userId}`,
    AGE_BUCKET.capacity,
    AGE_BUCKET.perSec,
    1,
  );
  if (!d.allowed) throw new RateLimitedError(d.retryAfterMs, { reason: 'age_confirm' });

  return runInTransaction(async (client) => {
    const cur = await client.query<{ age_confirmed_at: Date | null }>(
      `SELECT age_confirmed_at FROM characters WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const row = cur.rows[0];
    if (!row) throw new NotFoundError({ kind: 'character', reason: 'character_required' });
    if (row.age_confirmed_at !== null) {
      return {
        ageConfirmed: true,
        ageConfirmedAt: row.age_confirmed_at.toISOString(),
        alreadyConfirmed: true,
      };
    }
    const set = await client.query<{ age_confirmed_at: Date }>(
      `UPDATE characters SET age_confirmed_at = now() WHERE user_id = $1 RETURNING age_confirmed_at`,
      [userId],
    );
    await client.query(
      `INSERT INTO age_confirmations (id, user_id, source, client_version) VALUES ($1, $2, 'me_age_confirm', $3)`,
      [uuidv7(), userId, clientVersion],
    );
    return {
      ageConfirmed: true,
      ageConfirmedAt: set.rows[0]!.age_confirmed_at.toISOString(),
      alreadyConfirmed: false,
    };
  });
}
