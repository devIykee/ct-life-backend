/**
 * Moderation: text filter, mutes and bans, and the admin review of reports.
 *
 *   - Text filter. DMs, feed posts and character aliases are REFUSED with
 *     `CONTENT_NOT_ALLOWED` when a word fails the shared curated list in
 *     factory-filter.ts (no package: lists reviewed in-repo, no runtime
 *     dependency). Live room chat is masked instead (see realtime/player.ts).
 *   - Mute: until `muted_until` the player cannot send DMs, feed posts or room
 *     chat (`ACCOUNT_MUTED`). Checked at write time against the database.
 *   - Ban: no tokens are issued (login/refresh refuse) and a Redis flag cuts
 *     live access tokens at once (`ACCOUNT_BANNED`).
 *   - Reports: an admin lists open reports with a preview of what was reported
 *     and closes each with dismiss / remove_content / mute / ban. Every action is
 *     written to `moderation_actions`.
 */
import { runInTransaction } from '../shared/db/uow.js';
import {
  AccountBannedError,
  AccountMutedError,
  ConflictError,
  ContentNotAllowedError,
  NotFoundError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import type { RedisLayer } from '../shared/redis/client.js';
import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';
import { containsProfanity } from './factory-filter.js';

/** Live access tokens last 15 minutes; refresh is blocked by the DB check. */
const BAN_FLAG_TTL_SEC = 24 * 60 * 60;
type Queryable = Pick<PoolClient, 'query'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Presence/pub-sub channel: `{userId}` of a player who was just banned. Rooms kick their sessions. */
export const BAN_CHANNEL = 'ctl:ban';

export const bannedFlagKey = (userId: string): string => `acct:banned:${userId}`;

/**
 * Refuse text with a slur or strong profanity.
 * @param text - What the player typed.
 * @param field - Which input it is (reported in the error details).
 */
export function assertCleanText(text: string, field: 'alias' | 'dm' | 'post'): void {
  if (containsProfanity(text)) throw new ContentNotAllowedError({ field });
}

/**
 * Throw `ACCOUNT_BANNED` for a banned account (live-token check, one Redis GET).
 * @param redis - The Redis layer.
 * @param userId - The token subject.
 */
export async function assertNotBannedLive(redis: RedisLayer, userId: string): Promise<void> {
  if ((await redis.main.get(bannedFlagKey(userId))) !== null) throw new AccountBannedError({});
}

/**
 * Throw `ACCOUNT_BANNED` when the database says the player is banned (login, refresh).
 * @param db - Any query runner.
 * @param userId - The player.
 */
export async function assertNotBannedDb(db: Queryable, userId: string): Promise<void> {
  const r = await db.query(
    'SELECT 1 FROM user_moderation WHERE user_id = $1 AND banned_at IS NOT NULL',
    [userId],
  );
  if ((r.rowCount ?? 0) > 0) throw new AccountBannedError({});
}

/**
 * Throw `ACCOUNT_MUTED` while a mute is running.
 * @param db - Any query runner.
 * @param userId - The player.
 * @param now - Clock.
 */
export async function assertNotMuted(
  db: Queryable,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const until = await mutedUntil(db, userId, now);
  if (until) throw new AccountMutedError({ until: until.toISOString() });
}

/**
 * When the player's mute ends, or null when they are not muted.
 * @param db - Any query runner.
 * @param userId - The player.
 * @param now - Clock.
 */
export async function mutedUntil(
  db: Queryable,
  userId: string,
  now: Date = new Date(),
): Promise<Date | null> {
  const r = await db.query<{ muted_until: Date | null }>(
    'SELECT muted_until FROM user_moderation WHERE user_id = $1 AND muted_until > $2',
    [userId, now],
  );
  return r.rows[0]?.muted_until ?? null;
}

export type ReportAction = 'dismiss' | 'remove_content' | 'mute' | 'ban';

export interface ResolveInput {
  readonly action: ReportAction;
  /** Mute length in hours, 1..720 (default 24). */
  readonly hours?: number;
  readonly note?: string;
}

async function applySanction(
  client: Queryable,
  adminId: string,
  userId: string,
  action: 'mute' | 'unmute' | 'ban' | 'unban',
  opts: { hours?: number; reason?: string; reportId?: number },
): Promise<void> {
  const hours = opts.hours ?? 24;
  if (action === 'mute' && (!Number.isInteger(hours) || hours < 1 || hours > 720)) {
    throw new ValidationFailedError({ reason: 'mute_hours_1_720' });
  }
  await client.query(
    `INSERT INTO user_moderation (user_id, reason, set_by) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, opts.reason ?? null, adminId],
  );
  const set: Record<typeof action, string> = {
    mute: `muted_until = now() + make_interval(hours => $4)`,
    unmute: `muted_until = NULL`,
    ban: `banned_at = now()`,
    unban: `banned_at = NULL`,
  };
  await client.query(
    `UPDATE user_moderation SET ${set[action]}, reason = COALESCE($2, reason), set_by = $3, updated_at = now()
      WHERE user_id = $1`,
    action === 'mute'
      ? [userId, opts.reason ?? null, adminId, hours]
      : [userId, opts.reason ?? null, adminId],
  );
  await client.query(
    `INSERT INTO moderation_actions (admin_user_id, action, target_user_id, report_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      adminId,
      action,
      userId,
      opts.reportId ?? null,
      JSON.stringify({ hours: opts.hours, reason: opts.reason }),
    ],
  );
}

async function setBanFlag(ctx: AppContext, userId: string, banned: boolean): Promise<void> {
  if (banned) {
    await ctx.redis.main.set(bannedFlagKey(userId), '1', 'EX', BAN_FLAG_TTL_SEC);
    // Cut live realtime sessions (street, venue, home rooms listen).
    try {
      await ctx.redis.main.publish(BAN_CHANNEL, JSON.stringify({ userId }));
    } catch {
      // The flag and the join check still hold; the kick is best effort.
    }
  } else {
    await ctx.redis.main.del(bannedFlagKey(userId));
  }
}

/**
 * Refuse a banned account: the Redis flag first (instant), then the database
 * (the flag expires after a day and Redis can be flushed).
 * @param ctx - The app context.
 * @param userId - The player.
 */
export async function assertNotBanned(ctx: AppContext, userId: string): Promise<void> {
  try {
    await assertNotBannedLive(ctx.redis, userId);
  } catch (e) {
    if (e instanceof AccountBannedError) throw e;
    // Redis down: fall through to the database.
  }
  await ctx.db.withConnection((c) => assertNotBannedDb(c, userId));
}

/**
 * Mute, unmute, ban or unban a player directly (no report needed).
 * @param ctx - The app context.
 * @param adminId - The acting admin.
 * @param userId - The player.
 * @param action - What to do.
 * @param opts - Mute hours and a reason.
 */
export async function sanctionUser(
  ctx: AppContext,
  adminId: string,
  userId: string,
  action: 'mute' | 'unmute' | 'ban' | 'unban',
  opts: { hours?: number; reason?: string } = {},
): Promise<void> {
  await runInTransaction(async (client) => {
    const u = await client.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (u.rowCount === 0) throw new NotFoundError({ kind: 'user' });
    await applySanction(client, adminId, userId, action, opts);
  });
  if (action === 'ban' || action === 'unban') await setBanFlag(ctx, userId, action === 'ban');
}

export interface ReportRow {
  readonly reportId: number;
  readonly reporterUserId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly reasonId: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly action: string | null;
  readonly resolutionNote: string | null;
  /** Who the report is about, when it can be worked out (user / message / post). */
  readonly targetUserId: string | null;
  /** The reported text (message / post) or the player's alias (user). */
  readonly preview: string | null;
  /** Open reports on the same target, this one included. */
  readonly openOnTarget: number;
}

interface RawReport {
  report_id: string;
  reporter_user_id: string;
  target_type: string;
  target_id: string;
  reason_id: string;
  note: string | null;
  created_at: Date;
  resolved_at: Date | null;
  action: string | null;
  resolution_note: string | null;
}

async function targetOf(
  db: Queryable,
  type: string,
  id: string,
): Promise<{ userId: string | null; preview: string | null }> {
  if (!UUID.test(id)) return { userId: null, preview: null };
  if (type === 'user') {
    const r = await db.query<{ alias: string | null }>(
      'SELECT (SELECT alias FROM characters WHERE user_id = u.id) alias FROM users u WHERE u.id = $1',
      [id],
    );
    return r.rows[0] ? { userId: id, preview: r.rows[0].alias } : { userId: null, preview: null };
  }
  if (type === 'message') {
    const r = await db.query<{ from_user_id: string; text: string }>(
      'SELECT from_user_id, text FROM dm_messages WHERE message_id = $1',
      [id],
    );
    return { userId: r.rows[0]?.from_user_id ?? null, preview: r.rows[0]?.text ?? null };
  }
  if (type === 'post') {
    const r = await db.query<{ user_id: string; text: string }>(
      'SELECT user_id, text FROM feed_posts WHERE post_id = $1',
      [id],
    );
    return { userId: r.rows[0]?.user_id ?? null, preview: r.rows[0]?.text ?? null };
  }
  return { userId: null, preview: null };
}

/**
 * The review queue, oldest open first.
 * @param ctx - The app context.
 * @param opts - `status` open / resolved / all, page size, and `after` (report id) for paging.
 */
export async function listReports(
  ctx: AppContext,
  opts: { status: 'open' | 'resolved' | 'all'; limit: number; after?: number },
): Promise<{ reports: ReportRow[]; next: number | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status === 'open') where.push('resolved_at IS NULL');
  if (opts.status === 'resolved') where.push('resolved_at IS NOT NULL');
  if (opts.after !== undefined) {
    params.push(opts.after);
    where.push(`report_id > $${params.length}`);
  }
  params.push(opts.limit + 1);
  return ctx.db.withConnection(async (c) => {
    const rows = await c.query<RawReport>(
      `SELECT report_id, reporter_user_id, target_type, target_id, reason_id, note, created_at,
              resolved_at, action, resolution_note
         FROM reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY report_id ASC LIMIT $${params.length}`,
      params,
    );
    const page = rows.rows.slice(0, opts.limit);
    const reports: ReportRow[] = [];
    for (const r of page) {
      const t = await targetOf(c, r.target_type, r.target_id);
      const open = await c.query<{ n: string }>(
        `SELECT count(*) n FROM reports WHERE target_type = $1 AND target_id = $2 AND resolved_at IS NULL`,
        [r.target_type, r.target_id],
      );
      reports.push({
        reportId: Number(r.report_id),
        reporterUserId: r.reporter_user_id,
        targetType: r.target_type,
        targetId: r.target_id,
        reasonId: r.reason_id,
        note: r.note,
        createdAt: r.created_at.toISOString(),
        resolvedAt: r.resolved_at?.toISOString() ?? null,
        action: r.action,
        resolutionNote: r.resolution_note,
        targetUserId: t.userId,
        preview: t.preview,
        openOnTarget: Number(open.rows[0]!.n),
      });
    }
    const next = rows.rows.length > opts.limit ? Number(page[page.length - 1]!.report_id) : null;
    return { reports, next };
  });
}

/**
 * Close a report. Other open reports on the same target are closed with it.
 * @param ctx - The app context.
 * @param adminId - The acting admin.
 * @param reportId - The report.
 * @param input - Action, mute hours, note.
 * @returns The action taken and the player it hit.
 */
export async function resolveReport(
  ctx: AppContext,
  adminId: string,
  reportId: number,
  input: ResolveInput,
): Promise<{ action: ReportAction; targetUserId: string | null; closed: number }> {
  let banned: string | null = null;
  const out = await runInTransaction(async (client) => {
    const rep = await client.query<RawReport>(
      'SELECT * FROM reports WHERE report_id = $1 FOR UPDATE',
      [reportId],
    );
    const r = rep.rows[0];
    if (!r) throw new NotFoundError({ kind: 'report' });
    if (r.resolved_at !== null) throw new ConflictError({ reason: 'report_already_resolved' });
    const t = await targetOf(client, r.target_type, r.target_id);

    if (input.action === 'remove_content') {
      if (r.target_type === 'message') {
        await client.query("UPDATE dm_messages SET text = '[removed]' WHERE message_id = $1", [
          r.target_id,
        ]);
      } else if (r.target_type === 'post') {
        await client.query(
          "UPDATE feed_posts SET text = '[removed]', meta = NULL WHERE post_id = $1",
          [r.target_id],
        );
      } else {
        throw new ValidationFailedError({ reason: 'remove_content_needs_message_or_post' });
      }
      await client.query(
        `INSERT INTO moderation_actions (admin_user_id, action, target_user_id, report_id, detail)
         VALUES ($1, 'remove_content', $2, $3, $4)`,
        [
          adminId,
          t.userId,
          reportId,
          JSON.stringify({ targetType: r.target_type, targetId: r.target_id }),
        ],
      );
    } else if (input.action === 'mute' || input.action === 'ban') {
      if (!t.userId) throw new ValidationFailedError({ reason: 'report_has_no_target_user' });
      await applySanction(client, adminId, t.userId, input.action, {
        ...(input.hours !== undefined ? { hours: input.hours } : {}),
        ...(input.note !== undefined ? { reason: input.note } : {}),
        reportId,
      });
      if (input.action === 'ban') banned = t.userId;
    } else {
      await client.query(
        `INSERT INTO moderation_actions (admin_user_id, action, target_user_id, report_id)
         VALUES ($1, 'dismiss', $2, $3)`,
        [adminId, t.userId, reportId],
      );
    }
    const closed = await client.query(
      `UPDATE reports SET resolved_by = $1, resolved_at = now(), action = $2, resolution_note = $3
        WHERE target_type = $4 AND target_id = $5 AND resolved_at IS NULL`,
      [adminId, input.action, input.note ?? null, r.target_type, r.target_id],
    );
    return { action: input.action, targetUserId: t.userId, closed: closed.rowCount ?? 0 };
  });
  if (banned) await setBanFlag(ctx, banned, true);
  return out;
}
