/**
 * Social endpoints: DMs, Feed, Follows.
 *
 *   GET  /v1/dms                  - thread index (one row per peer)
 *   GET  /v1/dms/:userId?before=
 *   POST /v1/dms/:userId
 *   GET  /v1/feed, POST /v1/feed/posts  (timeline.ts)
 *   POST /v1/follows/:userId
 *   DELETE /v1/follows/:userId
 *
 * Block filtering: the requester never sees DMs from anyone
 * in their blocks list. The server returns the filtered set.
 *
 * The feed's `following` scope joins `follows` to filter
 * to posts from users the requester follows.
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { assertCleanText, assertNotMuted } from './moderation.js';
import type { AppContext } from './context.js';
import { publishToUser } from './realtime-bus.js';
import { createPlayerPost, listTimeline, type TimelinePost } from './timeline.js';

export interface DmRow {
  readonly messageId: string;
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly text: string;
  /** Contract field; `createdAt` is kept for older clients. */
  readonly at: string;
  readonly createdAt: string;
}

export interface DmThread {
  readonly userId: string;
  readonly alias: string;
  readonly lastMessage: string;
  readonly lastAt: string;
}

const DM_TEXT_MAX = 500;
const FEED_PAGE = 50;

/**
 * List DMs between the requester and `peerUserId`. Cursor is
 * the ISO timestamp of the last message; results are older
 * than the cursor.
 */
export async function listDms(
  ctx: AppContext,
  userId: string,
  peerUserId: string,
  before: string | null,
): Promise<DmRow[]> {
  const params: unknown[] = [userId, peerUserId];
  let where = `((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1))`;
  if (before !== null) {
    params.push(before);
    where += ` AND created_at < $${params.length}`;
  }
  // Block filter: exclude any message where the fromUserId is
  // in the requester's blocks list.
  params.push(userId);
  where += ` AND from_user_id NOT IN (SELECT blocked_user_id FROM blocks WHERE blocker_user_id = $${params.length})`;
  params.push(FEED_PAGE);
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      message_id: string;
      from_user_id: string;
      to_user_id: string;
      text: string;
      created_at: Date;
    }>(
      `SELECT message_id, from_user_id, to_user_id, text, created_at
       FROM dm_messages
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
  });
  return r.rows.map((row) => ({
    messageId: row.message_id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    text: row.text,
    at: row.created_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }));
}

/**
 * The requester's inbox: one row per peer they have exchanged a DM
 * with, carrying the newest message, newest thread first. Peers the
 * requester blocked are left out.
 */
export async function listDmThreads(ctx: AppContext, userId: string): Promise<DmThread[]> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{ peer: string; alias: string | null; text: string; created_at: Date }>(
      `SELECT t.peer, ch.alias, t.text, t.created_at
       FROM (
         SELECT DISTINCT ON (peer) peer, text, created_at
         FROM (
           SELECT CASE WHEN from_user_id = $1 THEN to_user_id ELSE from_user_id END AS peer,
                  text, created_at
           FROM dm_messages
           WHERE from_user_id = $1 OR to_user_id = $1
         ) m
         ORDER BY peer, created_at DESC
       ) t
       LEFT JOIN characters ch ON ch.user_id = t.peer
       WHERE t.peer NOT IN (SELECT blocked_user_id FROM blocks WHERE blocker_user_id = $1)
       ORDER BY t.created_at DESC
       LIMIT $2`,
      [userId, FEED_PAGE],
    );
  });
  return r.rows.map((row) => ({
    userId: row.peer,
    alias: row.alias ?? '',
    lastMessage: row.text,
    lastAt: row.created_at.toISOString(),
  }));
}

/**
 * Send a DM. Length 1..500, enforced both by the application
 * (validation) and by the DB CHECK constraint.
 */
export async function sendDm(
  ctx: AppContext,
  fromUserId: string,
  toUserId: string,
  text: string,
): Promise<DmRow> {
  if (text.length < 1 || text.length > DM_TEXT_MAX) {
    throw new ValidationFailedError({ reason: 'text length 1..500' });
  }
  assertCleanText(text, 'dm');
  const messageId = uuidv7();
  const createdAt = await runInTransaction(async (client) => {
    await assertNotMuted(client, fromUserId);
    // B25: Check if recipient exists
    const recipientCheck = await client.query(`SELECT id FROM users WHERE id = $1`, [toUserId]);
    if (recipientCheck.rowCount === 0) {
      throw new ValidationFailedError({ reason: 'recipient not found' });
    }

    // B25: Check mutual blocks (either direction blocks the DM)
    const blockCheck = await client.query(
      `SELECT 1 FROM blocks
       WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
          OR (blocker_user_id = $2 AND blocked_user_id = $1)
       LIMIT 1`,
      [fromUserId, toUserId],
    );
    if (blockCheck.rowCount && blockCheck.rowCount > 0) {
      throw new ValidationFailedError({ reason: 'blocked' });
    }

    const inserted = await client.query<{ created_at: Date }>(
      `INSERT INTO dm_messages (message_id, from_user_id, to_user_id, text)
       VALUES ($1, $2, $3, $4)
       RETURNING created_at`,
      [messageId, fromUserId, toUserId, text],
    );
    return inserted.rows[0]!.created_at;
  });
  // Push only after commit, so a recipient never sees a message the
  // thread fetch cannot return. Blocked pairs threw above and never get here.
  await publishToUser(ctx, toUserId, 'dm', {
    messageId,
    fromUserId,
    text,
    at: createdAt.getTime(),
  });
  const at = createdAt.toISOString();
  return { messageId, fromUserId, toUserId, text, at, createdAt: at };
}

/** A Timeline post (see timeline.ts for the fields). */
export type FeedPost = TimelinePost;

/**
 * The feed as the older API saw it: 'global' is the For-you tab, 'following'
 * the Following tab. Kept for callers that predate the tabs.
 */
export async function listFeed(
  ctx: AppContext,
  userId: string,
  scope: 'global' | 'following',
): Promise<FeedPost[]> {
  const page = await listTimeline(ctx, userId, {
    tab: scope === 'following' ? 'following' : 'foryou',
  });
  return page.posts;
}

/**
 * Post to the feed. Length 1..280, enforced by the application
 * and the DB CHECK.
 */
export async function createPost(
  _ctx: AppContext,
  userId: string,
  text: string,
): Promise<FeedPost> {
  if (text.length < 1 || text.length > POST_TEXT_MAX) {
    throw new ValidationFailedError({ reason: 'text length 1..280' });
  }
  assertCleanText(text, 'post');
  const postId = uuidv7();
  await runInTransaction(async (client) => {
    await assertNotMuted(client, userId);
    await client.query(`INSERT INTO feed_posts (post_id, user_id, text) VALUES ($1, $2, $3)`, [
      postId,
      userId,
      text,
    ]);
  });
  return { postId, userId, alias: '', text, createdAt: new Date().toISOString() };
}

/**
 * Follow a user. Idempotent on (follower, followee). The DB
 * primary key is the dedup.
 */
export async function follow(ctx: AppContext, follower: string, followee: string): Promise<void> {
  if (follower === followee) {
    throw new ValidationFailedError({ reason: 'cannot follow self' });
  }
  await ctx.db.withConnection(async (c) => {
    try {
      await c.query(`INSERT INTO follows (follower_user_id, followee_user_id) VALUES ($1, $2)`, [
        follower,
        followee,
      ]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return; // already following
      throw e;
    }
  });
}

/** Unfollow. Idempotent. */
export async function unfollow(ctx: AppContext, follower: string, followee: string): Promise<void> {
  await ctx.db.withConnection(async (c) => {
    await c.query(`DELETE FROM follows WHERE follower_user_id = $1 AND followee_user_id = $2`, [
      follower,
      followee,
    ]);
  });
}

/**
 * Is `follower` following `followee`?
 */
export async function isFollowing(
  ctx: AppContext,
  follower: string,
  followee: string,
): Promise<boolean> {
  return ctx.db.withConnection(async (c) => {
    const r = await c.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM follows WHERE follower_user_id = $1 AND followee_user_id = $2`,
      [follower, followee],
    );
    return Number(r.rows[0]?.count ?? '0') > 0;
  });
}
