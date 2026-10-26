/**
 * Group chats and alpha groups inside Messages (board groupchats-22;
 * docs/GROUPS.md).
 *
 * Kinds and caps:
 *   friends  invite-only, up to 12
 *   alpha    one caller (the owner), topics Calls / Chat / Wins, up to 50
 *   tribe    automatic, one per tribe, up to 200 (joined when you list groups)
 *
 * Free and invite-only: there is no entry fee (Cash is non-transferable) and
 * nothing is ever paid for inviting or posting a link. Calls are cards over a
 * real alpha_calls row (entry = the server's price), graded by the existing
 * evaluator, so the caller's Trust score is earned, not claimed. Wins are
 * cards over a position with realized PnL.
 *
 * Messages go out over the existing per-user realtime bus (`group_msg`, the
 * same path as `dm`), never to someone who blocked the author. Safety: links,
 * e-mails, phone numbers and wallet-like strings are masked; report, leave,
 * block, remove (with a ban), slow mode per topic; a group reported by three
 * different players is hidden.
 */
import { randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';
import { runInTransaction } from '../shared/db/uow.js';
import {
  BlockedError,
  ConflictError,
  ForbiddenError,
  NameNotAllowedError,
  NotFoundError,
  RateLimitedError,
  ValidationFailedError,
} from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import { isBlockedText } from './factory-filter.js';
import { getTrustScore, placeAlphaCall, type TrustScore } from './alpha.js';
import { publishToUser } from './realtime-bus.js';
import { decodePos, getIslandGeometry, POS_HASH } from '../realtime/movement.js';

export type GroupKind = 'friends' | 'alpha' | 'tribe';
export type GroupRole = 'owner' | 'mod' | 'member';
export type GroupTopic = 'chat' | 'calls' | 'wins';

/** Member caps (user decision 2026-10-26: 12 / 50 / 200). */
export const GROUP_CAPS: Record<GroupKind, number> = { friends: 12, alpha: 50, tribe: 200 };
/** Groups one player may own at a time. */
export const MAX_OWNED_GROUPS = 5;
/** Distinct reporters that hide a group. */
export const HIDE_AFTER_REPORTS = 3;
export const MESSAGE_MAX = 500;
const PAGE = 50;
const INVITE_TTL_HOURS_DEFAULT = 7 * 24;
const INVITE_TTL_HOURS_MAX = 30 * 24;
const SLOW_MODE_MAX_S = 300;
const HERE_RADIUS_M = 60;
const POS_FRESH_MS = 120_000;
const TOPICS: Record<GroupKind, readonly GroupTopic[]> = {
  friends: ['chat'],
  tribe: ['chat'],
  alpha: ['calls', 'chat', 'wins'],
};

/** Booths an alpha group can claim (board D4): Cabal Lounge velvet booths, Discord Heights doors. */
export const BOOTHS: Record<string, readonly string[]> = {
  cabal_lounge: ['booth_1', 'booth_2', 'booth_3', 'booth_4', 'booth_5', 'booth_6'],
  discord_heights: ['general', 'alpha_maybe', 'gm', 'wen_token', 'support_ticket', 'memes'],
};

// --- Text -------------------------------------------------------------------

const LINK_RE =
  /(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|io|xyz|fun|gg|app|net|org|sol|me|co)\b\S*/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s-]?\d{3}[\s-]?\d{4}/g;
/** Base58 runs of 32-44 chars (Solana keys) and 0x hex addresses. */
const WALLET_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b|\b0x[a-fA-F0-9]{40}\b/g;

/**
 * Mask what a scammer needs: links, e-mails, phone numbers, wallet addresses.
 * @param raw - Message text.
 * @returns The text to store and send.
 */
export function cleanChatText(raw: string): string {
  // Drop control characters (keep tab and newline).
  const printable = [...raw]
    .filter((ch) => {
      const c = ch.charCodeAt(0);
      return c === 9 || c === 10 || (c >= 32 && c !== 127);
    })
    .join('');
  return printable
    .replace(EMAIL_RE, '[hidden]')
    .replace(LINK_RE, '[link]')
    .replace(WALLET_RE, '[wallet]')
    .replace(PHONE_RE, '[phone]')
    .trim()
    .slice(0, MESSAGE_MAX);
}

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 40 || isBlockedText(name)) {
    throw new NameNotAllowedError({ field: 'name' });
  }
  return name;
}

function inviteCode(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 10; i++) s += A[randomInt(A.length)];
  return s;
}

// --- Access -----------------------------------------------------------------

interface GroupRow {
  group_id: string;
  kind: GroupKind;
  name: string;
  owner_user_id: string | null;
  tribe_id: string | null;
  member_cap: number;
  rules: string;
  slow_mode: Record<string, number>;
  hidden_at: Date | null;
  created_at: Date;
}

interface Access {
  group: GroupRow;
  role: GroupRole;
}

async function access(
  c: Pick<PoolClient, 'query'>,
  userId: string,
  groupId: string,
  lock = false,
): Promise<Access> {
  const r = await c.query<GroupRow & { role: GroupRole | null }>(
    `SELECT g.*, m.role FROM groups g
       LEFT JOIN group_members m ON m.group_id = g.group_id AND m.user_id = $2
      WHERE g.group_id = $1 ${lock ? 'FOR UPDATE OF g' : ''}`,
    [groupId, userId],
  );
  const row = r.rows[0];
  // Not a member looks the same as no group: the id leaks nothing.
  if (!row || row.role === null) throw new NotFoundError({ kind: 'group', id: groupId });
  if (row.hidden_at) throw new ForbiddenError({ reason: 'group_hidden' });
  return { group: row, role: row.role };
}

const canManage = (role: GroupRole): boolean => role === 'owner' || role === 'mod';

/**
 * Joins lock the invite row and then the group row (FOR UPDATE) before
 * reading the member count, so the cap and max uses hold at READ COMMITTED.
 * Under SERIALIZABLE a burst of joins on one link mostly failed with
 * serialization errors instead of queueing on the lock.
 */
const LOCKED = { isolation: 'read committed' } as const;

// --- Groups -----------------------------------------------------------------

export interface GroupSummary {
  readonly groupId: string;
  readonly kind: GroupKind;
  readonly name: string;
  readonly role: GroupRole;
  readonly memberCount: number;
  readonly memberCap: number;
  readonly unread: number;
  readonly muted: boolean;
  readonly mutedUntil: string | null;
  readonly lastMessage: {
    readonly topic: GroupTopic;
    readonly authorAlias: string;
    readonly preview: string;
    readonly at: string;
  } | null;
  readonly booth: { venueId: string; boothId: string } | null;
}

/**
 * Create a friends or alpha group. The creator is the owner; `inviteUserIds`
 * get direct invites (invite-only: nobody is added without accepting).
 */
export async function createGroup(
  ctx: AppContext,
  ownerId: string,
  input: { kind: 'friends' | 'alpha'; name: string; inviteUserIds?: string[] },
  now: Date = new Date(),
): Promise<GroupSummary> {
  const name = cleanName(input.name);
  const groupId = uuidv7();
  await runInTransaction(
    async (c) => {
      // Serialize this owner's creates so the cap cannot race.
      await c.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [ownerId]);
      const owned = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM groups WHERE owner_user_id = $1`,
        [ownerId],
      );
      if ((owned.rows[0]?.n ?? 0) >= MAX_OWNED_GROUPS) {
        throw new ConflictError({ reason: 'too_many_groups', max: MAX_OWNED_GROUPS });
      }
      await c.query(
        `INSERT INTO groups (group_id, kind, name, owner_user_id, member_cap, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [groupId, input.kind, name, ownerId, GROUP_CAPS[input.kind], now],
      );
      await c.query(
        `INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_at)
       VALUES ($1, $2, 'owner', $3, $3)`,
        [groupId, ownerId, now],
      );
    },
    {},
    ctx.db,
  );
  const invitees = [...new Set(input.inviteUserIds ?? [])].filter((u) => u !== ownerId);
  for (const u of invitees.slice(0, GROUP_CAPS[input.kind] - 1)) {
    try {
      await inviteUser(ctx, ownerId, groupId, u, now);
    } catch {
      // A blocked or unknown invitee is skipped; the group is still created.
    }
  }
  return (await listMyGroups(ctx, ownerId)).find((g) => g.groupId === groupId)!;
}

/** Make sure the player is in their tribe's chat (created on first use). */
async function ensureTribeChat(ctx: AppContext, userId: string, now: Date): Promise<void> {
  const t = await ctx.db.withConnection((c) =>
    c.query<{ tribe_id: string }>(`SELECT tribe_id FROM characters WHERE user_id = $1`, [userId]),
  );
  const tribeId = t.rows[0]?.tribe_id;
  if (!tribeId) return;
  const tribes = ctx.configCache.load<{ tribes: { id: string; name: string }[] }>('tribes').tribes;
  const tribeName = tribes.find((x) => x.id === tribeId)?.name ?? tribeId;
  await runInTransaction(
    async (c) => {
      await c.query(
        `INSERT INTO groups (group_id, kind, name, tribe_id, member_cap, created_at)
       VALUES ($1, 'tribe', $2, $3, $4, $5)
       ON CONFLICT (tribe_id) DO NOTHING`,
        [uuidv7(), `${tribeName} tribe`.slice(0, 40), tribeId, GROUP_CAPS.tribe, now],
      );
      const g = await c.query<{ group_id: string; member_cap: number }>(
        `SELECT group_id, member_cap FROM groups WHERE tribe_id = $1 FOR UPDATE`,
        [tribeId],
      );
      const group = g.rows[0]!;
      const already = await c.query(
        `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [group.group_id, userId],
      );
      if (already.rowCount) return;
      const banned = await c.query(
        `SELECT 1 FROM group_bans WHERE group_id = $1 AND user_id = $2`,
        [group.group_id, userId],
      );
      if (banned.rowCount) return;
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM group_members WHERE group_id = $1`,
        [group.group_id],
      );
      if ((n.rows[0]?.n ?? 0) >= group.member_cap) return; // full: no tribe chat for now
      await c.query(
        `INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_at)
       VALUES ($1, $2, 'member', $3, $3) ON CONFLICT DO NOTHING`,
        [group.group_id, userId, now],
      );
    },
    LOCKED,
    ctx.db,
  );
}

/**
 * The caller's groups, newest activity first, with unread counts. Joins the
 * caller's tribe chat on the way.
 */
export async function listMyGroups(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<GroupSummary[]> {
  await ensureTribeChat(ctx, userId, now);
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      group_id: string;
      kind: GroupKind;
      name: string;
      role: GroupRole;
      member_cap: number;
      muted_until: Date | null;
      member_count: number;
      unread: number;
      last_topic: GroupTopic | null;
      last_text: string | null;
      last_card: Record<string, unknown> | null;
      last_alias: string | null;
      last_at: Date | null;
      venue_id: string | null;
      booth_id: string | null;
    }>(
      `SELECT g.group_id, g.kind, g.name, m.role, g.member_cap, m.muted_until,
              (SELECT count(*)::int FROM group_members x WHERE x.group_id = g.group_id) AS member_count,
              (SELECT count(*)::int FROM (
                 SELECT 1 FROM group_messages gm
                  WHERE gm.group_id = g.group_id AND gm.created_at > m.last_read_at
                    AND gm.author_user_id <> $1 AND gm.deleted_at IS NULL
                  LIMIT 99) u) AS unread,
              lm.topic AS last_topic, lm.text AS last_text, lm.card AS last_card,
              lm.alias AS last_alias, lm.created_at AS last_at,
              b.venue_id, b.booth_id
         FROM group_members m
         JOIN groups g ON g.group_id = m.group_id AND g.hidden_at IS NULL
         LEFT JOIN venue_booths b ON b.group_id = g.group_id
         LEFT JOIN LATERAL (
           SELECT gm.topic, gm.text, gm.card, gm.created_at, COALESCE(ch.alias, 'anon') AS alias
             FROM group_messages gm
             LEFT JOIN characters ch ON ch.user_id = gm.author_user_id
            WHERE gm.group_id = g.group_id AND gm.deleted_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM blocks bl
                               WHERE bl.blocker_user_id = $1 AND bl.blocked_user_id = gm.author_user_id)
            ORDER BY gm.created_at DESC LIMIT 1) lm ON true
        WHERE m.user_id = $1
        ORDER BY COALESCE(lm.created_at, m.joined_at) DESC`,
      [userId],
    ),
  );
  return r.rows.map((row) => ({
    groupId: row.group_id,
    kind: row.kind,
    name: row.name,
    role: row.role,
    memberCount: row.member_count,
    memberCap: row.member_cap,
    unread: row.unread,
    muted: row.muted_until !== null && row.muted_until > now,
    mutedUntil: row.muted_until && row.muted_until > now ? row.muted_until.toISOString() : null,
    lastMessage: row.last_at
      ? {
          topic: row.last_topic!,
          authorAlias: row.last_alias ?? 'anon',
          preview: row.last_text || previewOfCard(row.last_card),
          at: row.last_at.toISOString(),
        }
      : null,
    booth: row.venue_id ? { venueId: row.venue_id, boothId: row.booth_id! } : null,
  }));
}

function previewOfCard(card: Record<string, unknown> | null): string {
  if (!card) return '';
  if (card.type === 'call') return `NEW CALL $${String(card.ticker ?? '')}`;
  if (card.type === 'pnl') return `WIN on $${String(card.ticker ?? '')}`;
  return '';
}

export interface GroupInfo {
  readonly groupId: string;
  readonly kind: GroupKind;
  readonly name: string;
  readonly rules: string;
  readonly role: GroupRole;
  readonly memberCount: number;
  readonly memberCap: number;
  readonly topics: readonly GroupTopic[];
  readonly slowMode: Record<string, number>;
  readonly owner: { userId: string; alias: string } | null;
  /** Alpha groups: the caller's server-graded record. */
  readonly trust: TrustScore | null;
  readonly booth: { venueId: string; boothId: string } | null;
  /** Members standing near you right now (server positions), not counting you. */
  readonly hereWithYou: number;
  readonly muted: boolean;
}

/**
 * One group's info sheet.
 */
export async function getGroup(
  ctx: AppContext,
  userId: string,
  groupId: string,
  now: Date = new Date(),
): Promise<GroupInfo> {
  const { group, role, members, owner, booth, mutedUntil } = await ctx.db.withConnection(
    async (c) => {
      const a = await access(c, userId, groupId);
      const m = await c.query<{ user_id: string; muted_until: Date | null }>(
        `SELECT user_id, muted_until FROM group_members WHERE group_id = $1`,
        [groupId],
      );
      const o = a.group.owner_user_id
        ? await c.query<{ alias: string }>(`SELECT alias FROM characters WHERE user_id = $1`, [
            a.group.owner_user_id,
          ])
        : { rows: [] as { alias: string }[] };
      const b = await c.query<{ venue_id: string; booth_id: string }>(
        `SELECT venue_id, booth_id FROM venue_booths WHERE group_id = $1`,
        [groupId],
      );
      return {
        group: a.group,
        role: a.role,
        members: m.rows.map((x) => x.user_id),
        mutedUntil: m.rows.find((x) => x.user_id === userId)?.muted_until ?? null,
        owner: a.group.owner_user_id
          ? { userId: a.group.owner_user_id, alias: o.rows[0]?.alias ?? 'anon' }
          : null,
        booth: b.rows[0] ? { venueId: b.rows[0].venue_id, boothId: b.rows[0].booth_id } : null,
      };
    },
  );
  return {
    groupId,
    kind: group.kind,
    name: group.name,
    rules: group.rules,
    role,
    memberCount: members.length,
    memberCap: group.member_cap,
    topics: TOPICS[group.kind],
    slowMode: group.slow_mode,
    owner,
    trust: group.kind === 'alpha' && owner ? await getTrustScore(ctx, owner.userId) : null,
    booth,
    hereWithYou: await countNear(ctx, members, userId, now),
    muted: mutedUntil !== null && mutedUntil > now,
  };
}

/** Members within HERE_RADIUS_M of `aroundUserId` (or of a point), by server positions. */
async function countNear(
  ctx: AppContext,
  memberIds: string[],
  aroundUserId: string | null,
  now: Date,
  point?: readonly [number, number],
): Promise<number> {
  if (memberIds.length === 0) return 0;
  try {
    const ids = aroundUserId ? [aroundUserId, ...memberIds] : memberIds;
    const raw = await ctx.redis.main.hmget(POS_HASH, ...ids);
    const fresh = raw.map((s) => {
      const p = decodePos(s);
      return p && now.getTime() - p.at <= POS_FRESH_MS ? p : null;
    });
    const center = point ?? (fresh[0] ? ([fresh[0].x, fresh[0].z] as const) : null);
    if (!center) return 0;
    const others = aroundUserId ? fresh.slice(1) : fresh;
    return others.filter(
      (p, i) =>
        p !== null &&
        memberIds[i] !== aroundUserId &&
        Math.hypot(p.x - center[0], p.z - center[1]) <= HERE_RADIUS_M,
    ).length;
  } catch {
    return 0;
  }
}

/** Members of a group (caller must be one). */
export async function listMembers(
  ctx: AppContext,
  userId: string,
  groupId: string,
): Promise<{ userId: string; alias: string; role: GroupRole; joinedAt: string }[]> {
  return ctx.db.withConnection(async (c) => {
    await access(c, userId, groupId);
    const r = await c.query<{
      user_id: string;
      alias: string | null;
      role: GroupRole;
      joined_at: Date;
    }>(
      `SELECT m.user_id, ch.alias, m.role, m.joined_at FROM group_members m
         LEFT JOIN characters ch ON ch.user_id = m.user_id
        WHERE m.group_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'mod' THEN 1 ELSE 2 END, m.joined_at`,
      [groupId],
    );
    return r.rows.map((x) => ({
      userId: x.user_id,
      alias: x.alias ?? 'anon',
      role: x.role,
      joinedAt: x.joined_at.toISOString(),
    }));
  });
}

/** Rename, rules, slow mode (owner or mod; only the owner renames). */
export async function updateGroup(
  ctx: AppContext,
  userId: string,
  groupId: string,
  input: { name?: string; rules?: string; slowMode?: Partial<Record<GroupTopic, number>> },
): Promise<GroupInfo> {
  await runInTransaction(
    async (c) => {
      const a = await access(c, userId, groupId, true);
      if (!canManage(a.role) || (a.group.kind === 'tribe' && a.role !== 'owner')) {
        throw new ForbiddenError({ reason: 'mods_only' });
      }
      if (input.name !== undefined) {
        if (a.role !== 'owner') throw new ForbiddenError({ reason: 'owner_only' });
        await c.query(`UPDATE groups SET name = $2 WHERE group_id = $1`, [
          groupId,
          cleanName(input.name),
        ]);
      }
      if (input.rules !== undefined) {
        await c.query(`UPDATE groups SET rules = $2 WHERE group_id = $1`, [
          groupId,
          cleanChatText(input.rules),
        ]);
      }
      if (input.slowMode !== undefined) {
        const next: Record<string, number> = { ...a.group.slow_mode };
        for (const [topic, s] of Object.entries(input.slowMode)) {
          if (!TOPICS[a.group.kind].includes(topic as GroupTopic)) continue;
          const v = Math.max(0, Math.min(SLOW_MODE_MAX_S, Math.trunc(Number(s) || 0)));
          if (v === 0) delete next[topic];
          else next[topic] = v;
        }
        await c.query(`UPDATE groups SET slow_mode = $2 WHERE group_id = $1`, [
          groupId,
          JSON.stringify(next),
        ]);
      }
    },
    {},
    ctx.db,
  );
  return getGroup(ctx, userId, groupId);
}

/** Mute banners for this group (0 hours unmutes). */
export async function muteGroup(
  ctx: AppContext,
  userId: string,
  groupId: string,
  hours: number,
  now: Date = new Date(),
): Promise<{ mutedUntil: string | null }> {
  const until = hours > 0 ? new Date(now.getTime() + hours * 3_600_000) : null;
  await ctx.db.withConnection(async (c) => {
    await access(c, userId, groupId);
    await c.query(
      `UPDATE group_members SET muted_until = $3 WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId, until],
    );
  });
  return { mutedUntil: until ? until.toISOString() : null };
}

/** Mark everything up to now as read. */
export async function markRead(
  ctx: AppContext,
  userId: string,
  groupId: string,
  now: Date = new Date(),
): Promise<void> {
  await ctx.db.withConnection(async (c) => {
    await access(c, userId, groupId);
    await c.query(
      `UPDATE group_members SET last_read_at = $3 WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId, now],
    );
  });
}

/**
 * Leave a group. The owner hands over to the oldest mod, else the oldest
 * member; the last one out deletes the group. Tribe chats cannot be left
 * (mute them instead).
 */
export async function leaveGroup(ctx: AppContext, userId: string, groupId: string): Promise<void> {
  await runInTransaction(
    async (c) => {
      const a = await access(c, userId, groupId, true);
      if (a.group.kind === 'tribe') throw new ForbiddenError({ reason: 'tribe_chat_is_automatic' });
      await c.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [
        groupId,
        userId,
      ]);
      if (a.role !== 'owner') return;
      const next = await c.query<{ user_id: string }>(
        `SELECT user_id FROM group_members WHERE group_id = $1
        ORDER BY CASE role WHEN 'mod' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
        [groupId],
      );
      if (!next.rows[0]) {
        await c.query(`DELETE FROM groups WHERE group_id = $1`, [groupId]);
        return;
      }
      await c.query(
        `UPDATE group_members SET role = 'owner' WHERE group_id = $1 AND user_id = $2`,
        [groupId, next.rows[0].user_id],
      );
      await c.query(`UPDATE groups SET owner_user_id = $2 WHERE group_id = $1`, [
        groupId,
        next.rows[0].user_id,
      ]);
    },
    {},
    ctx.db,
  );
}

/**
 * Remove a member (owner or mod; mods cannot remove the owner or other mods).
 * The removed player is banned from rejoining by invite.
 */
export async function removeMember(
  ctx: AppContext,
  actorId: string,
  groupId: string,
  targetId: string,
): Promise<void> {
  await runInTransaction(
    async (c) => {
      const a = await access(c, actorId, groupId, true);
      if (!canManage(a.role)) throw new ForbiddenError({ reason: 'mods_only' });
      if (targetId === actorId) throw new ValidationFailedError({ reason: 'use leave' });
      const t = await c.query<{ role: GroupRole }>(
        `SELECT role FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [groupId, targetId],
      );
      const target = t.rows[0];
      if (!target) throw new NotFoundError({ kind: 'member', id: targetId });
      if (target.role === 'owner' || (target.role === 'mod' && a.role !== 'owner')) {
        throw new ForbiddenError({ reason: 'cannot_remove_this_member' });
      }
      await c.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [
        groupId,
        targetId,
      ]);
      await c.query(
        `INSERT INTO group_bans (group_id, user_id, banned_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [groupId, targetId, actorId],
      );
    },
    {},
    ctx.db,
  );
}

/** Make a member a mod or back (owner only). */
export async function setMemberRole(
  ctx: AppContext,
  actorId: string,
  groupId: string,
  targetId: string,
  role: 'mod' | 'member',
): Promise<void> {
  await runInTransaction(
    async (c) => {
      const a = await access(c, actorId, groupId, true);
      if (a.role !== 'owner') throw new ForbiddenError({ reason: 'owner_only' });
      const r = await c.query(
        `UPDATE group_members SET role = $3 WHERE group_id = $1 AND user_id = $2 AND role <> 'owner'`,
        [groupId, targetId, role],
      );
      if (!r.rowCount) throw new NotFoundError({ kind: 'member', id: targetId });
    },
    {},
    ctx.db,
  );
}

// --- Invites ----------------------------------------------------------------

export interface InviteView {
  readonly code: string;
  readonly deepLink: string;
  readonly groupId: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly uses: number;
}

function canInvite(a: Access): boolean {
  if (a.group.kind === 'tribe') return false;
  return a.group.kind === 'friends' || canManage(a.role);
}

/**
 * A shareable invite link. Friends groups: any member; alpha groups: owner and
 * mods; tribe chats have none. Sharing it earns nothing.
 */
export async function createInviteLink(
  ctx: AppContext,
  userId: string,
  groupId: string,
  opts: { maxUses?: number; ttlHours?: number } = {},
  now: Date = new Date(),
): Promise<InviteView> {
  const maxUses = Math.max(1, Math.min(1000, Math.trunc(opts.maxUses ?? 25)));
  const ttl = Math.max(
    1,
    Math.min(INVITE_TTL_HOURS_MAX, opts.ttlHours ?? INVITE_TTL_HOURS_DEFAULT),
  );
  const code = inviteCode();
  const expiresAt = new Date(now.getTime() + ttl * 3_600_000);
  await ctx.db.withConnection(async (c) => {
    const a = await access(c, userId, groupId);
    if (!canInvite(a)) throw new ForbiddenError({ reason: 'cannot_invite' });
    await c.query(
      `INSERT INTO group_invites (code, group_id, created_by, max_uses, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code, groupId, userId, maxUses, expiresAt, now],
    );
  });
  return {
    code,
    deepLink: `ctlife://invite/${code}`,
    groupId,
    expiresAt: expiresAt.toISOString(),
    maxUses,
    uses: 0,
  };
}

/**
 * Invite one player directly; it shows in their Invites list (kept apart, like
 * message requests) and as a `group_invite` realtime message.
 */
export async function inviteUser(
  ctx: AppContext,
  userId: string,
  groupId: string,
  inviteeId: string,
  now: Date = new Date(),
): Promise<{ code: string }> {
  const code = inviteCode();
  const groupName = await ctx.db.withConnection(async (c) => {
    const a = await access(c, userId, groupId);
    if (!canInvite(a)) throw new ForbiddenError({ reason: 'cannot_invite' });
    const u = await c.query(`SELECT 1 FROM users WHERE id = $1`, [inviteeId]);
    if (!u.rowCount) throw new NotFoundError({ kind: 'user', id: inviteeId });
    const blocked = await c.query(
      `SELECT 1 FROM blocks WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
                               OR (blocker_user_id = $2 AND blocked_user_id = $1) LIMIT 1`,
      [userId, inviteeId],
    );
    if (blocked.rowCount) throw new BlockedError({});
    const member = await c.query(
      `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, inviteeId],
    );
    if (member.rowCount) throw new ConflictError({ reason: 'already_member' });
    await c.query(
      `INSERT INTO group_invites (code, group_id, created_by, invitee_user_id, max_uses, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6)`,
      [
        code,
        groupId,
        userId,
        inviteeId,
        new Date(now.getTime() + INVITE_TTL_HOURS_DEFAULT * 3_600_000),
        now,
      ],
    );
    return a.group.name;
  });
  await publishToUser(ctx, inviteeId, 'group_invite', {
    code,
    groupId,
    groupName,
    fromUserId: userId,
    at: now.getTime(),
  });
  return { code };
}

export interface InvitePreview {
  readonly code: string;
  readonly groupId: string;
  readonly groupName: string;
  readonly kind: GroupKind;
  readonly memberCount: number;
  readonly memberCap: number;
  readonly from: { userId: string; alias: string };
  readonly owner: { userId: string; alias: string } | null;
  readonly trust: TrustScore | null;
  readonly expiresAt: string;
  /** False when expired, used up, revoked, for someone else, or the group is hidden or full. */
  readonly valid: boolean;
}

interface InviteRow {
  code: string;
  group_id: string;
  created_by: string;
  invitee_user_id: string | null;
  max_uses: number;
  uses: number;
  expires_at: Date;
  revoked_at: Date | null;
  name: string;
  kind: GroupKind;
  member_cap: number;
  owner_user_id: string | null;
  hidden_at: Date | null;
  member_count: number;
  from_alias: string | null;
  owner_alias: string | null;
}

const INVITE_SELECT = `
  SELECT i.*, g.name, g.kind, g.member_cap, g.owner_user_id, g.hidden_at,
         (SELECT count(*)::int FROM group_members x WHERE x.group_id = g.group_id) AS member_count,
         fc.alias AS from_alias, oc.alias AS owner_alias
    FROM group_invites i
    JOIN groups g ON g.group_id = i.group_id
    LEFT JOIN characters fc ON fc.user_id = i.created_by
    LEFT JOIN characters oc ON oc.user_id = g.owner_user_id`;

function inviteValid(i: InviteRow, userId: string, now: Date): boolean {
  return (
    i.revoked_at === null &&
    i.expires_at > now &&
    i.uses < i.max_uses &&
    i.hidden_at === null &&
    i.member_count < i.member_cap &&
    (i.invitee_user_id === null || i.invitee_user_id === userId)
  );
}

async function previewOf(
  ctx: AppContext,
  i: InviteRow,
  userId: string,
  now: Date,
): Promise<InvitePreview> {
  return {
    code: i.code,
    groupId: i.group_id,
    groupName: i.name,
    kind: i.kind,
    memberCount: i.member_count,
    memberCap: i.member_cap,
    from: { userId: i.created_by, alias: i.from_alias ?? 'anon' },
    owner: i.owner_user_id ? { userId: i.owner_user_id, alias: i.owner_alias ?? 'anon' } : null,
    trust: i.kind === 'alpha' && i.owner_user_id ? await getTrustScore(ctx, i.owner_user_id) : null,
    expiresAt: i.expires_at.toISOString(),
    valid: inviteValid(i, userId, now),
  };
}

/** What an invite code opens (before accepting). */
export async function previewInvite(
  ctx: AppContext,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<InvitePreview> {
  const r = await ctx.db.withConnection((c) =>
    c.query<InviteRow>(`${INVITE_SELECT} WHERE i.code = $1`, [code]),
  );
  const i = r.rows[0];
  if (!i || (i.invitee_user_id !== null && i.invitee_user_id !== userId)) {
    throw new NotFoundError({ kind: 'invite' });
  }
  return previewOf(ctx, i, userId, now);
}

/** Direct invites waiting for the caller (the Invites list). */
export async function listMyInvites(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<InvitePreview[]> {
  const r = await ctx.db.withConnection((c) =>
    c.query<InviteRow>(
      `${INVITE_SELECT}
        WHERE i.invitee_user_id = $1 AND i.revoked_at IS NULL AND i.uses < i.max_uses
          AND i.expires_at > $2 AND g.hidden_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = i.group_id AND m.user_id = $1)
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_user_id = $1 AND b.blocked_user_id = i.created_by)
        ORDER BY i.created_at DESC LIMIT 50`,
      [userId, now],
    ),
  );
  return Promise.all(r.rows.map((i) => previewOf(ctx, i, userId, now)));
}

/**
 * Join a group with an invite code. Atomic: the invite and the group are
 * locked, so the cap and max uses hold under concurrent joins.
 */
export async function acceptInvite(
  ctx: AppContext,
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<GroupSummary> {
  const groupId = await runInTransaction(
    async (c) => {
      const inv = await c.query<{
        group_id: string;
        invitee_user_id: string | null;
        max_uses: number;
        uses: number;
        expires_at: Date;
        revoked_at: Date | null;
      }>(`SELECT * FROM group_invites WHERE code = $1 FOR UPDATE`, [code]);
      const i = inv.rows[0];
      if (!i || (i.invitee_user_id !== null && i.invitee_user_id !== userId)) {
        throw new NotFoundError({ kind: 'invite' });
      }
      if (i.revoked_at || i.expires_at <= now || i.uses >= i.max_uses) {
        throw new ForbiddenError({ reason: 'invite_expired' });
      }
      const g = await c.query<{ hidden_at: Date | null; member_cap: number }>(
        `SELECT hidden_at, member_cap FROM groups WHERE group_id = $1 FOR UPDATE`,
        [i.group_id],
      );
      if (!g.rows[0] || g.rows[0].hidden_at) throw new ForbiddenError({ reason: 'group_hidden' });
      const member = await c.query(
        `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [i.group_id, userId],
      );
      if (member.rowCount) return i.group_id; // already in: a no-op, the invite is not used up
      const banned = await c.query(
        `SELECT 1 FROM group_bans WHERE group_id = $1 AND user_id = $2`,
        [i.group_id, userId],
      );
      if (banned.rowCount) throw new ForbiddenError({ reason: 'removed_from_group' });
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM group_members WHERE group_id = $1`,
        [i.group_id],
      );
      if ((n.rows[0]?.n ?? 0) >= g.rows[0].member_cap) {
        throw new ConflictError({ reason: 'group_full', cap: g.rows[0].member_cap });
      }
      await c.query(
        `INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_at)
       VALUES ($1, $2, 'member', $3, $3)`,
        [i.group_id, userId, now],
      );
      await c.query(`UPDATE group_invites SET uses = uses + 1 WHERE code = $1`, [code]);
      return i.group_id;
    },
    LOCKED,
    ctx.db,
  );
  return (await listMyGroups(ctx, userId, now)).find((g) => g.groupId === groupId)!;
}

/** Decline a direct invite (only its invitee). */
export async function declineInvite(ctx: AppContext, userId: string, code: string): Promise<void> {
  const r = await ctx.db.withConnection((c) =>
    c.query(
      `UPDATE group_invites SET revoked_at = now()
        WHERE code = $1 AND invitee_user_id = $2 AND revoked_at IS NULL`,
      [code, userId],
    ),
  );
  if (!r.rowCount) throw new NotFoundError({ kind: 'invite' });
}

// --- Messages ---------------------------------------------------------------

export type GroupCard =
  | {
      readonly type: 'call';
      readonly callId: string;
      readonly coinId: string;
      readonly ticker: string;
      readonly entryMicros: string;
      readonly targetMicros: string;
      readonly stopMicros: string;
      /** Graded by the server: open, hit_target, hit_stop, expired. */
      readonly status: string;
      readonly priceMicros: string;
      readonly deepLink: string;
    }
  | {
      readonly type: 'pnl';
      readonly coinId: string;
      readonly ticker: string;
      readonly realizedCents: string;
      readonly deepLink: string;
    };

export interface GroupMessage {
  readonly messageId: string;
  readonly groupId: string;
  readonly topic: GroupTopic;
  readonly authorUserId: string;
  readonly authorAlias: string;
  readonly text: string;
  readonly card: GroupCard | null;
  readonly at: string;
}

export type PostInput =
  | { topic: 'chat'; text: string }
  | { topic: 'calls'; coinId: string; targetX: number; stopPct: number; text?: string }
  | { topic: 'wins'; coinId: string; text?: string };

/**
 * Post to a topic. Chat: any member. Calls (alpha groups): only the owner, as
 * a structured call on a live coin with the server's price as the entry.
 * Wins (alpha groups): a card over the author's own realized PnL on a coin.
 */
export async function postMessage(
  ctx: AppContext,
  userId: string,
  groupId: string,
  input: PostInput,
  now: Date = new Date(),
): Promise<GroupMessage> {
  const text = cleanChatText('text' in input && input.text ? input.text : '');
  const prep = await ctx.db.withConnection(async (c) => {
    const a = await access(c, userId, groupId);
    if (!TOPICS[a.group.kind].includes(input.topic)) {
      throw new ValidationFailedError({ reason: 'topic not in this group', topic: input.topic });
    }
    const slow = Number(a.group.slow_mode[input.topic] ?? 0);
    if (slow > 0 && !canManage(a.role)) {
      const last = await c.query<{ created_at: Date }>(
        `SELECT created_at FROM group_messages
          WHERE group_id = $1 AND author_user_id = $2 AND topic = $3
          ORDER BY created_at DESC LIMIT 1`,
        [groupId, userId, input.topic],
      );
      const since = now.getTime() - (last.rows[0]?.created_at.getTime() ?? 0);
      if (since < slow * 1000)
        throw new RateLimitedError(slow * 1000 - since, { slowModeSeconds: slow });
    }
    return a;
  });

  let card: Record<string, unknown> | null = null;
  if (input.topic === 'chat') {
    if (text.length === 0) throw new ValidationFailedError({ reason: 'text required' });
  } else if (input.topic === 'calls') {
    if (prep.role !== 'owner') throw new ForbiddenError({ reason: 'calls_owner_only' });
    if (
      !(input.targetX >= 1.05 && input.targetX <= 100) ||
      !(input.stopPct >= 1 && input.stopPct <= 95)
    ) {
      throw new ValidationFailedError({ reason: 'targetX 1.05..100, stopPct 1..95' });
    }
    const coin = await liveCoin(ctx, input.coinId);
    const entry = BigInt(coin.price_micros);
    const target = (entry * BigInt(Math.round(input.targetX * 100))) / 100n;
    const stop = (entry * BigInt(Math.round((100 - input.stopPct) * 100))) / 10_000n;
    if (entry <= 0n || stop <= 0n || target <= stop) {
      throw new ValidationFailedError({ reason: 'price too small for this call' });
    }
    const call = await placeAlphaCall(ctx, {
      userId,
      coinId: coin.coin_id,
      entryMicros: entry.toString(),
      targetMicros: target.toString(),
      stopMicros: stop.toString(),
    });
    card = { type: 'call', callId: call.callId, coinId: coin.coin_id, ticker: coin.ticker };
  } else {
    const pnl = await ctx.db.withConnection((c) =>
      c.query<{ coin_id: string; ticker: string; realized_cents: string }>(
        `SELECT p.coin_id, c.ticker, p.realized_cents FROM positions p
           JOIN coins c ON c.coin_id = p.coin_id
          WHERE p.user_id = $1 AND p.coin_id = $2`,
        [userId, input.coinId],
      ),
    );
    const row = pnl.rows[0];
    if (!row || BigInt(row.realized_cents) <= 0n) {
      throw new ValidationFailedError({ reason: 'no realized profit on this coin' });
    }
    card = {
      type: 'pnl',
      coinId: row.coin_id,
      ticker: row.ticker,
      realizedCents: row.realized_cents,
    };
  }

  const messageId = uuidv7();
  const members = await ctx.db.withConnection(async (c) => {
    await c.query(
      `INSERT INTO group_messages (message_id, group_id, topic, author_user_id, text, card, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [messageId, groupId, input.topic, userId, text, card ? JSON.stringify(card) : null, now],
    );
    await c.query(
      `UPDATE group_members SET last_read_at = $3 WHERE group_id = $1 AND user_id = $2`,
      [groupId, userId, now],
    );
    // Everyone but the author and anyone who blocked the author.
    const m = await c.query<{ user_id: string; muted_until: Date | null }>(
      `SELECT m.user_id, m.muted_until FROM group_members m
        WHERE m.group_id = $1 AND m.user_id <> $2
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_user_id = m.user_id AND b.blocked_user_id = $2)`,
      [groupId, userId],
    );
    return m.rows;
  });
  const msg = (await messagesByIds(ctx, [messageId]))[0]!;
  const payload = { ...msg, groupName: prep.group.name, kind: prep.group.kind };
  for (const m of members) {
    await publishToUser(ctx, m.user_id, 'group_msg', {
      ...payload,
      muted: m.muted_until !== null && m.muted_until > now,
    });
  }
  return msg;
}

async function liveCoin(
  ctx: AppContext,
  coinId: string,
): Promise<{ coin_id: string; ticker: string; price_micros: string }> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ coin_id: string; ticker: string; price_micros: string; stage: string }>(
      `SELECT coin_id, ticker, price_micros, stage FROM coins WHERE coin_id = $1`,
      [coinId],
    ),
  );
  const coin = r.rows[0];
  if (!coin) throw new NotFoundError({ kind: 'coin', id: coinId });
  if (coin.stage === 'dead') throw new ValidationFailedError({ reason: 'coin is dead' });
  return coin;
}

interface MsgRow {
  message_id: string;
  group_id: string;
  topic: GroupTopic;
  author_user_id: string;
  alias: string | null;
  text: string;
  card: Record<string, unknown> | null;
  created_at: Date;
  call_status: string | null;
  entry_micros: string | null;
  target_micros: string | null;
  stop_micros: string | null;
  price_micros: string | null;
}

const MSG_SELECT = `
  SELECT gm.message_id, gm.group_id, gm.topic, gm.author_user_id, ch.alias, gm.text, gm.card,
         gm.created_at, ac.status AS call_status, ac.entry_micros, ac.target_micros, ac.stop_micros,
         co.price_micros
    FROM group_messages gm
    LEFT JOIN characters ch ON ch.user_id = gm.author_user_id
    LEFT JOIN alpha_calls ac ON ac.call_id = (gm.card ->> 'callId')::uuid
    LEFT JOIN coins co ON co.coin_id = (gm.card ->> 'coinId')::uuid`;

function toMessage(r: MsgRow): GroupMessage {
  let card: GroupCard | null = null;
  const c = r.card;
  if (c?.type === 'call' && r.call_status) {
    card = {
      type: 'call',
      callId: String(c.callId),
      coinId: String(c.coinId),
      ticker: String(c.ticker),
      entryMicros: String(r.entry_micros),
      targetMicros: String(r.target_micros),
      stopMicros: String(r.stop_micros),
      status: r.call_status,
      priceMicros: String(r.price_micros ?? '0'),
      deepLink: `ctlife://coin/${String(c.coinId)}`,
    };
  } else if (c?.type === 'pnl') {
    card = {
      type: 'pnl',
      coinId: String(c.coinId),
      ticker: String(c.ticker),
      realizedCents: String(c.realizedCents),
      deepLink: `ctlife://coin/${String(c.coinId)}`,
    };
  }
  return {
    messageId: r.message_id,
    groupId: r.group_id,
    topic: r.topic,
    authorUserId: r.author_user_id,
    authorAlias: r.alias ?? 'anon',
    text: r.text,
    card,
    at: r.created_at.toISOString(),
  };
}

async function messagesByIds(ctx: AppContext, ids: string[]): Promise<GroupMessage[]> {
  const r = await ctx.db.withConnection((c) =>
    c.query<MsgRow>(`${MSG_SELECT} WHERE gm.message_id = ANY($1::uuid[])`, [ids]),
  );
  return r.rows.map(toMessage);
}

/**
 * A topic's messages, newest first, older than `before`. Authors the caller
 * blocked are left out; call cards show the server's grade and live price.
 */
export async function listMessages(
  ctx: AppContext,
  userId: string,
  groupId: string,
  topic: GroupTopic,
  before: string | null,
): Promise<{ messages: GroupMessage[]; nextBefore: string | null }> {
  const cursor = before ? new Date(before) : new Date(8.64e15);
  if (Number.isNaN(cursor.getTime())) throw new ValidationFailedError({ reason: 'bad cursor' });
  const rows = await ctx.db.withConnection(async (c) => {
    const a = await access(c, userId, groupId);
    if (!TOPICS[a.group.kind].includes(topic)) {
      throw new ValidationFailedError({ reason: 'topic not in this group', topic });
    }
    const r = await c.query<MsgRow>(
      `${MSG_SELECT}
        WHERE gm.group_id = $1 AND gm.topic = $2 AND gm.created_at < $3 AND gm.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_user_id = $4 AND b.blocked_user_id = gm.author_user_id)
        ORDER BY gm.created_at DESC LIMIT $5`,
      [groupId, topic, cursor, userId, PAGE],
    );
    return r.rows;
  });
  const last = rows[rows.length - 1];
  return {
    messages: rows.map(toMessage),
    nextBefore: rows.length === PAGE && last ? last.created_at.toISOString() : null,
  };
}

/** Delete a message (its author, or an owner or mod). */
export async function deleteMessage(
  ctx: AppContext,
  userId: string,
  groupId: string,
  messageId: string,
): Promise<void> {
  await ctx.db.withConnection(async (c) => {
    const a = await access(c, userId, groupId);
    const r = await c.query(
      `UPDATE group_messages SET deleted_at = now()
        WHERE message_id = $1 AND group_id = $2 AND deleted_at IS NULL
          AND (author_user_id = $3 OR $4)`,
      [messageId, groupId, userId, canManage(a.role)],
    );
    if (!r.rowCount) throw new NotFoundError({ kind: 'message', id: messageId });
  });
}

// --- Safety -----------------------------------------------------------------

/**
 * Report a group (a member, or a player holding an invite to it). One report
 * per player; three different reporters hide it for everyone.
 */
export async function reportGroup(
  ctx: AppContext,
  userId: string,
  groupId: string,
  reasonId: string,
  note: string | null,
): Promise<{ hidden: boolean }> {
  const reasons = ctx.configCache.load<{ reportReasons: { id: string }[] }>('report_reasons');
  if (!reasons.reportReasons.some((r) => r.id === reasonId)) {
    throw new ValidationFailedError({ reason: 'unknown reasonId', reasonId });
  }
  return runInTransaction(
    async (c) => {
      const known = await c.query(
        `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2
       UNION ALL
       SELECT 1 FROM group_invites WHERE group_id = $1 AND invitee_user_id = $2 LIMIT 1`,
        [groupId, userId],
      );
      if (!known.rowCount) throw new NotFoundError({ kind: 'group', id: groupId });
      await c.query(
        `INSERT INTO group_reports (group_id, reporter_user_id, reason_id, note)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [groupId, userId, reasonId, note ? cleanChatText(note) : null],
      );
      const n = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM group_reports WHERE group_id = $1`,
        [groupId],
      );
      if ((n.rows[0]?.n ?? 0) >= HIDE_AFTER_REPORTS) {
        await c.query(
          `UPDATE groups SET hidden_at = COALESCE(hidden_at, now()) WHERE group_id = $1`,
          [groupId],
        );
        return { hidden: true };
      }
      return { hidden: false };
    },
    {},
    ctx.db,
  );
}

// --- Booths -----------------------------------------------------------------

export interface BoothView {
  readonly venueId: string;
  readonly boothId: string;
  readonly group: { groupId: string; name: string; memberCount: number; here: number } | null;
}

/** A venue's booths and who holds them ("FROG CALLS · 6 here"). */
export async function listBooths(
  ctx: AppContext,
  venueId: string,
  now: Date = new Date(),
): Promise<BoothView[]> {
  const booths = BOOTHS[venueId];
  if (!booths) throw new NotFoundError({ kind: 'venue_booths', id: venueId });
  const r = await ctx.db.withConnection((c) =>
    c.query<{ booth_id: string; group_id: string; name: string; members: string[] }>(
      `SELECT b.booth_id, g.group_id, g.name,
              ARRAY(SELECT m.user_id::text FROM group_members m WHERE m.group_id = g.group_id) AS members
         FROM venue_booths b JOIN groups g ON g.group_id = b.group_id AND g.hidden_at IS NULL
        WHERE b.venue_id = $1`,
      [venueId],
    ),
  );
  const door = getIslandGeometry().venues?.[venueId]?.door;
  const byBooth = new Map(r.rows.map((x) => [x.booth_id, x]));
  return Promise.all(
    booths.map(async (boothId) => {
      const row = byBooth.get(boothId);
      return {
        venueId,
        boothId,
        group: row
          ? {
              groupId: row.group_id,
              name: row.name,
              memberCount: row.members.length,
              here: door ? await countNear(ctx, row.members, null, now, door) : 0,
            }
          : null,
      };
    }),
  );
}

/** Claim a booth for an alpha group (owner only; one booth per group, one group per booth). */
export async function claimBooth(
  ctx: AppContext,
  userId: string,
  groupId: string,
  venueId: string,
  boothId: string,
): Promise<{ venueId: string; boothId: string }> {
  if (!BOOTHS[venueId]?.includes(boothId)) {
    throw new ValidationFailedError({ reason: 'unknown booth', venueId, boothId });
  }
  await runInTransaction(
    async (c) => {
      const a = await access(c, userId, groupId, true);
      if (a.group.kind !== 'alpha') throw new ForbiddenError({ reason: 'alpha_groups_only' });
      if (a.role !== 'owner') throw new ForbiddenError({ reason: 'owner_only' });
      const taken = await c.query<{ group_id: string }>(
        `SELECT group_id FROM venue_booths WHERE venue_id = $1 AND booth_id = $2 FOR UPDATE`,
        [venueId, boothId],
      );
      if (taken.rows[0] && taken.rows[0].group_id !== groupId) {
        throw new ConflictError({ reason: 'booth_taken' });
      }
      await c.query(`DELETE FROM venue_booths WHERE group_id = $1`, [groupId]);
      try {
        await c.query(
          `INSERT INTO venue_booths (venue_id, booth_id, group_id) VALUES ($1, $2, $3)`,
          [venueId, boothId, groupId],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23505')
          throw new ConflictError({ reason: 'booth_taken' });
        throw e;
      }
    },
    {},
    ctx.db,
  );
  return { venueId, boothId };
}

/** Give the booth back (owner only). */
export async function releaseBooth(
  ctx: AppContext,
  userId: string,
  groupId: string,
): Promise<void> {
  await runInTransaction(
    async (c) => {
      const a = await access(c, userId, groupId, true);
      if (a.role !== 'owner') throw new ForbiddenError({ reason: 'owner_only' });
      await c.query(`DELETE FROM venue_booths WHERE group_id = $1`, [groupId]);
    },
    {},
    ctx.db,
  );
}
