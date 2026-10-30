/**
 * Verified X link (M7 #9).
 *
 * OAuth 2.0 PKCE per the master prompt's deviations:
 * "Implement OAuth 2.0 PKCE per spec. It stores only handle
 * and avatar. If X_CLIENT_ID is absent, the feature flag
 * stays off and this is logged in UNVERIFIED.md."
 *
 * Endpoints:
 *
 *   GET  /v1/x/link/start    — generate the PKCE pair + the
 *                              authorization URL. The pair is
 *                              persisted in x_links; the auth
 *                              URL is returned to the client.
 *   GET  /v1/x/link/callback — receive the OAuth redirect with
 *                              code + state; exchange the code
 *                              for an access token, fetch the
 *                              X user info, persist handle +
 *                              avatar + token hash.
 *
 * The feature is gated by `X_LINK_ENABLED` (server config).
 * When off, the routes return 503 (LLM_DISABLED-style).
 *
 * The X OAuth 2.0 PKCE flow is:
 *
 *   1. Client generates code_verifier (43-128 char URL-safe
 *      base64) and code_challenge = base64url(sha256(verifier)).
 *   2. Client redirects to https://x.com/i/oauth2/authorize
 *      with response_type=code, client_id, redirect_uri,
 *      scope=tweet.read users.read, state, code_challenge,
 *      code_challenge_method=S256.
 *   3. User authorizes. X redirects to redirect_uri?code=...&state=...
 *   4. Client exchanges the code at
 *      https://api.x.com/2/oauth2/token with grant_type=authorization_code,
 *      code, redirect_uri, client_id, code_verifier.
 *   5. Client calls https://api.x.com/2/users/me with the access
 *      token to get the user id + handle + avatar.
 *
 * The X HTTP client (server/shared/x/client.ts) wraps the token
 * exchange + users/me call. Tests inject a stub client.
 */
import { createHash, randomBytes } from 'node:crypto';
import { runInTransaction } from '../shared/db/uow.js';
import { NotFoundError, ValidationFailedError } from '../shared/domain/errors.js';
import { uuidv7 } from '../shared/domain/uuid.js';
import type { AppContext } from './context.js';
import { publishToUser } from './realtime-bus.js';

const PKCE_VERIFIER_BYTES = 32; // 43-char base64url
const STATE_BYTES = 24; // 32-char base64url

export interface XLinkRow {
  readonly userId: string;
  readonly xUserId: string;
  readonly xHandle: string;
  readonly xAvatarUrl: string;
  readonly verifiedAt: string | null;
}

export interface XStartResult {
  readonly authorizationUrl: string;
  readonly state: string;
}

export interface XClient {
  exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<{
    accessToken: string;
    refreshToken: string;
  }>;
  fetchMe(accessToken: string): Promise<{
    xUserId: string;
    xHandle: string;
    xAvatarUrl: string;
  }>;
}

interface XLinkDbRow {
  user_id: string;
  x_user_id: string;
  x_handle: string;
  x_avatar_url: string;
  code_verifier: string;
  state: string;
  access_token_hash: string;
  refresh_token_hash: string;
  verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString('base64url');
  const challenge = sha256(verifier);
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}

/**
 * Start the OAuth flow. Persists the code_verifier + state in
 * x_links (one row per user, the row is upserted on each
 * start), and returns the authorization URL the client should
 * redirect to.
 */
export async function startXLink(
  ctx: AppContext,
  userId: string,
  now: Date = new Date(),
): Promise<XStartResult> {
  const { verifier, challenge } = generatePkcePair();
  const state = generateState();
  const cfg = ctx.config.xLink;
  const authorizationUrl =
    `${cfg.authorizeUrl}` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(cfg.clientId)}` +
    `&redirect_uri=${encodeURIComponent(cfg.redirectUri)}` +
    `&scope=${encodeURIComponent('tweet.read users.read')}` +
    `&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256`;
  // The x_links row carries an in-flight code_verifier + state
  // (verified_at NULL). On successful callback, the row is
  // promoted to verified and the verifier is overwritten.
  await runInTransaction(async (client) => {
    await client.query(
      `INSERT INTO x_links
         (user_id, x_user_id, x_handle, x_avatar_url, code_verifier, state,
          access_token_hash, refresh_token_hash, verified_at, created_at, updated_at)
       VALUES ($1, '0', '_pending', '', $2, $3, '', '', NULL, $4, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET code_verifier = EXCLUDED.code_verifier,
             state = EXCLUDED.state,
             verified_at = NULL,
             updated_at = EXCLUDED.updated_at`,
      [userId, verifier, state, now.toISOString()],
    );
  });
  return { authorizationUrl, state };
}

/**
 * Complete the OAuth flow. The client passes the code + state
 * from the redirect. The application verifies the state
 * matches the in-flight row, exchanges the code for an access
 * token via the XClient, fetches the user info, and persists
 * the handle + avatar + token hash.
 */
export async function completeXLink(
  ctx: AppContext,
  userId: string,
  code: string,
  state: string,
  client: XClient,
  now: Date = new Date(),
): Promise<XLinkRow> {
  if (code.length === 0 || code.length > 1024) {
    throw new ValidationFailedError({ reason: 'code length 1..1024' });
  }
  if (state.length === 0 || state.length > 64) {
    throw new ValidationFailedError({ reason: 'state length 1..64' });
  }
  return runInTransaction(async (dbClient) => {
    const r = await dbClient.query<XLinkDbRow>(
      `SELECT user_id, x_user_id, x_handle, x_avatar_url, code_verifier, state,
              access_token_hash, refresh_token_hash, verified_at, created_at, updated_at
       FROM x_links WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const row = r.rows[0];
    if (!row) throw new NotFoundError({ kind: 'x_link', userId });
    if (row.state !== state) {
      throw new ValidationFailedError({ reason: 'state mismatch' });
    }
    if (row.verified_at !== null) {
      throw new ValidationFailedError({ reason: 'link already verified' });
    }
    const tokens = await client.exchangeCode({
      code,
      codeVerifier: row.code_verifier,
      redirectUri: ctx.config.xLink.redirectUri,
    });
    const me = await client.fetchMe(tokens.accessToken);
    const upd = await dbClient.query<XLinkDbRow>(
      `UPDATE x_links SET x_user_id = $1, x_handle = $2, x_avatar_url = $3,
                          access_token_hash = $4, refresh_token_hash = $5,
                          verified_at = $6, updated_at = $6
       WHERE user_id = $7
       RETURNING user_id, x_user_id, x_handle, x_avatar_url, code_verifier, state,
                 access_token_hash, refresh_token_hash, verified_at, created_at, updated_at`,
      [
        me.xUserId,
        me.xHandle,
        me.xAvatarUrl,
        hashToken(tokens.accessToken),
        hashToken(tokens.refreshToken),
        now.toISOString(),
        userId,
      ],
    );
    return rowToLink(upd.rows[0]!);
  });
}

/** Read the caller's X link (or null). */
export async function getXLink(ctx: AppContext, userId: string): Promise<XLinkRow | null> {
  const r = await ctx.db.withConnection(async (c) => {
    return c.query<XLinkDbRow>(
      `SELECT user_id, x_user_id, x_handle, x_avatar_url, code_verifier, state,
              access_token_hash, refresh_token_hash, verified_at, created_at, updated_at
       FROM x_links WHERE user_id = $1 AND verified_at IS NOT NULL`,
      [userId],
    );
  });
  const row = r.rows[0];
  if (!row) return null;
  return rowToLink(row);
}

/**
 * Unlink the caller's verified X account (`DELETE /v1/x/link`): the row goes,
 * with the handle, avatar and both token hashes, and any in-flight OAuth start
 * with it. X's developer policy asks apps to delete a user's X data on request
 * (within 24 h); this deletes it immediately. The client is told with the
 * user message `x_link_update {linked: false}`.
 * @param ctx - The application context.
 * @param userId - The caller.
 * @returns Nothing; `404 NOT_FOUND` when no verified link exists (an in-flight
 *   start is still cleared).
 */
export async function unlinkXLink(ctx: AppContext, userId: string): Promise<void> {
  const r = await ctx.db.withConnection((c) =>
    c.query<{ verified_at: Date | null }>(
      `DELETE FROM x_links WHERE user_id = $1 RETURNING verified_at`,
      [userId],
    ),
  );
  if (!r.rows.some((row) => row.verified_at !== null)) {
    throw new NotFoundError({ kind: 'x_link' });
  }
  await publishToUser(ctx, userId, 'x_link_update', { linked: false, at: Date.now() });
}

function rowToLink(r: XLinkDbRow): XLinkRow {
  return {
    userId: r.user_id,
    xUserId: r.x_user_id,
    xHandle: r.x_handle,
    xAvatarUrl: r.x_avatar_url,
    verifiedAt: r.verified_at ? r.verified_at.toISOString() : null,
  };
}

void uuidv7;
