/**
 * Account deletion (DELETE /v1/me).
 *
 * The users row is anonymised in place because ledger, payments, casino and
 * factory rows reference it with ON DELETE RESTRICT and must be kept. Everything
 * that identifies the person is erased in ONE serializable transaction:
 *
 *   erased          wallet / SGT / .skr name, character (alias, look, likeness
 *                   job), X link, push devices and prefs, follows, blocks,
 *                   creator profile, likeness photos/models (rows now, bytes via
 *                   storage_cleanup), unreferenced ad creatives.
 *   overwritten     DMs the user wrote and feed posts -> '[deleted]'; the alias
 *                   on tombstones -> 'Deleted player'.
 *   retained        ledger_entries, payment_intents, likeness payment records,
 *                   casino / factory / market history, reports and tips, all
 *                   keyed to the now-anonymous users.id. See docs/PRIVACY.md.
 *
 * Sessions die at once: a Redis flag makes requireAuth reject live access
 * tokens, and refresh refuses a deleted user.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { SignatureInvalidError } from '../shared/domain/errors.js';
import type { RedisLayer } from '../shared/redis/client.js';
import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';

/** The phrase the client must send so a stray DELETE cannot wipe an account. */
export const DELETE_CONFIRMATION = 'DELETE';

/** Longer than any access token lives (15 min default); refresh checks the DB. */
const DELETED_FLAG_TTL_SEC = 24 * 60 * 60;

/** Redis key that marks a user as deleted for live access tokens. */
export const deletedFlagKey = (userId: string): string => `acct:deleted:${userId}`;

/**
 * Reject tokens of a deleted account. Cheap (one Redis GET); the durable truth
 * is users.deleted_at, which refresh and login consult.
 * @param redis - The Redis layer.
 * @param userId - The token subject.
 */
export async function assertAccountActive(redis: RedisLayer, userId: string): Promise<void> {
  if ((await redis.main.get(deletedFlagKey(userId))) !== null) {
    throw new SignatureInvalidError({ reason: 'account_deleted' });
  }
}

async function queueKeys(
  client: PoolClient,
  store: 'likeness' | 'ads',
  sql: string,
  userId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO storage_cleanup (store, object_key)
     SELECT DISTINCT $2::text, k FROM (${sql}) AS t(k) WHERE k IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [userId, store],
  );
}

/**
 * Delete the account. Idempotent: a second call on a deleted account is a no-op.
 * @param ctx - The app context.
 * @param userId - The authenticated user.
 */
export async function deleteAccount(ctx: AppContext, userId: string): Promise<void> {
  await runInTransaction(async (client) => {
    const u = await client.query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );
    if (u.rows.length === 0 || u.rows[0]!.deleted_at !== null) return;

    // 1. Files first (keys are read before their rows are deleted).
    await queueKeys(
      client,
      'likeness',
      'SELECT object_key FROM likeness_uploads WHERE user_id = $1',
      userId,
    );
    await queueKeys(
      client,
      'likeness',
      'SELECT object_key FROM likeness_upload_sessions WHERE user_id = $1',
      userId,
    );
    await queueKeys(
      client,
      'likeness',
      'SELECT reference_key FROM likeness_jobs WHERE user_id = $1',
      userId,
    );
    await queueKeys(
      client,
      'likeness',
      'SELECT asset_key FROM likeness_jobs WHERE user_id = $1',
      userId,
    );
    await queueKeys(
      client,
      'ads',
      `SELECT u.image_key FROM ad_uploads u WHERE u.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM ad_bookings b WHERE b.upload_id = u.upload_id::text)`,
      userId,
    );
    await queueKeys(
      client,
      'ads',
      'SELECT avatar_image_key FROM creator_profiles WHERE user_id = $1',
      userId,
    );
    await queueKeys(
      client,
      'ads',
      'SELECT banner_image_key FROM creator_profiles WHERE user_id = $1',
      userId,
    );

    // 2. Erase personal rows. Order respects the likeness foreign keys
    //    (characters -> jobs, selections/attempts -> jobs, jobs -> uploads).
    const erase = [
      'DELETE FROM characters WHERE user_id = $1',
      'DELETE FROM likeness_selections WHERE user_id = $1',
      'DELETE FROM likeness_provider_attempts WHERE job_id IN (SELECT id FROM likeness_jobs WHERE user_id = $1)',
      'DELETE FROM likeness_jobs WHERE user_id = $1',
      'DELETE FROM likeness_action_receipts WHERE user_id = $1',
      'DELETE FROM likeness_upload_sessions WHERE user_id = $1',
      'DELETE FROM likeness_uploads WHERE user_id = $1',
      'DELETE FROM x_links WHERE user_id = $1',
      'DELETE FROM push_devices WHERE user_id = $1',
      'DELETE FROM push_prefs WHERE user_id = $1',
      'DELETE FROM push_log WHERE user_id = $1',
      'DELETE FROM creator_profiles WHERE user_id = $1',
      'DELETE FROM follows WHERE follower_user_id = $1 OR followee_user_id = $1',
      'DELETE FROM blocks WHERE blocker_user_id = $1 OR blocked_user_id = $1',
      'DELETE FROM voice_speakers WHERE user_id = $1',
      `DELETE FROM ad_uploads u WHERE u.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM ad_bookings b WHERE b.upload_id = u.upload_id::text)`,
    ];
    for (const sql of erase) await client.query(sql, [userId]);

    // 3. Overwrite free text other players can see.
    await client.query("UPDATE dm_messages SET text = '[deleted]' WHERE from_user_id = $1", [
      userId,
    ]);
    await client.query("UPDATE feed_posts SET text = '[deleted]', meta = NULL WHERE user_id = $1", [
      userId,
    ]);
    await client.query("UPDATE tombstones SET alias = 'Deleted player' WHERE user_id = $1", [
      userId,
    ]);

    // 4. Anonymise the identity row. The wallet column is UNIQUE NOT NULL, so it
    //    gets a placeholder; the same wallet can sign up again as a new account.
    await client.query(
      `UPDATE users SET wallet = 'deleted:' || id::text, is_seeker = false, sgt_mint = NULL,
              skr_name = NULL, deleted_at = now() WHERE id = $1`,
      [userId],
    );
    await client.query(
      'INSERT INTO account_deletions (user_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [userId],
    );
  });
  // After commit: kill live access tokens. (Refresh checks users.deleted_at.)
  await ctx.redis.main.set(deletedFlagKey(userId), '1', 'EX', DELETED_FLAG_TTL_SEC);
}

/** Deleter for one store; throws on failure so the row is retried. */
export type KeyDeleter = (key: string) => Promise<void>;

/**
 * Drain storage_cleanup: delete bytes from each store, mark rows done. A missing
 * deleter (store not configured on this deployment) leaves its rows queued.
 * @param ctx - The app context.
 * @param deleters - One deleter per store.
 * @param limit - Max rows per run.
 * @returns How many objects were erased.
 */
export async function purgeStorage(
  ctx: AppContext,
  deleters: Partial<Record<'likeness' | 'ads', KeyDeleter>>,
  limit = 100,
): Promise<number> {
  const stores = Object.keys(deleters);
  if (stores.length === 0) return 0;
  const rows = await ctx.db.withConnection(async (c) =>
    c.query<{ id: string; store: 'likeness' | 'ads'; object_key: string }>(
      `SELECT id, store, object_key FROM storage_cleanup
        WHERE done_at IS NULL AND store = ANY($1) ORDER BY id LIMIT $2`,
      [stores, limit],
    ),
  );
  let done = 0;
  for (const r of rows.rows) {
    try {
      await deleters[r.store]!(r.object_key);
      await ctx.db.withConnection((c) =>
        c.query(
          'UPDATE storage_cleanup SET done_at = now(), attempts = attempts + 1 WHERE id = $1',
          [r.id],
        ),
      );
      done++;
    } catch (e) {
      await ctx.db.withConnection((c) =>
        c.query(
          'UPDATE storage_cleanup SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
          [r.id, (e as Error).message.slice(0, 200)],
        ),
      );
    }
  }
  return done;
}
