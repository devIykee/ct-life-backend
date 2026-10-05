/**
 * Creator profile service.
 *
 * Endpoints:
 *
 *   POST  /v1/creator            — create a creator profile (one per user)
 *   GET   /v1/creator/:handle   — public read by handle
 *   PATCH /v1/creator            — update bio, banner, avatar, categories
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
