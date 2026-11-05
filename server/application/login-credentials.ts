/** Durable login-credential state. Payment-wallet links are never credentials. */
import type { PoolClient } from 'pg';
import type { Db } from '../shared/db/pool.js';
import type { AccessClaims } from '../shared/auth/jwt.js';
import type { Config } from '../shared/config/config.js';
import { WalletLinkError } from './wallet-links-proofs.js';

export const LOGIN_IDENTITY_REVOKED_CHANNEL = 'ctl:login-identity-revoked';
export interface LoginCredential {
  userId: string;
  identityId: string;
  version: number;
}
export interface LoginIdentityRevokedEvent {
  userId: string;
  identityId: string;
  minVersion: number;
}
export type CredentialClaims = Pick<AccessClaims, 'sub' | 'lid' | 'liv' | 'am' | 'auth_time'> & {
  wal?: string | null;
};

/** Stable authentication failure; never disclose another player's credential. */
export function credentialRevoked(): WalletLinkError {
  return new WalletLinkError(
    'AUTH_IDENTITY_REVOKED',
    'This sign-in session is no longer active. Sign in again.',
    401,
  );
}

/** Transient authority failure; clients retain credentials and may retry. */
export function authStateUnavailable(): WalletLinkError {
  return new WalletLinkError(
    'AUTH_STATE_UNAVAILABLE',
    'Account access could not be checked. Try again shortly.',
    503,
  );
}

/** Ten minutes is CT Life policy. Refresh never advances the original auth time. */
export function assertRecentAuthentication(config: Config, claims: CredentialClaims): void {
  const time = claims.auth_time,
    now = Math.floor(Date.now() / 1000);
  if (
    time === undefined ||
    !Number.isSafeInteger(time) ||
    time <= 0 ||
    time > now + 30 ||
    now - time > 600 ||
    (claims.am === 'dev' &&
      !(config.auth.devAuthEnabled && ['local', 'mock'].includes(config.appEnv)))
  )
    throw new WalletLinkError(
      'AUTH_REAUTH_REQUIRED',
      'Sign in again before changing login wallets.',
      403,
    );
}

/** Caller may already hold the user lock; this function never changes lock order. */
export async function resolveLoginCredentialOn(
  client: Pick<PoolClient, 'query'>,
  claims: CredentialClaims,
): Promise<LoginCredential> {
  const version = claims.liv ?? 0;
  if (!Number.isSafeInteger(version) || version < 0 || version > 2147483647)
    throw credentialRevoked();
  const method = claims.am ?? 'siws';
  if (method !== 'wallet' && 'wal' in claims && claims.wal === null) throw credentialRevoked();
  if (!['wallet', 'siws', 'dev'].includes(method) || (method === 'wallet' && !claims.lid))
    throw credentialRevoked();
  const result = await client.query<{ id: string; session_version: number }>(
    `SELECT i.id,i.session_version FROM users u JOIN login_identities i ON i.user_id=u.id
     WHERE u.id=$1 AND u.deleted_at IS NULL AND i.revoked_at IS NULL AND i.session_version=$3
       AND (($2::uuid IS NOT NULL AND i.id=$2) OR ($2::uuid IS NULL AND i.network='solana:mainnet' AND i.address=u.wallet))
       AND (($4='wallet' AND i.network IN ('eip155:4663','near:mainnet')) OR
         ($4 IN ('siws','dev') AND i.network='solana:mainnet' AND i.address=u.wallet AND ($5::text IS NULL OR u.wallet=$5)))`,
    [claims.sub, claims.lid ?? null, version, method, claims.wal ?? null],
  );
  const row = result.rows[0];
  if (!row) throw credentialRevoked();
  return { userId: claims.sub, identityId: row.id, version: row.session_version };
}

/** Resolve an authenticated token's exact generation; missing liv means zero only. */
export async function resolveLoginCredential(
  db: Db,
  claims: CredentialClaims,
): Promise<LoginCredential> {
  return db.withConnection((client) => resolveLoginCredentialOn(client, claims));
}

/** Batch at most 128 distinct scopes per query; DB failures propagate, never authorize. */
export async function invalidLoginCredentials(
  db: Db,
  credentials: readonly LoginCredential[],
): Promise<LoginCredential[]> {
  const unique = [
    ...new Map(credentials.map((c) => [`${c.userId}:${c.identityId}:${c.version}`, c])).values(),
  ];
  const invalid: LoginCredential[] = [];
  for (let start = 0; start < unique.length; start += 128) {
    const chunk = unique.slice(start, start + 128);
    const validShape = chunk.filter(
      (c) => Number.isSafeInteger(c.version) && c.version >= 0 && c.version <= 2147483647,
    );
    invalid.push(...chunk.filter((c) => !validShape.includes(c)));
    if (!validShape.length) continue;
    const found = await db.withConnection((client) =>
      client.query<{ user_id: string; id: string; session_version: number }>(
        `SELECT i.user_id,i.id,i.session_version FROM unnest($1::uuid[],$2::uuid[],$3::integer[]) AS expected(user_id,id,version)
       JOIN login_identities i ON i.user_id=expected.user_id AND i.id=expected.id AND i.session_version=expected.version
       JOIN users u ON u.id=i.user_id WHERE u.deleted_at IS NULL AND i.revoked_at IS NULL
       AND (i.network<>'solana:mainnet' OR i.address=u.wallet)`,
        [
          validShape.map((c) => c.userId),
          validShape.map((c) => c.identityId),
          validShape.map((c) => c.version),
        ],
      ),
    );
    const active = new Set(found.rows.map((r) => `${r.user_id}:${r.id}:${r.session_version}`));
    invalid.push(
      ...validShape.filter((c) => !active.has(`${c.userId}:${c.identityId}:${c.version}`)),
    );
  }
  return invalid;
}

/** Final durable check for a previously resolved room/session credential. */
export async function assertLoginCredential(db: Db, credential: LoginCredential): Promise<void> {
  if ((await invalidLoginCredentials(db, [credential])).length) throw credentialRevoked();
}
