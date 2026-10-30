/**
 * Creator profile service.
 *
 * Endpoints:
 *
 *   POST  /v1/creator            — create a creator profile (one per user)
 *   GET   /v1/creator/:handle   — public read by handle
 *   PATCH /v1/creator            — update bio, banner, avatar, categories
 *   PUT   /v1/creator            — creator mode for paid calls: on/off, USDC rate,
 *                                  max minutes (unlock C2; capability creatorMode)
 *
 * `handle` is the public identifier; UNIQUE on the table. The
 * creator profile is the basis for paid calls (server/application/
 * paid-calls.ts reads the ratePerMinCents off the creator's
 * config — that field lives here in the M4 slice).
 */
import { runInTransaction } from '../shared/db/uow.js';
import { ConflictError, NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { isCapabilityOn } from './capabilities.js';

const HANDLE_REGEX = /^[a-z0-9_]+$/;
const HANDLE_MIN = 3;
const HANDLE_MAX = 32;
const BIO_MAX = 500;

export interface CreatorProfile {
  readonly userId: string;
  readonly handle: string;
  readonly bio: string;
  readonly bannerImageKey: string | null;
  readonly avatarImageKey: string | null;
  readonly categories: string[];
  readonly createdAt: string;
}

export interface CreateCreatorArgs {
  readonly handle: string;
  readonly bio?: string;
  readonly categories?: string[];
}

export interface UpdateCreatorArgs {
  readonly bio?: string;
  readonly bannerImageKey?: string | null;
  readonly avatarImageKey?: string | null;
  readonly categories?: string[];
}

/** Create a creator profile. UNIQUE(user_id) and UNIQUE(handle). */
export async function createCreator(
  _ctx: AppContext,
  userId: string,
  args: CreateCreatorArgs,
): Promise<CreatorProfile> {
  if (args.handle.length < HANDLE_MIN || args.handle.length > HANDLE_MAX) {
    throw new ValidationFailedError({ reason: `handle length ${HANDLE_MIN}..${HANDLE_MAX}` });
  }
  if (!HANDLE_REGEX.test(args.handle)) {
    throw new ValidationFailedError({
      reason: 'handle must be lowercase alphanumerics/underscore',
    });
  }
  const bio = args.bio ?? '';
  if (bio.length > BIO_MAX) {
    throw new ValidationFailedError({ reason: `bio length 0..${BIO_MAX}` });
  }
  const categories = args.categories ?? [];
  // 23505 covers both the user_id PK and the handle UNIQUE.
  await runInTransaction(async (client) => {
    try {
      await client.query(
        `INSERT INTO creator_profiles (user_id, handle, bio, categories)
         VALUES ($1, $2, $3, $4)`,
        [userId, args.handle, bio, categories],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictError({ resource: 'creator_profile' });
      }
      throw e;
    }
  });
  return {
    userId,
    handle: args.handle,
    bio,
    bannerImageKey: null,
    avatarImageKey: null,
    categories,
    createdAt: new Date().toISOString(),
  };
}

/** Public read by handle. */
export async function getCreatorByHandle(ctx: AppContext, handle: string): Promise<CreatorProfile> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      user_id: string;
      handle: string;
      bio: string;
      banner_image_key: string | null;
      avatar_image_key: string | null;
      categories: string[];
      created_at: Date;
    }>(
      `SELECT user_id, handle, bio, banner_image_key, avatar_image_key, categories, created_at
       FROM creator_profiles WHERE handle = $1`,
      [handle],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'creator_profile', handle });
  return {
    userId: row.user_id,
    handle: row.handle,
    bio: row.bio,
    bannerImageKey: row.banner_image_key,
    avatarImageKey: row.avatar_image_key,
    categories: row.categories,
    createdAt: row.created_at.toISOString(),
  };
}

/** PATCH /v1/creator — only the owner can update. */
export async function updateCreator(
  ctx: AppContext,
  userId: string,
  args: UpdateCreatorArgs,
): Promise<CreatorProfile> {
  if (args.bio !== undefined && args.bio.length > BIO_MAX) {
    throw new ValidationFailedError({ reason: `bio length 0..${BIO_MAX}` });
  }
  // Image keys must be uploads the caller owns; a key is later erased from
  // storage when the account is deleted, so a foreign key must never be accepted.
  for (const key of [args.bannerImageKey, args.avatarImageKey]) {
    if (typeof key !== 'string') continue;
    const owned = await ctx.db.withConnection((c) =>
      c.query('SELECT 1 FROM ad_uploads WHERE user_id = $1 AND image_key = $2', [userId, key]),
    );
    if (owned.rowCount === 0) {
      throw new ValidationFailedError({ reason: 'image_key_not_owned' });
    }
  }
  const set: string[] = [];
  const params: unknown[] = [];
  let p = 0;
  if (args.bio !== undefined) {
    p += 1;
    set.push(`bio = $${p}`);
    params.push(args.bio);
  }
  if (args.bannerImageKey !== undefined) {
    p += 1;
    set.push(`banner_image_key = $${p}`);
    params.push(args.bannerImageKey);
  }
  if (args.avatarImageKey !== undefined) {
    p += 1;
    set.push(`avatar_image_key = $${p}`);
    params.push(args.avatarImageKey);
  }
  if (args.categories !== undefined) {
    p += 1;
    set.push(`categories = $${p}`);
    params.push(args.categories);
  }
  if (set.length === 0) {
    return getCreatorByUserId(ctx, userId);
  }
  p += 1;
  params.push(userId);
  const sql = `UPDATE creator_profiles SET ${set.join(', ')} WHERE user_id = $${p}`;
  const r = await ctx.db.withConnection(async (c) => {
    return c.query(sql, params);
  });
  if (r.rowCount === 0) {
    throw new NotFoundError({ resource: 'creator_profile', userId });
  }
  return getCreatorByUserId(ctx, userId);
}

/**
 *
 */
export async function getCreatorByUserId(ctx: AppContext, userId: string): Promise<CreatorProfile> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<{
      user_id: string;
      handle: string;
      bio: string;
      banner_image_key: string | null;
      avatar_image_key: string | null;
      categories: string[];
      created_at: Date;
    }>(
      `SELECT user_id, handle, bio, banner_image_key, avatar_image_key, categories, created_at
       FROM creator_profiles WHERE user_id = $1`,
      [userId],
    );
  });
  const row = r.rows[0];
  if (!row) throw new NotFoundError({ resource: 'creator_profile', userId });
  return {
    userId: row.user_id,
    handle: row.handle,
    bio: row.bio,
    bannerImageKey: row.banner_image_key,
    avatarImageKey: row.avatar_image_key,
    categories: row.categories,
    createdAt: row.created_at.toISOString(),
  };
}

void uuidv7;

// --- Creator mode for paid calls (unlock C2) ----------------------------------

/** 0.25 USDC a minute, in base units (the API floor; the program only checks > 0). */
export const CREATOR_RATE_MIN = 250_000n;
/** 50 USDC a minute, in base units (the program's ceiling too). */
export const CREATOR_RATE_MAX = 50_000_000n;
/** The program refuses `max_minutes` above 60. */
export const CREATOR_MAX_MINUTES = 60;

/** What a profile card and `PUT /creator` show. Rates are USDC base-unit strings. */
export interface CreatorMode {
  readonly enabled: boolean;
  readonly ratePerMinUsdc: string;
  readonly maxMinutes: number;
}

/**
 * Turn creator mode on or off and set the rate. Creates the creator profile on the
 * first call (handle `c_<id>`, editable later with PATCH). The payout wallet is the
 * caller's own wallet, recorded now: paid calls pay the creator on chain there.
 *
 * @param ctx - The app context.
 * @param userId - The creator.
 * @param mode - `ratePerMinUsdc` 250000..50000000 base units, `maxMinutes` 1..60.
 * @throws ValidationFailedError `rate_out_of_range` or `max_minutes`.
 */
export async function putCreatorMode(
  ctx: AppContext,
  userId: string,
  mode: CreatorMode,
): Promise<CreatorMode> {
  if (!/^\d{1,12}$/.test(mode.ratePerMinUsdc)) {
    throw new ValidationFailedError({ reason: 'rate_out_of_range' });
  }
  const rate = BigInt(mode.ratePerMinUsdc);
  if (rate < CREATOR_RATE_MIN || rate > CREATOR_RATE_MAX) {
    throw new ValidationFailedError({
      reason: 'rate_out_of_range',
      min: CREATOR_RATE_MIN.toString(),
      max: CREATOR_RATE_MAX.toString(),
    });
  }
  if (
    !Number.isInteger(mode.maxMinutes) ||
    mode.maxMinutes < 1 ||
    mode.maxMinutes > CREATOR_MAX_MINUTES
  ) {
    throw new ValidationFailedError({ reason: 'max_minutes', min: 1, max: CREATOR_MAX_MINUTES });
  }
  return ctx.db.withConnection(async (c) => {
    const u = await c.query<{ wallet: string }>('SELECT wallet FROM users WHERE id = $1', [userId]);
    const wallet = u.rows[0]?.wallet;
    if (wallet === undefined) throw new NotFoundError({ kind: 'user', id: userId });
    const handle = `c_${userId.replace(/-/g, '').slice(0, 20)}`;
    const r = await c.query<{ enabled: boolean; rate_per_min_usdc: string; max_minutes: number }>(
      `INSERT INTO creator_profiles
         (user_id, handle, enabled, rate_per_min_usdc, max_minutes, payout_wallet, mode_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         rate_per_min_usdc = EXCLUDED.rate_per_min_usdc,
         max_minutes = EXCLUDED.max_minutes,
         payout_wallet = EXCLUDED.payout_wallet,
         mode_updated_at = now()
       RETURNING enabled, rate_per_min_usdc, max_minutes`,
      [userId, handle, mode.enabled, rate.toString(), mode.maxMinutes, wallet],
    );
    const row = r.rows[0]!;
    return {
      enabled: row.enabled,
      ratePerMinUsdc: String(row.rate_per_min_usdc),
      maxMinutes: Number(row.max_minutes),
    };
  });
}

/** A creator's paid-call terms as the paid-call service needs them. */
export interface CreatorTerms extends CreatorMode {
  readonly payoutWallet: string;
}

/**
 * @param ctx - The app context.
 * @param userId - The creator.
 * @returns Their terms, or null when they never set a rate.
 */
export async function creatorTerms(ctx: AppContext, userId: string): Promise<CreatorTerms | null> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{
      enabled: boolean;
      rate_per_min_usdc: string | null;
      max_minutes: number | null;
      payout_wallet: string | null;
    }>(
      `SELECT enabled, rate_per_min_usdc, max_minutes, payout_wallet
         FROM creator_profiles WHERE user_id = $1`,
      [userId],
    ),
  );
  const row = r.rows[0];
  if (!row || row.rate_per_min_usdc === null || row.max_minutes === null || !row.payout_wallet) {
    return null;
  }
  return {
    enabled: row.enabled,
    ratePerMinUsdc: String(row.rate_per_min_usdc),
    maxMinutes: Number(row.max_minutes),
    payoutWallet: row.payout_wallet,
  };
}

/**
 * The `creator` field of `GET /users/:id`: the terms while `creatorMode` is on and the
 * user set a rate, otherwise null. Never exposes the payout wallet.
 *
 * @param ctx - The app context.
 * @param userId - The profile's user.
 */
export async function creatorCard(ctx: AppContext, userId: string): Promise<CreatorMode | null> {
  if (!isCapabilityOn(ctx, 'creatorMode')) return null;
  const t = await creatorTerms(ctx, userId);
  return t === null
    ? null
    : { enabled: t.enabled, ratePerMinUsdc: t.ratePerMinUsdc, maxMinutes: t.maxMinutes };
}
