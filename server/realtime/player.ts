/**
 * Join-time helpers shared by the rooms that carry PlayerState
 * (venue, street): JWT check, the player's profile from the database,
 * and the `say` text filter.
 */
import { type JWTPayload } from 'jose';
import { PlayerState } from '../../contract/realtime/states.js';
import { computeOutfit, outfitStateSql } from '../shared/domain/outfit.js';
import { createJwtIssuer } from '../shared/auth/jwt.js';
import { loadConfig } from '../shared/config/config.js';
import { maskProfanity } from '../application/factory-filter.js';

/** Contract order of PlayerState.look. */
const LOOK_SLOTS = [
  'skinTone',
  'headId',
  'hairId',
  'topId',
  'bottomId',
  'shoesId',
  'accId',
] as const;

export const LOOK_FALLBACK = ['0', '0', '0', '0', '0', '0', '0'];

/**
 * Flatten a stored character look into the room's string[7].
 *
 * `characters.look` is jsonb holding the contract `Look` object, but
 * PlayerState.look is a string[7] in contract order. Without this the
 * object fails an Array.isArray check and every player is broadcast
 * wearing the placeholder look.
 * @param raw - The jsonb value read from characters.look.
 * @returns The seven look ids in contract order.
 */
export function lookToArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // Legacy rows that already stored an array.
    return raw.length === LOOK_SLOTS.length ? raw.map((v) => String(v)) : [...LOOK_FALLBACK];
  }
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    return LOOK_SLOTS.map((k, i) => {
      const v = o[k];
      return typeof v === 'string' && v !== '' ? v : LOOK_FALLBACK[i]!;
    });
  }
  return [...LOOK_FALLBACK];
}

/**
 * Verify the join token and return the user id.
 *
 * An empty token is only accepted with dev auth on, and gets a random
 * dev id.
 * @param options - The join options; only `token` is read.
 * @returns The authenticated user id.
 */
export async function authenticateJoin(options: unknown): Promise<string> {
  const token = String((options as { token?: string })?.token ?? '');
  if (token === '') {
    if (!loadConfig().auth.devAuthEnabled) throw new Error('AUTH_REQUIRED');
    return `dev-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
  let claims: JWTPayload;
  try {
    claims = await createJwtIssuer().verifyAccess(token);
  } catch (err) {
    throw new Error('INVALID_TOKEN', { cause: err });
  }
  await assertJoinAllowed(claims.sub ?? '');
  return claims.sub ?? '';
}

/**
 * Refuse a banned account at the door of any room. A still-valid access token
 * is not enough: the ban flag and, failing that, the database decide.
 * @param userId - The verified token subject.
 * @throws Error `ACCOUNT_BANNED`.
 */
export async function assertJoinAllowed(userId: string): Promise<void> {
  // Only real accounts (UUIDs) can be banned; dev-token ids never touch the database.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return;
  const [{ buildContext }, { assertNotBanned }] = await Promise.all([
    import('../application/context.js'),
    import('../application/moderation.js'),
  ]);
  try {
    await assertNotBanned(buildContext(), userId);
  } catch (e) {
    if ((e as { code?: string }).code === 'ACCOUNT_BANNED') {
      throw new Error('ACCOUNT_BANNED', { cause: e });
    }
    throw e;
  }
}

/**
 * Build a PlayerState from the database, never from join options.
 * @param userId - The authenticated user.
 * @returns A PlayerState with identity and look filled in (position 0,0).
 */
export async function loadPlayerState(userId: string): Promise<PlayerState> {
  const { buildContext } = await import('../application/context.js');
  const ctx = buildContext();
  const result = await ctx.db.withConnection(async (c) => {
    return c.query(
      `SELECT c.alias, u.skr_name, u.is_seeker, u.miner_tier, c.tribe_id, c.look,
              ${outfitStateSql('c.user_id', 'c.look')}
       FROM characters c
       JOIN users u ON u.id = c.user_id
       WHERE c.user_id = $1
       LIMIT 1`,
      [userId],
    );
  });
  const player = new PlayerState();
  player.userId = userId;
  const row = result.rowCount === 0 ? null : result.rows[0];
  player.name = row?.alias || 'Anon';
  player.skrName = row?.skr_name || '';
  player.isSeeker = row?.is_seeker || false;
  player.tribeId = row?.tribe_id || '';
  player.minerTier = row?.miner_tier || 'none';
  player.look = row ? lookToArray(row.look) : [...LOOK_FALLBACK];
  player.outfit =
    computeOutfit(row?.on_shift === true, row?.uniform_equipped === true) ?? undefined;
  return player;
}

/**
 * Apply an outfit message from the api to every matching player in a room's state. Ignores
 * malformed messages.
 * @param players - The room's players.
 * @param data - `{userId, outfit}` as published on OUTFIT_CHANNEL.
 */
export function applyOutfitMessage(
  players: { forEach(cb: (p: PlayerState) => void): void },
  data: unknown,
): void {
  const d = data as { userId?: unknown; outfit?: unknown } | null;
  if (!d || typeof d.userId !== 'string') return;
  if (d.outfit !== null && typeof d.outfit !== 'string') return;
  const outfit = d.outfit === null || d.outfit === '' ? undefined : d.outfit;
  players.forEach((p) => {
    if (p.userId === d.userId) p.outfit = outfit;
  });
}

export const SAY_MAX_LENGTH = 140;
export const SAY_COOLDOWN_MS = 2_000;
export const EMOTE_COOLDOWN_MS = 1_000;

const LINK_REGEX = /(?:https?:\/\/|www\.)[^\s]+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi;
const PHONE_REGEX = /(?:\+?\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s-]?\d{3}[\s-]?\d{4}/g;

/**
 * Apply the `say` filter: length cap, links and phone numbers masked,
 * printable ASCII only.
 * @param raw - Text as sent.
 * @returns The text to broadcast.
 */
export function filterSay(raw: string): string {
  return raw
    .slice(0, SAY_MAX_LENGTH)
    .replace(LINK_REGEX, '[link]')
    .replace(PHONE_REGEX, '[phone]')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/^.*$/s, (t) => maskProfanity(t));
}

export interface SayPolicy {
  /** The speaker is muted: nothing is delivered. */
  readonly muted: boolean;
  /** Users who blocked the speaker or were blocked by them (rows exist both ways). */
  readonly blocked: ReadonlySet<string>;
}

/**
 * Load who may hear a player's `say`: their mute and every block either way.
 * Read per message (the say cooldown is 2 s), so a block made a second ago
 * already applies. Callers must drop the message when this throws.
 * @param userId - The speaker.
 */
export async function loadSayPolicy(userId: string): Promise<SayPolicy> {
  const { buildContext } = await import('../application/context.js');
  const ctx = buildContext();
  return ctx.db.withConnection(async (c) => {
    const [mute, blocks] = await Promise.all([
      c.query(
        'SELECT 1 FROM user_moderation WHERE user_id = $1 AND (muted_until > now() OR banned_at IS NOT NULL)',
        [userId],
      ),
      c.query<{ other: string }>(
        `SELECT blocked_user_id AS other FROM blocks WHERE blocker_user_id = $1
         UNION SELECT blocker_user_id FROM blocks WHERE blocked_user_id = $1`,
        [userId],
      ),
    ]);
    return {
      muted: (mute.rowCount ?? 0) > 0,
      blocked: new Set(blocks.rows.map((r) => r.other)),
    };
  });
}

/**
 * @returns A unique id for a `said` message.
 */
export function newMessageId(): string {
  return 'msg-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}
